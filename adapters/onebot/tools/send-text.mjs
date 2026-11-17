/**
 * send-text.mjs —— 发一段文字到 QQ 私聊（避开 PowerShell 的引号地狱）
 * 用法：node send-text.mjs <user_id> <文件路径|->   （- 表示从 stdin 读）
 */
import fs from 'node:fs'
import { onebot } from '../config.mjs'

const API = 'http://127.0.0.1:5700'
const TOKEN = onebot.token
const [, , uid, src] = process.argv

if (!uid || !src) { console.error('用法: node send-text.mjs <user_id> <文件|->'); process.exit(2) }

let text = ''
if (src === '-') {
  text = fs.readFileSync(0, 'utf8')
} else {
  text = fs.readFileSync(src, 'utf8')
}
text = text.replace(/\r\n/g, '\n').trim()
if (!text) { console.error('空文本'); process.exit(2) }

// 太长就分段（QQ 单条上限约 4500 字）
const chunks = []
let rest = text
while (rest.length > 3500) {
  const cut = rest.lastIndexOf('\n', 3500)
  chunks.push(rest.slice(0, cut > 0 ? cut : 3500))
  rest = rest.slice(cut > 0 ? cut : 3500).trimStart()
}
chunks.push(rest)

for (const c of chunks) {
  const r = await fetch(API + '/send_private_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ user_id: Number(uid), message: [{ type: 'text', data: { text: c } }] }),
    signal: AbortSignal.timeout(60000),
  })
  const j = await r.json().catch(() => ({}))
  const ok = j.status === 'ok' || j.retcode === 0
  console.log((ok ? 'OK ' : 'NG ') + c.slice(0, 40).replace(/\n/g, ' ') + '…')
  await new Promise((r) => setTimeout(r, 500))
}
