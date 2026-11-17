#!/usr/bin/env node
/**
 * QQ 任务自愈器 —— 参考 B 站那只的思路：大部分时间什么都不做，坏了立刻自己修。
 *
 * 它解决什么：
 *   DSH 每次重启，QQ 私聊会换一个新的 session id（onebot-private-<qq>-xxxx），
 *   但 storages/schedule.json 里的「心跳」「写日记」还绑在旧 id 上 →
 *   定时任务静默失效（投递 0 次，也不报错）。
 *
 * 做法：把 schedule.json 里所有 onebot-private-* 的任务改绑到**当前**会话 id。
 * 顺带把心跳间隔兜到 ≥ 4 小时（省 token）。
 *
 * 用法：
 *   node qq-schedule-fix.mjs            正常跑（有改动才写，平时静默）
 *   node qq-schedule-fix.mjs --dry      只看会改什么
 *   node qq-schedule-fix.mjs --verbose  总是打印状态
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { onebot } from '../config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const MAP = path.join(DSH, 'media', 'onebot', 'chat-sessions.json')
const SCHED = path.join(DSH, 'storages', 'schedule.json')
const LOG = path.join(DSH, 'bili-whale', 'qq-schedule-fix.log')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const VERBOSE = argv.includes('--verbose')
const FORCE = argv.includes('--force')

// DSH 在跑的时候，它内存里的任务才是权威 → 我们改文件只会被它写回去（白折腾）。
// 所以默认只在 DSH 没起来时干活（eg. 启动前 / 崩溃后），要强行改加 --force。
import net from 'node:net'
function dshIsUp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: 3080 })
    const done = (v) => { try { s.destroy() } catch {} ; resolve(v) }
    s.setTimeout(600, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}
if (!FORCE && !DRY && (await dshIsUp())) {
  if (VERBOSE) console.log('DSH_RUNNING（跳过；它自己会覆盖，等它启动前再修）')
  process.exit(0)
}


const MIN_HEARTBEAT_SEC = 4 * 3600   // 心跳至少 4 小时一次，别烧 token

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${line}\n`)
  } catch {}
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

const map = readJson(MAP)
if (!map) { if (VERBOSE) console.log('NO_MAP'); process.exit(0) }

const current = map['private:' + onebot.ownerQQ]
// Never turn an object-shaped mapping into the invalid session id [object Object].
if (typeof current !== 'string' || !(new RegExp('^onebot-private-' + onebot.ownerQQ + '(?:-|$)')).test(current)) {
  console.error('INVALID_PRIVATE_SESSION_MAPPING: schedule bindings were not modified')
  process.exit(1)
}

const sched = readJson(SCHED)
if (!sched?.tables?.tasks) { if (VERBOSE) console.log('NO_SCHEDULE'); process.exit(0) }

const changes = []
for (const [id, task] of Object.entries(sched.tables.tasks)) {
  const title = task?.record?.title ?? id
  const sid = String(task?.sessionId ?? '')

  if (sid.startsWith('onebot-private-') && sid !== current) {
    changes.push(`${title}: session ${sid} → ${current}`)
    if (!DRY) task.sessionId = current
  }

  if (/(心跳)/.test(title) && task?.record?.kind === 'every') {
    const cur = Number(task.record.everySeconds ?? 0)
    if (cur > 0 && cur < MIN_HEARTBEAT_SEC) {
      changes.push(`${title}: every ${cur}s → ${MIN_HEARTBEAT_SEC}s（省 token）`)
      if (!DRY) task.record.everySeconds = MIN_HEARTBEAT_SEC
    }
    // 关键：重启后 scheduledAt 往往是很久以前 → 宿主那次扫描未必补发。
    // 启动前把下一次心跳重设成「开机后 3 分钟」，让它一定会被扫到。
    const soon = new Date(Date.now() + 3 * 60 * 1000).toISOString()
    if (String(task.record.scheduledAt) !== soon) {
      changes.push(`${title}: scheduledAt 重设 → ${soon}`)
      if (!DRY) task.record.scheduledAt = soon
    }
  }

  // 日记：重设到今天 23:37（过了就明天），保证今晚一定写
  if (/日记/.test(title) && task?.record?.kind === 'daily') {
    const now = new Date()
    const t = new Date(now)
    t.setHours(23, 37, 0, 0)
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1)
    const iso = t.toISOString()
    if (String(task.record.scheduledAt) !== iso) {
      changes.push(`${title}: scheduledAt 重设 → ${t.toLocaleString('zh-CN', { hour12: false })}`)
      if (!DRY) task.record.scheduledAt = iso
    }
  }
}

if (!changes.length) {
  if (VERBOSE) console.log('OK 无需修复（' + current + '）')
  process.exit(0)
}

for (const c of changes) console.log('FIX ' + c)
log('修复 ' + changes.length + ' 处：' + changes.join(' | '))

if (DRY) { console.log('（dry：没有写入）'); process.exit(0) }

const tmp = SCHED + '.tmp'
fs.writeFileSync(tmp, JSON.stringify(sched, null, 2) + '\n')
fs.renameSync(tmp, SCHED)
console.log('WROTE ' + SCHED)
