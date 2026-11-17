#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * apply-config.mjs —— 把开源包里的 {{占位符}} 换成使用者自己的值。
 *
 * 开源包里所有代码带着 {{OWNER_QQ}} 这样的占位符（出包时自动替换的，
 * 目的是不把我的号/令牌/路径带出去）。使用者填好 agent.config.json，
 * 跑这个脚本，它就把整包里的占位符换掉。
 *
 * 用法：
 *   1. 编辑同目录的 agent.config.json
 *   2. node apply-config.mjs
 *   3. node apply-config.mjs --check   # 只检查有没有漏掉的占位符
 */
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const CFG = path.join(HERE, 'agent.config.json')
const CHECK_ONLY = process.argv.includes('--check')

const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch { return null }
})()

if (!cfg && !CHECK_ONLY) {
  console.error('缺少 agent.config.json。先复制 agent.config.example.json 再填。')
  process.exit(2)
}

const MAP = cfg ? {
  '{{OWNER_QQ}}': String(cfg.ownerQQ ?? ''),
  '{{BOT_QQ}}': String(cfg.botQQ ?? ''),
  '{{HOME}}': String(cfg.home ?? '').replace(/\\/g, '\\\\'),
  '{{NAPCAT_TOKEN}}': String(cfg.napcatToken ?? ''),
  '{{OWNER_NAME}}': String(cfg.ownerName ?? '使用者'),
  '{{BOT_NAME}}': String(cfg.botName ?? '她'),
  '{{FRIEND_NAME}}': String(cfg.friendName ?? '朋友'),
  '{{GROUP_ID}}': String(cfg.groupId ?? '0'),
} : null

const SKIP = /node_modules|\.git|dist|agent\.config\.json/
let files = 0
let placeholders = 0

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(p); continue }
    if (!/\.(mjs|js|html|md|json|yml|ps1|cmd)$/.test(e.name)) continue
    let text = fs.readFileSync(p, 'utf8')
    const found = text.match(/\{\{[A-Z_]+\}\}/g) ?? []
    if (found.length) placeholders += found.length
    if (CHECK_ONLY || !found.length) continue
    for (const [k, v] of Object.entries(MAP)) {
      if (v) text = text.split(k).join(v)
    }
    fs.writeFileSync(p, text, 'utf8')
    files += 1
  }
}

walk(HERE)

if (CHECK_ONLY) {
  console.log(placeholders
    ? `还有 ${placeholders} 处占位符没填（填 agent.config.json 后跑 node apply-config.mjs）`
    : '没有剩余占位符了')
  process.exit(placeholders ? 1 : 0)
}
console.log(`已处理 ${files} 个文件`)
const left = (() => {
  let n = 0
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.test(e.name)) scan(p); continue }
      if (!/\.(mjs|js|html|md|json|yml|ps1|cmd)$/.test(e.name)) continue
      n += (fs.readFileSync(p, 'utf8').match(/\{\{[A-Z_]+\}\}/g) ?? []).length
    }
  }
  scan(HERE)
  return n
})()
if (left) console.log(`注意：还有 ${left} 处占位符（配置里对应项是空的）`)
