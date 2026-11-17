/**
 * send-labeled.mjs —— 先发一条说明，再按顺序发图（每张前面带序号标签）
 *
 * 用法：node send-labeled.mjs <user_id> "<说明文字>" <图1> <图2> ...
 * 每张图会先在说明里对应上「1 = 文件名」，方便分辨。
 */
import fs from 'node:fs'
import path from 'node:path'
import { onebot } from '../config.mjs'

const API = 'http://127.0.0.1:5700'
const TOKEN = onebot.token
const [, , uid, caption, ...files] = process.argv

if (!uid || !caption || !files.length) {
  console.error('用法: node send-labeled.mjs <user_id> "<说明>" <图...>')
  process.exit(2)
}

async function send(text) {
  const r = await fetch(API + '/send_private_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ user_id: Number(uid), message: [{ type: 'text', data: { text } }] }),
    signal: AbortSignal.timeout(60000),
  })
  return r.json().catch(() => ({}))
}

async function sendImage(abs) {
  const r = await fetch(API + '/send_private_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ user_id: Number(uid), message: [{ type: 'image', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }] }),
    signal: AbortSignal.timeout(120000),
  })
  return r.json().catch(() => ({}))
}

const list = files.map((f, i) => `${i + 1}. ${path.basename(f)}`).join('\n')
await send(caption + '\n\n' + list)
await new Promise((r) => setTimeout(r, 800))

let ok = 0
for (let i = 0; i < files.length; i++) {
  const abs = path.resolve(files[i])
  if (!fs.existsSync(abs)) { console.log('缺 ' + files[i]); continue }
  const j = await sendImage(abs)
  const good = j.status === 'ok' || j.retcode === 0 || j.data?.message_id
  if (good) { ok++; console.log('OK  ' + (i + 1) + '. ' + path.basename(abs)) } else console.log('NG  ' + path.basename(abs))
  await new Promise((r) => setTimeout(r, 700))
}
console.log('\n成功 ' + ok + ' / ' + files.length)
