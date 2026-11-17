#!/usr/bin/env node
/**
 * prune-heartbeat.mjs —— 心跳的“留有用的，然后彻底删掉旧痕迹”
 *
 * （可自定义）
 *   · 心跳的设定和内容不改
 *   · 记录只留简短有用的
 *   · 超过 5 天的心跳会话/痕迹 → 先把有用的抠出来，再彻底删除
 *
 * 处理三类东西（**永远不碰主聊天会话**）：
 *   ① ~/.dsh/qq-heartbeat.log          心跳操作日志（滚 5 天）
 *   ② {{WORKSPACE}}/dsh-data\sessions\**\session-* 临时会话（≤5 KB 那种，非主聊天），5 天前删
 *   ③ ~/.dsh/agent-core/*.log           心跳/任务日志，5 天前删
 *
 * 删除前：从这批内容里挑“有用的”（含 决定/约定/教训/方向/答应 等关键词的行），
 *         压成 ≤3 行、每行 ≤60 字，追加进 JOURNAL.md，标「（心跳箱）」；已存在的不重复写。
 *
 * 用法：
 *   node prune-heartbeat.mjs            # 预演，只打印会做什么
 *   node prune-heartbeat.mjs --go       # 真干（先备份再删）
 *   node prune-heartbeat.mjs --days 5   # 改阈值
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const MEM = path.join(DSH, 'memory')
const BACKUP = path.join(WORKSPACE, 'backup', 'prune-heartbeat')
const GO = process.argv.includes('--go')
const daysArg = process.argv.indexOf('--days')
const DAYS = daysArg > 0 ? Number(process.argv[daysArg + 1]) || 5 : 5
const CUTOFF = Date.now() - DAYS * 86400000

const say = (s) => console.log((GO ? '' : '[预演] ') + s)
const isOld = (p) => { try { return fs.statSync(p).mtimeMs < CUTOFF } catch { return false } }

// 有用的判据：出现这些词的行，才值得从旧痕迹里捞出来
const USEFUL = /决定|约定|答应|教训|方向|分流|推免|保研|体检|生病|难过|生气|边界|不许再|以后都|记住|别再|结论/

const picked = new Map() // key: 归一化文本 → 行
function harvest(lines, tag) {
  for (const raw of lines) {
    const l = String(raw).trim()
    if (!l || l.length < 6) continue
    if (/^\[20\d\d[/-]/.test(l) === false && !/决定|约定|教训|方向/.test(l)) continue
    if (!USEFUL.test(l)) continue
    // 去掉日志时间戳前缀
    const body = l.replace(/^\[[^\]]+\]\s*/, '').trim()
    if (body.length < 6) continue
    const short = body.slice(0, 60)
    const key = short.slice(0, 20)
    if (!picked.has(key)) picked.set(key, short)
    if (picked.size >= 3) return
  }
}

const toDelete = []

