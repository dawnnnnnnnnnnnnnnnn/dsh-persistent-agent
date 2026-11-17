#!/usr/bin/env node
/**
 * occasion.mjs —— 纪念日 → QQ 空间说说（请示制）
 *
 * （可自定义）规矩：
 *   · 有纪念意义的日子，她可以发一条空间说说
 *   · **不带图**：当天第一次要请示他，之后同类可自己发；一天最多 2 条
 *   · **带图**：每次都要请示（图要用 GPT 高质量档，先报预算）
 *   · 每年总数不限，但**不许自己发明纪念日**——必须有依据
 *
 * 为什么要有"请示令牌"：脚本没法问人，所以拆成两步
 *   ① 她先问他 → 他说行 → `occasion approve <id>` 写一个一次性令牌
 *   ② `occasion post --id <id> --text "..." [--image 路径] --go` 凭令牌发
 *      没令牌 → 直接拒发（这样"她自作主张发说说"在机制上就不可能）
 *
 * 用法：
 *   node occasion.mjs check                 今天（和未来 7 天）有没有纪念日
 *   node occasion.mjs approve <id>          他同意了，发一个令牌（10 分钟内有效）
 *   node occasion.mjs post --id <id> --text "..." --go
 *   node occasion.mjs post --id <id> --text "..." --image {{WORKSPACE}}/...png --go
 *   node occasion.mjs log                   看过发过什么
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { WORKSPACE } from '../../../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const MEM = path.join(DSH, 'memory')
const DATA = process.env.AGENT_DATA || path.join(WORKSPACE, 'dsh-data')
const OCC_FILE = path.join(MEM, '纪念日.md')
const STATE = path.join(DSH, 'agent-core', 'occasion-state.json')
const TOKEN = path.join(DSH, 'agent-core', 'occasion-token.json')
const QQ_API = path.join(DSH, 'bili-whale', 'qq-api.mjs')
const NOTIFY = path.join(DSH, 'bili-whale', 'qq-notify.mjs')

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const read = (p, d = '') => { try { return fs.readFileSync(p, 'utf8') } catch { return d } }
const readJson = (p, d = {}) => { try { return JSON.parse(read(p, '{}')) } catch { return d } }
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n') }

const today = () => new Date().toLocaleDateString('sv-SE')
const md = (n) => String(n).padStart(2, '0')

/** 从 纪念日.md 里读表格：| 名称 | 月-日 | 说明 | */
function loadOccasions() {
  const out = []
  const text = read(OCC_FILE)
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?\s*\|\s*([^|]*)\|/)
    if (!m) continue
    const name = m[1].trim()
    if (/名称|—|--/.test(name)) continue
    out.push({ name, month: Number(m[2]), day: Number(m[3]), note: m[4].trim() })
  }
  return out
}

const st = readJson(STATE, { posts: [] })

if (cmd === 'check' || !cmd) {
  const list = loadOccasions()
  if (!list.length) {
    console.log('纪念日.md 里还没有条目。格式：| 名称 | 月-日 | 说明 |')
    process.exit(0)
  }
  const now = new Date()
  const hits = []
  for (let off = 0; off <= 7; off++) {
    const d = new Date(now.getTime() + off * 864e5)
    for (const o of list) {
      if (o.month === d.getMonth() + 1 && o.day === d.getDate()) {
        hits.push({ ...o, date: d.toLocaleDateString('sv-SE'), inDays: off, id: `${md(o.month)}${md(o.day)}-${o.name}` })
      }
    }
  }
  if (!hits.length) { console.log('未来 7 天没有纪念日。'); process.exit(0) }
  const posted = new Set((st.posts ?? []).map((p) => p.id + '@' + p.date))
  for (const h of hits) {
    const done = posted.has(h.id + '@' + h.date)
    console.log(`${h.inDays === 0 ? '今天' : h.inDays + ' 天后'} ${h.date}  ${h.name}  —  ${h.note || ''}${done ? '  [今天已经发过]' : ''}`)
    console.log(`   id: ${h.id}`)
  }
  process.exit(0)
}

