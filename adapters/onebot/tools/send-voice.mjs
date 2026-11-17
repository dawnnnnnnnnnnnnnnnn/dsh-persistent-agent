/**
 * send-voice.mjs —— 发 QQ 语音（record），失败退回文件
 * 用法：node send-voice.mjs <user_id> <音频路径>
 */
import fs from 'node:fs'
import path from 'node:path'
import { onebot } from '../config.mjs'

const API = 'http://127.0.0.1:5700'
const TOKEN = onebot.token
const [, , uid, file] = process.argv
if (!uid || !file) { console.error('用法: node send-voice.mjs <uid> <音频>'); process.exit(2) }
const abs = path.resolve(file)
if (!fs.existsSync(abs)) { console.error('文件不存在: ' + abs); process.exit(2) }

async function send(kind) {
  const data = kind === 'record'
    ? { file: 'file:///' + abs.replace(/\\/g, '/') }
    : { file: 'file:///' + abs.replace(/\\/g, '/') }
  const r = await fetch(API + '/send_private_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ user_id: Number(uid), message: [{ type: kind, data }] }),
    signal: AbortSignal.timeout(120000),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: j.status === 'ok' || j.retcode === 0, raw: JSON.stringify(j).slice(0, 200) }
}

const v = await send('record')
console.log((v.ok ? 'OK  语音条' : 'NG  语音条 ' + v.raw) + '  ' + path.basename(abs))
if (!v.ok) {
  const f = await send('file')
  console.log((f.ok ? 'OK  文件' : 'NG  文件 ' + f.raw) + '  ' + path.basename(abs))
}
