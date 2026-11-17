/**
 * send-diary-ordered.mjs —— 把某天私记按顺序分段补发（纯文本，不发图）
 *
 * 用法：node send-diary-ordered.mjs <user_id> <YYYY-MM-DD> [--parts 3] [--file]
 */
import fs from 'node:fs'
import path from 'node:path'
import { onebot } from '../config.mjs'
import { DSH_HOME, cfg } from '../../core/lib/config.mjs'

const API = 'http://127.0.0.1:5700'
const TOKEN = onebot.token
const [, , uid, date, ...rest] = process.argv
const parts = Number((rest[rest.indexOf('--parts') + 1] || 3)) || 3
const withFile = rest.includes('--file')

if (!uid || !date) { console.error('用法: node send-diary-ordered.mjs <uid> <YYYY-MM-DD> [--parts 3] [--file]'); process.exit(2) }

const DIARY = path.join(DSH_HOME, 'memory', '日记', '私记.md')
const txt = fs.readFileSync(DIARY, 'utf8')
const blocks = txt.split(/\n(?=##\s)/).filter((b) => b.startsWith('## ') && b.includes(date))
if (!blocks.length) { console.error('这天没有日记：' + date); process.exit(1) }

const body = blocks.join('\n\n').trim()
// 按段落切，尽量在句号处断开
const paras = body.split(/\n{2,}/).filter(Boolean)
const chunks = Array.from({ length: parts }, () => '')
let cur = 0
for (const p of paras) {
  if (chunks[cur].length > 0 && chunks[cur].length + p.length > Math.ceil(body.length / parts) * 1.15) {
    cur = Math.min(cur + 1, parts - 1)
  }
  chunks[cur] += (chunks[cur] ? '\n\n' : '') + p
}

async function sendText(text) {
  const r = await fetch(API + '/send_private_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ user_id: Number(uid), message: [{ type: 'text', data: { text } }] }),
    signal: AbortSignal.timeout(60000),
  })
  return r.json().catch(() => ({}))
}

async function sendFile(abs) {
  const r = await fetch(API + '/send_private_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ user_id: Number(uid), message: [{ type: 'file', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }] }),
    signal: AbortSignal.timeout(120000),
  })
  return r.json().catch(() => ({}))
}

let sent = 0
for (let i = 0; i < chunks.length; i++) {
  if (!chunks[i].trim()) continue
  const head = `【${date} 私记】${i + 1}/${parts}`
  const j = await sendText(head + '\n\n' + chunks[i])
  const ok = j.status === 'ok' || j.retcode === 0
  console.log((ok ? 'OK  ' : 'NG  ') + (i + 1) + '/' + parts + '  ' + chunks[i].length + ' 字')
  if (ok) sent++
  await new Promise((r) => setTimeout(r, 1200))
}

if (withFile) {
  const media = onebot.mediaDir
  const out = path.join(media, `agent-diary-${date}.md`)
  fs.mkdirSync(media, { recursive: true })
  fs.writeFileSync(out, `# ${cfg.botName}私记 · ${date}\n\n${body}\n`, 'utf8')
  const j = await sendFile(out)
  const ok = j.status === 'ok' || j.retcode === 0
  console.log((ok ? 'OK  ' : 'NG  ') + 'file ' + path.basename(out))
}

console.log('\n共发 ' + sent + ' 段' + (withFile ? ' + 1 个文件' : ''))
