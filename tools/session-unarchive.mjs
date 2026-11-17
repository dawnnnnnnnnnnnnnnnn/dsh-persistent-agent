#!/usr/bin/env node
/**
 * session-unarchive.mjs —— 自动把 onebot 的会话从「归档」里放出来
 *
 * 为什么需要：DSH 的 ArchivedSessionGate 会把归档会话的每一轮都 reject，
 * 表现就是「她不回复任何人」。早期 查到的就是这个原因。
 *
 * 做法：读 storages\workspace.json 的 global.archivedSessionIds，
 *       把 onebot-* 的条目删掉；有改动就写回并记日志。
 *
 * 用法：node session-unarchive.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || os.homedir()
const FILE = path.join(HOME, '.dsh', 'storages', 'workspace.json')
const LOG = path.join(HOME, '.dsh', 'agent-core', 'session-unarchive.log')
const DRY = process.argv.includes('--dry')

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `[${new Date().toLocaleString('sv-SE')}] ${line}\n`)
  } catch {}
}

let j
try {
  j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
} catch (e) {
  console.error('X 读不到 workspace.json: ' + String(e.message).slice(0, 80))
  process.exit(1)
}

const before = Array.isArray(j?.global?.archivedSessionIds) ? j.global.archivedSessionIds : []
const keep = before.filter((id) => !/^onebot-/.test(String(id)))
const removed = before.filter((id) => /^onebot-/.test(String(id)))

if (!removed.length) {
  console.log('OK 没有被归档的 onebot 会话')
  process.exit(0)
}

if (DRY) {
  console.log('（预演）会放出：' + removed.join(', '))
  process.exit(0)
}

// 备份一次再写
try {
  fs.copyFileSync(FILE, FILE + '.bak-unarchive-' + Date.now())
} catch {}
j.global.archivedSessionIds = keep
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8')
log('已放出 ' + removed.length + ' 个会话: ' + removed.join(', '))
console.log('OK 已放出 ' + removed.length + ' 个：' + removed.join(', '))
console.log('   注意：需要重启 DSH 才让 gate 重新读（或等它自己下次启动）')