if (cmd === 'approve') {
  const id = argv[1]
  if (!id) { console.error('用法: approve <id>（先跑 check 看 id）'); process.exit(2) }
  writeJson(TOKEN, { id, at: new Date().toISOString(), expiresAt: Date.now() + 10 * 60 * 1000 })
  console.log('✓ 已批准（10 分钟内有效）：' + id)
  console.log('  下一步：occasion post --id ' + id + ' --text "..." --go')
  process.exit(0)
}

if (cmd === 'post') {
  const id = arg('--id')
  const text = String(arg('--text') || '').trim()
  const image = arg('--image')
  const GO = argv.includes('--go')
  if (!id || !text) { console.error('用法: post --id <id> --text "..." [--image 路径] --go'); process.exit(2) }

  // ① 请示令牌
  const tok = readJson(TOKEN, {})
  const okTok = tok.id === id && Number(tok.expiresAt ?? 0) > Date.now()
  // ② 不带图 + 当天第一次：允许"请示过一次后自主"→ 需要当天已有一次批准记录
  const todayStr = today()
  const postsToday = (st.posts ?? []).filter((p) => p.date === todayStr)
  const hasImage = Boolean(image)
  const limitOk = hasImage ? true : postsToday.filter((p) => !p.image).length < 2

  if (hasImage && !okTok) {
    console.error('✗ 带图必须每次先请示：让他同意后跑 occasion approve ' + id)
    process.exit(3)
  }
  if (!hasImage && !okTok && postsToday.length === 0) {
    console.error('✗ 今天还没请示过：先问他一句，同意后跑 occasion approve ' + id)
    process.exit(3)
  }
  if (!limitOk) { console.error('✗ 今天不发图已经满 2 条了'); process.exit(3) }
  if (image && !fs.existsSync(image)) { console.error('✗ 图片不存在：' + image); process.exit(2) }

  if (!GO) {
    console.log('（预演）准备发到 QQ 空间：')
    console.log('  纪念日：' + id)
    console.log('  正文：' + text.slice(0, 200))
    if (image) console.log('  配图：' + image)
    console.log('加 --go 才会真的发。')
    process.exit(0)
  }

  // ③ 真发（走 NapCat 的 send_qzone_msg）
  const payload = JSON.stringify({ content: text, ugc_right: 4 })  // 4 = 好友可见
  let out = ''
  try {
    out = execFileSync(process.execPath, [QQ_API, 'send_qzone_msg', payload], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  } catch (e) {
    console.error('✗ 发说说失败：' + String(e?.message ?? e).slice(0, 160))
    process.exit(1)
  }

  st.posts = [...(st.posts ?? []), { id, date: todayStr, text: text.slice(0, 300), image: image || null, at: new Date().toISOString() }]
  writeJson(STATE, st)
  try { fs.unlinkSync(TOKEN) } catch {}
  console.log('✓ 已发到 QQ 空间')
  if (out) console.log('  返回：' + out.trim().slice(0, 160))
  try { if (fs.existsSync(NOTIFY)) execFileSync(process.execPath, [NOTIFY, '【空间说说】今天发了：' + text.slice(0, 60)], { timeout: 20000, windowsHide: true }) } catch {}
  process.exit(0)
}

if (cmd === 'letter') {
  const id = arg('--id') || 'letter'
  const text = String(arg('--text') || '').trim()
  const GO = argv.includes('--go')
  if (!text) { console.error('用法: letter --id <纪念日id> --text "正文" --go'); process.exit(2) }
  if (text.length < 30) { console.error('✗ 太短了：写具体的事，别空泛（至少 30 字）'); process.exit(3) }

  const day = today()
  const sameDay = (st.letters ?? []).filter((x) => x.date === day)
  if (sameDay.length >= 1) { console.error('✗ 今天已经写过一封了（一天最多一封）'); process.exit(3) }

  if (!GO) {
    console.log('（预演）会写进 memory\\给他\\信-' + day + '.md 并推给他')
    console.log(text.slice(0, 200))
    process.exit(0)
  }

  const dir = path.join(MEM, '给他')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '信-' + day + '.md')
  const body = ['# 给 ' + (cfg.ownerName || '你') + ' 的信 · ' + day, '', id && id !== 'letter' ? '（' + id + '）' : '', '', text, ''].filter(Boolean).join('\n')
  fs.writeFileSync(file, body, 'utf8')

  st.letters = [...(st.letters ?? []), { date: day, id, chars: text.length, file, at: new Date().toISOString() }]
  writeJson(STATE, st)

  if (fs.existsSync(NOTIFY)) {
    try { execFileSync(process.execPath, [NOTIFY, '给你写了封信（' + day + '）\n\n' + text.slice(0, 1200)], { timeout: 30000, windowsHide: true }) } catch {}
  }
  console.log('✓ 已写信：' + file)
  process.exit(0)
}
// ── 新增：让她自己把"有纪念意义的事"记下来 ──
// 使用者：纪念日不是一张固定日期表，**她自己遇到就写**：
// 学会新东西（会画画了）、上了新功能、他说的特别的话、一起做成的事。
if (cmd === 'add') {
  const name = String(arg('--name') || '').trim()
  const note = String(arg('--note') || '').trim()
  const kind = String(arg('--kind') || '里程碑').trim()
  const dateArg = String(arg('--date') || '').trim()
  const GO = argv.includes('--go')
  if (!name) { console.error('用法: add --name "会画画了" [--note "用 4router 出的第一张"] [--date ] [--kind 里程碑] --go'); process.exit(2) }

  const d = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? new Date(dateArg + 'T12:00:00') : new Date()
  const mm = d.getMonth() + 1
  const dd = d.getDate()
  const row = `| ${name} | ${mm}-${dd} | ${kind}${note ? ' · ' + note : ''}（${d.toLocaleDateString('sv-SE')} 记） |`

  let text = read(OCC_FILE)
  if (!text.trim()) {
    text = [
      '# 纪念日 / 里程碑',
      '',
      '> 只有写在这里的事才算"有纪念意义"。**她自己在聊天和开发中遇到就记**，不许凭空发明。',
      '> 格式：| 名称 | 月-日 | 说明 |',
      '',
      '## 记下来的事',
      '',
      '| 名称 | 月-日 | 说明 |',
      '| --- | --- | --- |',
      '',
    ].join('\n')
  }
  if (text.includes('| ' + name + ' |' + ` ${mm}-${dd} `)) { console.error('✗ 已经记过了：' + name); process.exit(3) }

  const marker = '| --- | --- | --- |'
  const idx = text.indexOf(marker)
  if (idx < 0) { console.error('✗ 纪念日.md 里没有表头，先手写一个'); process.exit(2) }
  const insertAt = idx + marker.length
  const next = text.slice(0, insertAt) + '\n' + row + text.slice(insertAt)

  if (!GO) {
    console.log('（预演）会记下：' + row)
    console.log('加 --go 才真写进 memory\\\\纪念日.md')
    process.exit(0)
  }
  fs.writeFileSync(OCC_FILE, next.replace(/\n{3,}/g, '\n\n'), 'utf8')
  st.milestones = [...(st.milestones ?? []), { name, note, kind, date: d.toLocaleDateString('sv-SE'), at: new Date().toISOString() }]
  writeJson(STATE, st)
  console.log('✓ 已记下：' + row)
  console.log('  同一天再跑 check 就会看到它')
  process.exit(0)
}
if (cmd === 'log') {
  const posts = (st.posts ?? []).slice(-10).reverse()
  if (!posts.length) { console.log('还没发过'); process.exit(0) }
  for (const p of posts) console.log(`${p.date}  ${p.id}  ${p.image ? '[有图] ' : ''}${p.text.slice(0, 40)}`)
  process.exit(0)
}

console.error('用法: check | approve <id> | post --id .. --text .. [--image ..] --go | log')
process.exit(2)
