/**
 * send-batch.mjs —— 把一批图按顺序发到指定 QQ 私聊
 *
 * 用法：node send-batch.mjs <user_id> <图1> <图2> ...
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { onebot } from '../config.mjs'

const API = 'http://127.0.0.1:5700'
const TOKEN = onebot.token
const [, , uid, ...files] = process.argv

if (!uid || !files.length) {
  console.error('用法: node send-batch.mjs <user_id> <图...>')
  process.exit(2)
}

let ok = 0
let fail = 0
for (const f of files) {
  const abs = path.resolve(f)
  if (!fs.existsSync(abs)) { console.log('缺文件 ' + f); fail++; continue }
  const body = {
    user_id: Number(uid),
    message: [{ type: 'image', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }],
  }
  try {
    const r = await fetch(API + '/send_private_msg', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    const j = await r.json().catch(() => ({}))
    const good = j.status === 'ok' || j.retcode === 0 || j.data?.message_id
    if (good) { ok++; console.log('OK  ' + path.basename(abs)) }
    else { fail++; console.log('NG  ' + path.basename(abs) + '  ' + JSON.stringify(j).slice(0, 160)) }
  } catch (e) {
    fail++
    console.log('ERR ' + path.basename(abs) + '  ' + String(e?.message ?? e).slice(0, 100))
  }
  await new Promise((r) => setTimeout(r, 800))
}
console.log('\n成功 ' + ok + ' / 失败 ' + fail)
