/**
 * send-file.mjs —— 把文件发到 QQ（私聊或群）
 *
 * 用法：node send-file.mjs <user_id> <文件路径> [--group]
 */
import fs from 'node:fs'
import path from 'node:path'
import { onebot } from '../config.mjs'

const API = 'http://127.0.0.1:5700'
const TOKEN = onebot.token
const [, , uid, file, flag] = process.argv
const group = flag === '--group'

if (!uid || !file) { console.error('用法: node send-file.mjs <id> <文件> [--group]'); process.exit(2) }
const abs = path.resolve(file)
if (!fs.existsSync(abs)) { console.error('文件不存在: ' + abs); process.exit(2) }

const action = group ? '/send_group_msg' : '/send_private_msg'
const body = group
  ? { group_id: Number(uid), message: [{ type: 'file', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }] }
  : { user_id: Number(uid), message: [{ type: 'file', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }] }

const r = await fetch(API + action, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120000),
})
const j = await r.json().catch(() => ({}))
const ok = j.status === 'ok' || j.retcode === 0 || j.data?.message_id
console.log((ok ? 'OK  ' : 'NG  ') + path.basename(abs) + '  ' + JSON.stringify(j).slice(0, 200))
