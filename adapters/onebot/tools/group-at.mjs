#!/usr/bin/env node
/**
 * group-at.mjs —— 群聊「要不要 @ 才说话」的开关（运行时生效，不用重启）。
 *
 *   node group-at.mjs            → 看现在是什么状态
 *   node group-at.mjs off        → 群里不用 @ 也说话（除了他不在的群照样不说话）
 *   node group-at.mjs on         → 恢复「只有 @ 才说话」
 *
 * 它写 ~/.dsh/media/onebot/group-mention.json，插件每条群消息现读，所以立刻生效。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.USERPROFILE || os.homedir()
const FILE = path.join(HOME, '.dsh', 'media', 'onebot', 'group-mention.json')
const arg = String(process.argv[2] || '').toLowerCase()

const read = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return null }
}

if (!arg || arg === 'status') {
  const cur = read()
  if (!cur || typeof cur.requireMention !== 'boolean') {
    console.log('未设置覆盖 → 跟随插件配置（当前 requireMention: true，即需要 @）')
  } else {
    console.log('当前：' + (cur.requireMention ? '群里必须 @ 我才说话' : '群里不用 @ 我也会说话') +
      '（' + (cur.at || '') + ' 由 ' + (cur.by || '?') + ' 设置）')
  }
  process.exit(0)
}

if (arg !== 'on' && arg !== 'off') {
  console.error('用法: node group-at.mjs [on|off|status]')
  process.exit(2)
}

const requireMention = arg === 'on'
fs.mkdirSync(path.dirname(FILE), { recursive: true })
fs.writeFileSync(FILE, JSON.stringify({
  requireMention,
  at: new Date().toISOString(),
  by: 'owner-in-group',
}, null, 2) + '\n', 'utf8')

console.log(requireMention
  ? '✓ 已改回：群里必须 @ 我才说话'
  : '✓ 已改：群里不用 @ 我也会说话（他不在的群仍然不说话；每天十句上限仍然有效）')