// ① 心跳日志：只保留最近 5 天
const hbLog = path.join(DSH, 'qq-heartbeat.log')
if (fs.existsSync(hbLog)) {
  const all = fs.readFileSync(hbLog, 'utf8').split('\n')
  const keep = []
  const old = []
  for (const line of all) {
    const m = line.match(/^\[(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (m) {
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (t < CUTOFF) old.push(line)
      else keep.push(line)
    } else keep.push(line)
  }
  if (old.length) {
    harvest(old, 'hb-log')
    say(`qq-heartbeat.log：${old.length} 行超过 ${DAYS} 天 → 提取后重写（保留 ${keep.length} 行）`)
    toDelete.push({ kind: 'rewrite', file: hbLog, keep })
  } else say(`qq-heartbeat.log：没有超过 ${DAYS} 天的行`)
}

// ② 临时会话目录（session-*，且很小；主聊天 onebot-* 永不碰）
// ：.dsh\sessions 是指向 {{WORKSPACE}}/dsh-data\sessions 的链接，
//   两个根一起扫会对同一个目录处理两次（第二次 ENOENT）。先去重成真实路径。
const sessRoots = [...new Set(
  [path.join(DSH, 'sessions'), path.join(WORKSPACE, 'dsh-data', 'sessions')]
    .filter((p) => fs.existsSync(p))
    .map((p) => { try { return fs.realpathSync(p) } catch { return p } }),
)]
for (const root of sessRoots) {
  if (!fs.existsSync(root)) continue
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(root, ws.name)
    let ents = []
    try { ents = fs.readdirSync(wsDir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (!/^session-/.test(e.name)) continue           // 只碰 session-*，onebot-*/bili-whale 一律不动
      const p = path.join(wsDir, e.name)
      const files = (() => { try { return fs.readdirSync(p) } catch { return [] } })()
      const size = files.reduce((n, f) => { try { return n + fs.statSync(path.join(p, f)).size } catch { return n } }, 0)
      if (size > 5 * 1024) continue                      // 大的可能是真对话，不碰
      if (!isOld(p)) continue
      toDelete.push({ kind: 'dir', file: p, size })
    }
  }
}

// ③ agent-core 下的日志
const coreLog = path.join(DSH, 'agent-core')
if (fs.existsSync(coreLog)) {
  for (const f of fs.readdirSync(coreLog)) {
    if (!/\.log$/.test(f)) continue
    const p = path.join(coreLog, f)
    if (!isOld(p)) continue
    const lines = (() => { try { return fs.readFileSync(p, 'utf8').split('\n') } catch { return [] } })()
    harvest(lines, 'core-log')
    toDelete.push({ kind: 'file', file: p })
  }
}

// ④ JOURNAL 里的「心跳」条目：5 天前的压成一句摘要，原文进月度归档（不硬删记忆）
//    ——— 使用者要求：心跳记录要简短；旧的先记好有用的，再清掉
let journalPlan = null
{
  const j = path.join(MEM, 'JOURNAL.md')
  if (fs.existsSync(j)) {
    const lines = fs.readFileSync(j, 'utf8').split('\n')
    const oldHb = []
    const keepLines = []
    for (const line of lines) {
      const m = line.match(/^\s*-\s*(\d{4})-(\d{2})-(\d{2})/)
      const isHb = /心跳/.test(line)
      if (m && isHb) {
        const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
        if (ts < CUTOFF) { oldHb.push(line.trim()); continue }
      }
      keepLines.push(line)
    }
    if (oldHb.length) {
      // 不做"自动抽话"（实测只会抽出半句）。改成：
      //   热文件里留一行指针，原文整条落进月度归档 —— 有用的没丢，热文件变干净。
      const pad2 = (n) => String(n).padStart(2, '0')
      const dd = new Date()
      const brief = '旧心跳 ' + oldHb.length + ' 条已归档：JOURNAL\\归档-' + dd.getFullYear() + '-' + pad2(dd.getMonth() + 1) + '.md'
      journalPlan = { file: j, keepLines, oldHb, brief }
      say('JOURNAL：' + oldHb.length + ' 条旧心跳 → 压缩成 1 句，原文进月度归档')
      say('  摘要：' + brief)
    } else say('JOURNAL：没有超过 ' + DAYS + ' 天的心跳条目')
  }
}

// ── 落地 ────────────────────────────────────────────
if (picked.size) {
  say('从旧痕迹里挑出 ' + picked.size + ' 条有用的话：')
  for (const s of picked.values()) say('  · ' + s)
} else {
  say('旧痕迹里没有需要留的（没有命中判据的行）')
}

for (const item of toDelete) {
  if (item.kind === 'rewrite') say('重写: ' + item.file + '（保留 ' + item.keep.length + ' 行）')
  else say('删除: ' + item.file + (item.size ? '（' + Math.round(item.size / 1024) + ' KB）' : ''))
}

if (!GO) { console.log('\n（预演完，加 --go 才真动）'); process.exit(0) }

fs.mkdirSync(BACKUP, { recursive: true })

// 备份 + 执行
for (const item of toDelete) {
  try {
    if (item.kind === 'rewrite') {
      fs.copyFileSync(item.file, path.join(BACKUP, path.basename(item.file) + '.' + Date.now()))
      fs.writeFileSync(item.file, item.keep.join('\n'), 'utf8')
    } else if (item.kind === 'dir') {
      fs.cpSync(item.file, path.join(BACKUP, path.basename(item.file) + '.' + Date.now()), { recursive: true })
      fs.rmSync(item.file, { recursive: true, force: true })
    } else {
      fs.copyFileSync(item.file, path.join(BACKUP, path.basename(item.file) + '.' + Date.now()))
      fs.rmSync(item.file, { force: true })
    }
  } catch (e) {
    console.log('  ✘ 处理失败 ' + item.file + '：' + String(e?.message ?? e).slice(0, 80))
  }
}

// JOURNAL 压缩 + 归档
if (journalPlan) {
  try {
    const pad2 = (n) => String(n).padStart(2, '0')
    const d = new Date()
    const archDir = path.join(MEM, 'JOURNAL')
    fs.mkdirSync(archDir, { recursive: true })
    const archFile = path.join(archDir, `归档-${d.getFullYear()}-${pad2(d.getMonth() + 1)}.md`)
    fs.appendFileSync(archFile, '\n<!-- 原样归档（hot 文件已压缩） -->\n' + journalPlan.oldHb.join('\n') + '\n')
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    const merged = `- ${stamp}（心跳汇总 ${journalPlan.oldHb.length} 条）${journalPlan.brief}`
    fs.writeFileSync(journalPlan.file, journalPlan.keepLines.join('\n') + '\n' + merged + '\n', 'utf8')
    console.log('✓ JOURNAL 压缩 ' + journalPlan.oldHb.length + ' 条 → 归档 ' + path.basename(archFile))
  } catch (e) {
    console.log('✘ JOURNAL 压缩失败：' + String(e?.message ?? e).slice(0, 80))
  }
}

// 有用的话写进 JOURNAL（去重）
if (picked.size) {
  const j = path.join(MEM, 'JOURNAL.md')
  const oldText = (() => { try { return fs.readFileSync(j, 'utf8') } catch { return '' } })()
  const pad = (n) => String(n).padStart(2, '0')
  const d = new Date()
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const add = []
  for (const s of picked.values()) {
    if (oldText.includes(s.slice(0, 16))) continue
    add.push(`- ${stamp}（心跳箱）${s}`)
  }
  if (add.length) {
    fs.appendFileSync(j, '\n' + add.join('\n') + '\n')
    console.log('✓ 写进 JOURNAL ' + add.length + ' 条')
  } else console.log('✓ JOURNAL 里已有，没重复写')
}
console.log('✓ 完成。备份在 ' + BACKUP)
