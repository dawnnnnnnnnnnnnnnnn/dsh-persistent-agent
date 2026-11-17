#!/usr/bin/env node
/**
 * restart.mjs —— QQ 那只收到「重启」类指令时调它。
 *
 * 关键教训（早期）：
 *   从 DSH 的工具进程里 spawn 子进程是**活不下来**的——DSH 的沙箱用 job object
 *   把子进程一起收掉，日志里连一行都写不出来。所以这里不走 spawn，
 *   改成「写请求文件 + 让计划任务去跑」：计划任务由 Task Scheduler 启动，
 *   不在 DSH 的进程树里，杀 DSH 也杀不掉它。
 *
 * 用法：
 *   node restart.mjs                     # 只重启 DSH
 *   node restart.mjs --mode both         # DSH + QQ
 *   node restart.mjs --mode qq           # 只重启 QQ（NapCat）
 *   node restart.mjs --reason "使用者说卡住了"
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { onebot } from '../config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const CORE = path.join(DSH, 'agent-core')
const REQ = path.join(CORE, 'restart.request.json')
const RESULT = path.join(CORE, 'restart.result.json')
const LOG = path.join(CORE, 'restart.log')
const TASK = 'DSH-Restart-Agent'

const argv = process.argv.slice(2)
const arg = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const modeRaw = arg('--mode', 'dsh')
const mode = ['dsh', 'qq', 'both'].includes(modeRaw) ? modeRaw : 'dsh'
const reason = arg('--reason', '')
const by = arg('--by', onebot.ownerQQ)
// 早期：默认延后 45 秒再杀进程 —— 否则正在跑的这一轮会被硬杀（"任务已停止"）
//   · 默认 45s；--delay N 自定义；--now 表示不延后（只在进程卡死时用）
const delaySec = argv.includes('--now') ? 0 : Math.max(0, Math.min(300, Number(arg('--delay', '45')) || 0))
const notBefore = Date.now() + delaySec * 1000

function log(m) {
  try { fs.mkdirSync(CORE, { recursive: true }); fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [mjs] ${m}\n`) } catch {}
}

// 早期 防抖：180 秒内已经重启过就别再来一次（避免连环杀自己）
const THRASH_MS = 180_000
try {
  const last = JSON.parse(fs.readFileSync(path.join(CORE, 'restart.throttle.json'), 'utf8'))
  if (last && Date.now() - Number(last.at || 0) < THRASH_MS) {
    console.log(JSON.stringify({ ok: true, dispatched: false, note: '刚刚已经重启过，' + Math.round((THRASH_MS - (Date.now() - last.at)) / 1000) + ' 秒内不再重复', result: RESULT }))
    process.exit(0)
  }
} catch {}

let running = false
try {
  const r = JSON.parse(fs.readFileSync(RESULT, 'utf8').replace(/^\uFEFF/, ''))
  running = r?.state === 'running' && (Date.now() - Date.parse(r.startedAt) < 240_000)
} catch {}

if (running) {
  console.log(JSON.stringify({ ok: true, dispatched: false, note: '已有重启在进行中', result: RESULT }))
  process.exit(0)
}

const id = `r${Date.now()}`
try {
  fs.mkdirSync(CORE, { recursive: true })
  fs.writeFileSync(REQ, JSON.stringify({ id, at: new Date().toISOString(), mode, reason, requestedBy: by, delaySec, notBefore, state: 'pending' }, null, 2) + '\n')
} catch (e) {
  console.error('写请求文件失败：' + e.message)
  process.exit(2)
}

try { fs.writeFileSync(path.join(CORE, 'restart.throttle.json'), JSON.stringify({ at: Date.now() })) } catch {}

const r = spawnSync('schtasks.exe', ['/Run', '/TN', TASK], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
const schOk = r.status === 0
log(`请求 ${id} mode=${mode} → schtasks ${schOk ? 'OK' : 'FAIL: ' + String(r.stderr ?? '').trim().slice(0, 120)}`)

console.log(JSON.stringify({
  ok: schOk,
  dispatched: schOk,
  id, mode, reason,
  hint: schOk ? '计划任务已触发，约 20-40 秒完成' : '计划任务未注册或无法触发，请检查 ' + TASK,
  result: RESULT,
  log: LOG,
}))
// Never report success when the external restart worker was not dispatched.
if (!schOk) process.exitCode = 1

// 早期：写进日志的自检 —— 计划任务说 OK 不代表真的重启了。
//   实测出现过「旧进程还占着 3080、新进程空转不绑端口」，于是代码改了却一直没生效。
if (schOk && mode === 'dsh') {
  setTimeout(() => {
    try {
      const { execFileSync } = require('node:child_process')
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        "(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess",
      ], { encoding: 'utf8', timeout: 15000 }).trim()
      const line = out ? ('重启自检：3080 现在属于 PID ' + out) : '重启自检：3080 没人在听（重启可能失败）'
      try { fs.appendFileSync(LOG, '[' + new Date().toLocaleString('sv-SE') + '] [mjs] ' + line + '\n') } catch {}
    } catch (e) {
      try { fs.appendFileSync(LOG, '[' + new Date().toLocaleString('sv-SE') + '] [mjs] 重启自检异常：' + String(e?.message ?? e) + '\n') } catch {}
    }
  }, 40000).unref?.()
}
