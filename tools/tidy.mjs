#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：① "权重 + 门槛"清理评分（年龄分 + 体积分合计过线才候选）
 * ② "事实键去重，同一件事只留最新" 两条机制借鉴自 dsh-fish-memory
 * （MIT, https://github.com/Yuuyuko-uu/dsh-fish-memory）。无代码复制：
 * 对方是带半衰期的记忆插件，本文件是文件清理器，评分对象与公式均不同。
 * 详见 THIRD-PARTY-NOTICES.md §4.1 / docs/ATTRIBUTION.md
 */
/**
 * tidy.mjs —— 过期文件清理（给{{BOT_NAME}}自己调用的稳定工具）
 *
 * 早期 v2：加了两个借鉴自 fish-memory 的东西
 *   ① 权重 + 门槛：不再只看"多少天"，而是 score = 年龄分 + 体积分
 *      年龄分 = 天数 / 阈值（满 1 分就够老）
 *      体积分 = 大小MB / 100（大文件更快够格）
 *      合计 >= 1.3 才算候选 —— 所以「2 天前的 300MB 视频」会先被清，
 *      「20 天前的 900KB 小图」可以再留一会儿
 *   ② 事实键去重：同一 BV 号下载的 mp4 只留最新一份（和记忆里"同一件事只留最新"同理）
 *
 * 清什么：shots（抽帧/下载的视频/截图）、attachments（他发的）、media\onebot（中转图）
 * 绝不清：memory、sessions、案件、任何 .md / 配置 / 脚本
 *
 * 用法：
 *   node tidy.mjs                      预演（默认，不删）
 *   node tidy.mjs --go                 真删
 *   node tidy.mjs --days 30 --go       改阈值
 *   node tidy.mjs --strict-age --go    纯按天数（关掉权重与去重）
 *   node tidy.mjs --scan-refs --go     额外扫会话引用，被引用过的不删（慢，建议每周一次）
 *   node tidy.mjs --keep "生日"         文件名含关键词的不删
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { WORKSPACE, DSH_HOME, COMFY_ROOT } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const DATA_ROOT = process.env.AGENT_DATA || path.join(WORKSPACE, 'dsh-data')

const argv = process.argv.slice(2)
const GO = argv.includes('--go')
const STRICT = argv.includes('--strict-age')
const SCAN_REFS = argv.includes('--scan-refs')
const num = (flag, dflt) => {
  const i = argv.indexOf(flag)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) && v > 0 ? v : dflt
}
const DAYS = num('--days', 15)
const onlyIdx = argv.indexOf('--only')
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '') : ''
const keepIdx = argv.indexOf('--keep')
const KEEP_WORD = keepIdx >= 0 ? String(argv[keepIdx + 1] || '') : ''

// --bg：把清理丢到后台进程去跑，立刻返回一行 —— 她不需要读整份报告（省上下文）
if (argv.includes('--bg')) {
  const { spawn } = await import('node:child_process')
  const args = argv.filter((a) => a !== '--bg')
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, ''), ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  console.log('已在后台开始清理（不占上下文）。报告稍后写到 ' + path.join(DATA_ROOT, 'reports') + ' 下，需要时再看。')
  process.exit(0)
}

const SCORE_GATE = 1.3
const ROOTS = [
  { id: 'shots', dir: path.join(DSH, 'shots'), label: '截图与下载的视频', dedupeBV: true },
  { id: 'attachments', dir: path.join(DSH, 'attachments'), label: '他发来的文件', dedupeBV: false },
  { id: 'media', dir: path.join(DSH, 'media', 'onebot'), label: '发消息时的中转图片', dedupeBV: false },
]

const now = Date.now()
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB'

// ── 会话引用表（可选，很慢：要解压全部会话）──
let refBlob = ''
if (SCAN_REFS) {
  const base = path.join(DSH, 'sessions')
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const chunks = []
  const walkProj = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walkProj(p); continue }
      if (!e.name.endsWith('.jsonl.zstd')) continue
      try {
        const buf = fs.readFileSync(p)
        const idx = []
        for (let i = 0; (i = buf.indexOf(magic, i)) !== -1; i += 4) idx.push(i)
        for (let k = 0; k < idx.length; k++) {
          const end = k + 1 < idx.length ? idx[k + 1] : buf.length
          try { chunks.push(zlib.zstdDecompressSync(buf.subarray(idx[k], end))) } catch {}
        }
      } catch {}
    }
  }
  walkProj(base)
  refBlob = Buffer.concat(chunks).toString('utf8')
  console.log('（已扫描引用：' + (refBlob.length / 1048576).toFixed(0) + ' MB 会话文本）')
}

const buckets = []
let scanned = 0, kept = 0

for (const root of ROOTS) {
  if (ONLY && ONLY !== root.id) continue
  if (!fs.existsSync(root.dir)) continue
  const files = []
  const walk = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      let st
      try { st = fs.statSync(p) } catch { continue }
      scanned += 1
      files.push({ p, name: e.name, size: st.size, ageDays: (now - st.mtimeMs) / 864e5 })
    }
  }
  walk(root.dir)
  if (!files.length) continue

  // ① BV 去重：同一 BV 只留最新一份
  // ① BV 去重：**只针对下载的视频/音频本体**（同一个 BV 的封面、字幕、抽帧、debrief 不算重复，
  //    那些是分析产物，很小，删了要重做一遍才知道）。
  const killed = new Set()
  if (root.dedupeBV && !STRICT) {
    const MEDIA = /\.(mp4|flv|m4a|mkv|webm)$/i
    const byBV = new Map()
    for (const f of files) {
      if (!MEDIA.test(f.name)) continue
      const m = f.name.match(/^(BV[0-9A-Za-z]+)/)
      if (!m) continue
      const k = m[1] + path.extname(f.name).toLowerCase()
      const prev = byBV.get(k)
      if (!prev || f.ageDays < prev.ageDays) byBV.set(k, f)
    }
    for (const f of files) {
      if (!MEDIA.test(f.name)) continue
      const m = f.name.match(/^(BV[0-9A-Za-z]+)/)
      if (!m) continue
      const winner = byBV.get(m[1] + path.extname(f.name).toLowerCase())
      if (winner && winner.p !== f.p && f.ageDays > 0.5) { killed.add(f.p); f.reason = '同一 BV 的重复下载（只留最新）' }
    }
  }

  const cands = []
  for (const f of files) {
    if (KEEP_WORD && f.name.includes(KEEP_WORD)) { kept += 1; continue }
    if (SCAN_REFS && refBlob && refBlob.includes(f.name)) { kept += 1; continue }
    if (killed.has(f.p)) { cands.push(f); continue }
    if (STRICT) { if (f.ageDays >= DAYS) { f.reason = `${Math.round(f.ageDays)} 天（纯按天数）`; cands.push(f) } continue }
    const ageScore = f.ageDays / DAYS
    const sizeScore = (f.size / 1048576) / 100
    const score = ageScore + sizeScore
    // 两条路都算达标：① 到了 15 天（使用者的原话）② 体积大，提前清（借鉴权重模型）
    if (f.ageDays >= DAYS || score >= SCORE_GATE) {
      f.score = score
      f.reason = `${Math.round(f.ageDays)} 天 · ${fmtMB(f.size)} · 分 ${score.toFixed(2)}`
      cands.push(f)
    }
  }
  if (!cands.length) continue

  let freed = 0
  if (GO) {
    for (const f of cands) {
      const prefix = path.resolve(root.dir) + path.sep
      if (!path.resolve(f.p).startsWith(prefix)) continue
      try { fs.unlinkSync(f.p); freed += f.size } catch {}
    }
  }
  buckets.push({ root, cands, bytes: cands.reduce((a, b) => a + b.size, 0), freed })
}

// ── 生图一天一清：images 超过 N 小时删除（--img-hours 可调）──────────
// 规则：{{WORKSPACE}}/dsh-data\images 里超过 IMG_HOURS（默认 24 小时）的文件删掉；
//       今天生、还在用的不动；档案目录一律不动。
const IMG_HOURS = (() => { const i = argv.indexOf('--img-hours'); const v = i >= 0 ? Number(argv[i + 1]) : NaN; return Number.isFinite(v) && v > 0 ? v : 24 })()
const IMG_DIRS = [
  path.join(WORKSPACE, 'dsh-data', 'images'),                                            // GPT / 4router 出的
  path.join(COMFY_ROOT, 'ComfyUI', 'output'),      // 本地 ComfyUI 出的
]
const PROTECT = [path.join(DSH_HOME, 'memory', '形象')]

function imgSweep(log) {
  const cut = Date.now() - IMG_HOURS * 3600_000
  let freed = 0
  let n = 0
  for (const dir of IMG_DIRS) {
    let files = []
    try { files = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const f of files) {
      if (!f.isFile()) continue
      if (!/\.(png|jpe?g|webp|gif)$/i.test(f.name)) continue
      const p = path.join(dir, f.name)
      if (PROTECT.some((x) => p.startsWith(x))) continue
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.mtimeMs >= cut) continue
      freed += st.size
      n += 1
      if (GO) { try { fs.unlinkSync(p) } catch {} }
    }
  }
  if (n) log.push(`生图清理：${n} 张 / ${(freed / 1048576).toFixed(1)} MB（阈值 ${IMG_HOURS} 小时）`)
  else log.push(`生图清理：没有超过 ${IMG_HOURS} 小时的图`)
  return { n, freed }
}

// ── 抽帧清理：shots 里的视频/截图超过 SHOTS_DAYS（默认 5 天）就删 ──
// （可自定义）5 天。视频可以重下，留在盘上只是占地方。
// memory\ 里的档案不在此列（那边一条 md 都没引用 shots）。
const SHOTS_DAYS = (() => { const i = argv.indexOf('--shots-days'); const v = i >= 0 ? Number(argv[i + 1]) : NaN; return Number.isFinite(v) && v > 0 ? v : 5 })()
const SHOTS_DIR = process.env.AGENT_SHOTS_OUT || path.join(WORKSPACE, 'dsh-data', 'shots')

function shotsSweep(log) {
  const cut = Date.now() - SHOTS_DAYS * 86400_000
  let freed = 0
  let n = 0
  const byDir = {}
  const walk = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.mtimeMs >= cut) continue
      freed += st.size
      n += 1
      const k = path.basename(dir)
      byDir[k] = (byDir[k] ?? 0) + st.size
      if (GO) { try { fs.unlinkSync(p) } catch {} }
    }
  }
  walk(SHOTS_DIR)
  const detail = Object.entries(byDir).map(([k, v]) => k + ' ' + (v / 1048576).toFixed(1) + ' MB').join(' / ')
  if (n) log.push(`抽帧清理：${n} 个 / ${(freed / 1048576).toFixed(1)} MB（阈值 ${SHOTS_DAYS} 天）${detail ? '　' + detail : ''}`)
  else log.push(`抽帧清理：没有超过 ${SHOTS_DAYS} 天的文件`)
  return { n, freed }
}
// ── 报告 ──
const lines = []
lines.push(`# 清理${GO ? '执行' : '预演'}报告 ${new Date().toLocaleString('zh-CN')}`)
lines.push('')
lines.push(`- 模式：${STRICT ? '纯按天数' : '权重+门槛(≥' + SCORE_GATE + ') + BV 去重'}${SCAN_REFS ? ' + 引用保护' : ''}`)
lines.push(`- 阈值：${DAYS} 天`)
lines.push(`- 扫描：${scanned} 个文件${kept ? '，跳过 ' + kept + ' 个（关键词/被引用）' : ''}`)
const totalC = buckets.reduce((a, b) => a + b.cands.length, 0)
const totalB = buckets.reduce((a, b) => a + b.bytes, 0)
lines.push(`- 候选：${totalC} 个 / ${fmtMB(totalB)}${GO ? '，实际删除 ' + fmtMB(buckets.reduce((a, b) => a + b.freed, 0)) : ''}`)
lines.push('')
for (const b of buckets) {
  lines.push(`## ${b.root.label}（${b.root.id}）— ${b.cands.length} 个 / ${fmtMB(b.bytes)}`)
  for (const f of b.cands.sort((x, y) => y.size - x.size).slice(0, 10)) {
    lines.push(`- ${f.name}  ${fmtMB(f.size)}  ← ${f.reason || ''}`)
  }
  if (b.cands.length > 10) lines.push(`- …还有 ${b.cands.length - 10} 个`)
  lines.push('')
}
if (!buckets.length) lines.push('（没有符合条件的文件）')

imgSweep(lines)
shotsSweep(lines)

const text = lines.join('\n')
try {
  const repDir = path.join(DATA_ROOT, 'reports')
  fs.mkdirSync(repDir, { recursive: true })
  const d = new Date()
  const name = `tidy-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
  fs.writeFileSync(path.join(repDir, name), text, 'utf8')
} catch {}

console.log(text)
console.log(GO ? '\n✓ 已执行' : '\n（预演模式，没删任何东西；加 --go 才真删）')
