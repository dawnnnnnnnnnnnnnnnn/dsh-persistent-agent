#!/usr/bin/env node
/**
 * private-mode.mjs —— 私聊独占开关（只对配置里的 ownerId 生效）
 *
 * 作用域：只有 ownerId 的私聊能打开；群聊与他人私聊一律 DENY。脚本只做开关，不涉及内容。
 * 本地生图和语音也照做；别人无法触发。**
 *
 * 这个脚本只管**开关与作用域**，不管内容：
 *   · 只有使用者 QQ 的私聊能把开关打开（脚本自己校验）
 *   · 打开后有时限（默认 120 分钟），到点自动失效
 *   · 群聊 / 别人私聊里绝不生效（inbound 补丁会先把开关关掉并提示）
 *
 * 用法：
 *   node intimate.mjs on  [--minutes 120]   # 使用者私聊里开
 *   node intimate.mjs off                    # 随时关
 *   node intimate.mjs status                 # 看现在开没开、剩多久
 *   node intimate.mjs gate --kind private --uid {{OWNER_QQ}}   # 给补丁/脚本调用的判定
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { onebot } from '../config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const STATE = path.join(DSH, 'agent-core', 'intimate.json')
const OWNER = onebot.ownerQQ

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }

const read = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} }
}
const write = (o) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2) + '\n') }

function active(st) {
  return Boolean(st && st.enabled === true && Number(st.expiresAt ?? 0) > Date.now())
}

if (cmd === 'on') {
  const uid = String(arg('--uid') || OWNER)
  if (uid !== OWNER) { console.error('✗ 只有 ownerId 能开（当前 uid ' + uid + '）'); process.exit(3) }
  const minutes = Math.max(10, Math.min(720, Number(arg('--minutes') || 120)))
  write({ enabled: true, since: Date.now(), expiresAt: Date.now() + minutes * 60000, scope: 'private:' + OWNER })
  console.log('✓ 私聊独占已开：' + minutes + ' 分钟后自动失效')
  process.exit(0)
}

if (cmd === 'off') {
  write({ enabled: false, since: Date.now(), expiresAt: 0, scope: 'private:' + OWNER })
  console.log('✓ 已关闭')
  process.exit(0)
}

if (cmd === 'status') {
  const st = read()
  if (active(st)) {
    const left = Math.round((Number(st.expiresAt) - Date.now()) / 60000)
    console.log('开着（剩 ' + left + ' 分钟，作用域 ' + (st.scope || '?') + '）')
    process.exit(0)
  }
  console.log('关着')
  process.exit(1)
}

if (cmd === 'gate') {
  const kind = String(arg('--kind') || '')
  const uid = String(arg('--uid') || '')
  const st = read()
  const ok = active(st) && kind === 'private' && uid === OWNER
  console.log(ok ? 'ALLOW' : 'DENY')
  process.exit(ok ? 0 : 1)
}

console.error('用法: on [--minutes N] | off | status | gate --kind private --uid <qq>')
process.exit(2)
