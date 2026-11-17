/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：设计取向借鉴自 Hermes（memory provider + 全文检索、skills 索引只注入摘要、
 * 定时任务作为一等公民、会话导出为训练样本）。无代码复制。
 * 详见 THIRD-PARTY-NOTICES.md §4.1 / docs/ATTRIBUTION.md
 */
/**
 * 通用任务（对标 Hermes 的 cron：一等公民的任务，而不是 shell 定时）
 *
 * 定义文件：~/.dsh/agent-core/jobs.json
 * {
 *   "jobs": [
 *     {
 *       "id": "daily-trajectory",
 *       "name": "每日导出轨迹",
 *       "enabled": true,
 *       "schedule": { "type": "daily", "hour": 4, "minute": 0 },
 *       "action": { "type": "script", "path": "C:/…/export-trajectory.mjs", "args": [] },
 *       "deliver": "none"            // "channel" = 结果推到当前通道；"none" = 只进日志
 *     },
 *     {
 *       "id": "journal-compact",
 *       "name": "JOURNAL 小步压缩",
 *       "enabled": true,
 *       "schedule": { "type": "every", "seconds": 604800 },
 *       "action": { "type": "script", "path": "C:/…/compact.mjs" },
 *       "deliver": "qq"
 *     },
 *     {
 *       "id": "morning-note",
 *       "name": "早上叫他起床",
 *       "enabled": false,
 *       "schedule": { "type": "daily", "hour": 7, "minute": 30 },
 *       "action": { "type": "prompt", "text": "……" },
 *       "deliver": "qq"
 *     }
 *   ]
 * }
 *
 * 状态：~/.dsh/agent-core/jobs-state.json { "<id>": { lastRunAt, lastResult } }
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 判断某个 job 现在该不该跑（纯函数，方便测） */
export function isDue(job, state, now = new Date()) {
  if (!job || job.enabled === false) return false
  const s = job.schedule ?? {}
  const st = state?.[job.id] ?? {}
  const last = Number(st.lastRunAt ?? 0)
  if (s.type === 'daily') {
    const target = new Date(now)
    target.setHours(Number(s.hour ?? 0), Number(s.minute ?? 0), 0, 0)
    if (now.getTime() < target.getTime()) return false
    // 今天这个点之后还没跑过
    return String(st.lastDay ?? '') !== dayKey(now)
  }
  if (s.type === 'every') {
    const every = Math.max(60, Number(s.seconds ?? 3600)) * 1000
    return !last || now.getTime() - last >= every
  }
  return false
}

/** 执行一个 job；返回 { ok, kind, output } */
export async function runJob(job, deps) {
  const action = job.action ?? {}
  const at = new Date()
  try {
    if (action.type === 'script') {
      const out = execFileSync(process.execPath, [action.path, ...(action.args ?? [])], {
        windowsHide: true, encoding: 'utf8', timeout: Math.max(30_000, Number(action.timeoutMs ?? 120_000)),
      })
      deps.log(`job ${job.id} script ok`)
      return { ok: true, kind: 'script', output: String(out).trim().slice(0, 2000) }
    }
    if (action.type === 'prompt') {
      await deps.prompt(String(action.text ?? ''))
      deps.log(`job ${job.id} prompt ok`)
      return { ok: true, kind: 'prompt', output: '已投递' }
    }
    return { ok: false, kind: 'none', output: 'unknown action type' }
  } catch (e) {
    deps.log(`job ${job.id} failed: ${String(e?.message ?? e)}`)
    return { ok: false, kind: action.type ?? '?', output: String(e?.message ?? e).slice(0, 300) }
  }
}

export function loadJobs(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.jobs ?? [] } catch { return [] }
}

export function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch {}
}

export function markRun(state, job, result, now = new Date()) {
  const next = { ...(state ?? {}) }
  next[job.id] = {
    lastRunAt: now.getTime(),
    lastDay: dayKey(now),
    lastOk: Boolean(result?.ok),
    lastOutput: result?.output ?? '',
  }
  return next
}
