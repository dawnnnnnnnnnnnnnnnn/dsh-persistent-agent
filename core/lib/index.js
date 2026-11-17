/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：
 *  1. "Hermes 对标层"的六件事（分层提示词/记忆检索/会话血缘/规则体检/通用任务/轨迹导出）
 *     借鉴自 Hermes，无代码复制。
 *  2. 与已安装的 dsh-bili-whale（MIT, Copyright (c) 2026 ALTERSSSS）为互操作关系：
 *     共用其配置字段与日记文件，未修改其任何代码。
 *  3. 客户端对 dsh-purge-community（MIT）注入的全屏遮罩做样式回避，未修改其代码。
 * 详见 THIRD-PARTY-NOTICES.md §2.3 / §4.1
 */
/**
 * dsh-agent-core —— Hermes 对标层（通道无关：具体平台由 adapters/ 注入）
 *
 * 对标 Hermes 的六件事，用 DSH 插件能拿到的原语实现（不碰 dsh-bili-whale）：
 *   1. Prompt tiers     → lib/tiers.mjs 产 context/volatile 两层，写 prompt.txt
 *   2. Memory retrieval → lib/memory.mjs 建倒排索引，HTTP 可查（/search）
 *   3. Lineage          → 记录会话 id 变化（谁接替谁、为什么）
 *   4. Observability    → /status 返回心跳、看门狗、索引、DSH 版本
 *   5. Cron tick        → 5 分钟重建 volatile，每天重建索引
 *   6. Trace            → /trace 返回最近一轮的工具调用摘要（来自会话日志）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { buildAll } from './tiers.mjs'
import { buildIndex, search } from './memory.mjs'
import { clamp, readJsonSafe, writeAtomic, appendLog, backoffMs } from './util.mjs'
import { loadProvider, listProviders } from './providers.mjs'
import { listSkills } from './skills.mjs'
import { exportSession } from './trajectory.mjs'
import { isDue, runJob, loadJobs, saveState, markRun } from './jobs.mjs'
import { getChannel, splitText } from './channel.mjs'
import { DSH_HOME } from './config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = DSH_HOME
const MEM = path.join(DSH, 'memory')
const CORE = path.join(DSH, 'agent-core')
const INDEX_FILE = path.join(CORE, 'memory-index.json')
const LINEAGE = path.join(CORE, 'lineage.jsonl')
const LOG = path.join(CORE, 'core.log')

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const log = (m) => appendLog(LOG, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}\n`)

/** 抗造版配置：缺字段有默认、越界自动夹紧、坏 JSON 不崩 */
function loadConfig() {
  const raw = readJsonSafe(path.join(CORE, 'config.json'), {}) ?? {}
  return {
    refreshMinutes: clamp(raw.refreshMinutes, 1, 60, 5),
    indexHours: clamp(raw.indexHours, 1, 24, 1),
    searchK: clamp(raw.searchK, 1, 20, 5),
    maxChunkChars: clamp(raw.maxChunkChars, 200, 4000, 800),
    enabled: raw.enabled !== false,
    memoryProvider: String(raw.memoryProvider ?? 'builtin'),
  }
}

/** 心跳探针：每 tick 写一次，外部能一眼看出插件是不是活着 */
function writeAlive(extra = {}) {
  writeAtomic(path.join(CORE, 'alive.json'), JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    session: currentSessionId(),
    indexChunks: idxBuilt?.chunks ?? 0,
    ...extra,
  }) + '\n')
}


/**
 * 当前会话 id —— 由适配器提供（core 不知道会话 id 是怎么存的、存在哪）
 * chatId 的语义："owner" = 跟使用者/主要对象的那条会话；怎么映射是适配器的私活。
 */
function currentSessionId(chatId = 'owner') {
  try { return getChannel().sessionOf(chatId) || '' } catch { return '' }
}

function ensureDirs() { try { fs.mkdirSync(CORE, { recursive: true }) } catch {} }

/**
 * 绑定自愈：会话绑定被上游整条清空时（实测会丢），让适配器自己找回来。
 * 怎么找（扫会话目录 / 读上游状态）是适配器的事，core 只负责叫一声。
 */
function healMapping() {
  try {
    const ch = getChannel()
    return Boolean(ch.sessions?.heal?.('owner', log))
  } catch (e) { log('绑定自愈失败：' + String(e?.message ?? e)); return false }
}

/** 会话血缘：绑定 id 变了就记一条 parent → child */
function trackLineage() {
  const cur = currentSessionId()
  if (!cur) return
  const last = readJson(path.join(CORE, 'lineage-state.json')) ?? {}
  if (last.session === cur) return
  try {
    fs.appendFileSync(LINEAGE, JSON.stringify({
      at: new Date().toISOString(),
      from: last.session ?? null,
      to: cur,
      reason: last.session ? 'session-changed' : 'first-seen',
    }) + '\n')
  } catch {}
  try { fs.writeFileSync(path.join(CORE, 'lineage-state.json'), JSON.stringify({ session: cur, at: new Date().toISOString() })) } catch {}
  log(`lineage: ${last.session ?? '(none)'} → ${cur}`)
}

/** 索引：内存里常驻一份，供 /search 用 */
let idxBuilt = null
function refreshIndex() {
  try {
    idxBuilt = buildIndex(MEM)
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ builtAt: idxBuilt.builtAt, files: idxBuilt.files, chunks: idxBuilt.chunks, index: idxBuilt.index }) + '\n', 'utf8')
    log(`index: ${idxBuilt.files} files / ${idxBuilt.chunks} chunks`)
  } catch (e) { log('index failed: ' + String(e?.message ?? e)) }
}

export default {
  name: 'dsh-agent-core',
  inject: ['webServer'],
  apply(ctx) {
    ensureDirs()
    const cfg = loadConfig()
    log(`插件启动（enabled=${cfg.enabled} refresh=${cfg.refreshMinutes}m index=${cfg.indexHours}h）`)
    if (!cfg.enabled) { log('配置里 disabled，插件不干活'); return }

    // ── 首次构建（任何一步失败都不影响后面的定时）──────────────
    try { buildAll() } catch (e) { log('首次 tiers 失败：' + String(e?.message ?? e)) }
    try { refreshIndex() } catch (e) { log('首次索引失败：' + String(e?.message ?? e)) }
    try { trackLineage() } catch (e) { log('首次血缘失败：' + String(e?.message ?? e)) }
    // healMapping 默认停用：上游的合并补丁才是正解，这里回写旧 id 反而会和上游抢
    writeAlive({ phase: 'boot' })

    // ── 递归 setTimeout：失败就退避，绝不因为一次异常停摆 ────────
    let tiersFailures = 0
    let indexFailures = 0
    let stopped = false
    let timerTiers = null
    let timerIndex = null

    const tickTiers = async () => {
      if (stopped) return
      try {
        buildAll()
        trackLineage()
        // healMapping()  // 停用，理由同上
        writeAlive({ phase: 'tick' })
        tiersFailures = 0
      } catch (e) {
        tiersFailures += 1
        log(`tiers tick 失败(${tiersFailures})：` + String(e?.message ?? e))
      } finally {
        const wait = backoffMs(cfg.refreshMinutes * 60_000, tiersFailures)
        timerTiers = setTimeout(tickTiers, tiersFailures ? wait : cfg.refreshMinutes * 60_000)
      }
    }

    const tickIndex = async () => {
      if (stopped) return
      try {
        refreshIndex()
        writeAlive({ phase: 'index' })
        indexFailures = 0
      } catch (e) {
        indexFailures += 1
        log(`index tick 失败(${indexFailures})：` + String(e?.message ?? e))
      } finally {
        const wait = backoffMs(cfg.indexHours * 3600_000, indexFailures)
        timerIndex = setTimeout(tickIndex, wait)
      }
    }

    timerTiers = setTimeout(tickTiers, cfg.refreshMinutes * 60_000)
    timerIndex = setTimeout(tickIndex, cfg.indexHours * 3600_000)

    // ── 通用任务（Hermes cron 的等价物）：jobs.json + 60 秒 tick ──
    const JOBS_FILE = path.join(CORE, 'jobs.json')
    const JOBS_STATE = path.join(CORE, 'jobs-state.json')
    let timerJobs = null
    let jobsRunning = false

    const tickJobs = async () => {
      if (stopped) return
      try {
        if (jobsRunning) return
        jobsRunning = true
        const jobs = loadJobs(JOBS_FILE)
        let state = readJsonSafe(JOBS_STATE, {}) ?? {}
        for (const job of jobs) {
          if (stopped) break
          if (!isDue(job, state)) continue
          const sid = currentSessionId()
          const result = await runJob(job, {
            log,
            prompt: async (text) => {
              if (!sid) throw new Error('没有会话可投递')
              await ctx.sessionController.prompt({
                requestId: `job-${job.id}-${Date.now()}`,
                sessionId: sid,
                mode: 'queue',
                content: [{ type: 'text', text }],
              }, new AbortController().signal)
            },
          })
          state = markRun(state, job, result)
          saveState(JOBS_STATE, state)
          // deliver=channel：把脚本输出推到通道（prompt 类型的投递已经由投递本身完成）
          if (result.ok && (job.deliver === 'channel' || job.deliver === true) && result.kind === 'script' && result.output) {
            try {
              const ch = getChannel()
              const body = `[job:${job.name}] ${String(result.output).slice(0, 300)}`
              for (const part of splitText(body, ch.limits().maxTextChars)) {
                await ch.send('owner', part)
              }
            } catch (e) { log('job deliver 失败：' + String(e?.message ?? e)) }
          }
        }
      } catch (e) {
        log('jobs tick 失败：' + String(e?.message ?? e))
      } finally {
        jobsRunning = false
        if (!stopped) timerJobs = setTimeout(tickJobs, 60_000)
      }
    }
    timerJobs = setTimeout(tickJobs, 20_000)

    // ── HTTP：状态 / 检索 / 血缘 ────────────────────────────────
    const routes = []
    const route = (kind, p, handler) => {
      try {
        routes.push(ctx.webServer.register({
          kind,
          path: p,
          handler: async (req, res) => {
            const host = String(req.headers?.host ?? '').split(':')[0].toLowerCase()
            if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
              res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: 'loopback only' })); return
            }
            try {
              const body = await handler(req, res)
              if (body === undefined) return
              res.statusCode = 200
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end(JSON.stringify(body, null, 2))
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
            }
          },
        }))
      } catch (e) { log('route failed: ' + String(e?.message ?? e)) }
    }

    route('exact', '/dsh-agent-core/status', async () => {
      const hb = readJson(path.join(DSH, 'heartbeat-state.json'))
      // 通道自己的健康快照：连不上也只是 ok:false，不影响核心状态
      let chProbe = null
      try { chProbe = await getChannel().probe() } catch (e) { chProbe = { ok: false, detail: String(e?.message ?? e) } }
      return {
        ok: true,
        channel: getChannel().label,
        channelProbe: chProbe,
        session: currentSessionId(),
        heartbeat: hb,
        index: idxBuilt ? { builtAt: idxBuilt.builtAt, files: idxBuilt.files, chunks: idxBuilt.chunks } : null,
        prompt: (() => { const p = readJson(path.join(CORE, 'prompt.json')); return p ? { builtAt: p.builtAt, chars: p.composed.length } : null })(),
        patches: (() => {
          try {
            const dirs = fs.readdirSync(path.join(DSH, 'patches')).filter((d) => fs.existsSync(path.join(DSH, 'patches', d, 'manifest.json')))
            return dirs.map((d) => {
              const m = readJson(path.join(DSH, 'patches', d, 'manifest.json'))
              return { pkg: m.pkg, version: m.version, files: m.files.length }
            })
          } catch { return [] }
        })(),
      }
    })

    // ── 参数调试：读/写心跳与 core 的配置（只接受已知键，越界自动夹紧）──
    route('exact', '/dsh-agent-core/config', async (req) => {
      const hbFile = path.join(DSH, 'heartbeat.config.json')
      if (String(req.method).toUpperCase() === 'GET') {
        const hb = readJson(hbFile) ?? {}
        return { ok: true, heartbeat: hb, core: loadConfig() }
      }
      const raw = await new Promise((resolve) => {
        let d = ''
        req.on('data', (c) => { d += c; if (d.length > 16384) d = d.slice(0, 16384) })
        req.on('end', () => resolve(d || '{}'))
        req.on('error', () => resolve('{}'))
      })
      let body = {}
      try { body = JSON.parse(raw) } catch { return { ok: false, error: 'bad json' } }
      const cur = readJson(hbFile) ?? {}
      const next = { ...cur }
      if (body.heartbeat && typeof body.heartbeat === 'object') {
        const h = body.heartbeat
        if (h.intervalSec !== undefined) next.intervalSec = clamp(h.intervalSec, 60, 86400, cur.intervalSec ?? 14400)
        if (h.jitterSec !== undefined) next.jitterSec = clamp(h.jitterSec, 0, 7200, cur.jitterSec ?? 1200)
        if (Array.isArray(h.quietHours)) next.quietHours = h.quietHours.map((n) => clamp(n, 0, 23, 1)).slice(0, 2)
        if (h.enabled !== undefined) next.enabled = h.enabled === true
        if (h.testEcho !== undefined) next.testEcho = h.testEcho === true
        if (h.diary && typeof h.diary === 'object') {
          next.diary = { ...(cur.diary ?? {}) }
          if (h.diary.hour !== undefined) next.diary.hour = clamp(h.diary.hour, 0, 23, 23)
          if (h.diary.minute !== undefined) next.diary.minute = clamp(h.diary.minute, 0, 59, 40)
          if (h.diary.enabled !== undefined) next.diary.enabled = h.diary.enabled === true
          // 早期 新增的日记选项
          if (h.diary.style !== undefined) next.diary.style = String(h.diary.style).slice(0, 20)
          if (h.diary.maxChars !== undefined) next.diary.maxChars = clamp(h.diary.maxChars, 100, 4000, 700)
          if (h.diary.topics !== undefined) next.diary.topics = String(h.diary.topics).slice(0, 200)
          if (h.diary.pushWhenDone !== undefined) next.diary.pushWhenDone = h.diary.pushWhenDone === true
          if (h.diary.customPrompt !== undefined) next.diary.customPrompt = String(h.diary.customPrompt).slice(0, 4000)
          if (h.diary.forceNow !== undefined) next.diary.forceNow = h.diary.forceNow === true
        }
        // 心跳提示词也可以由用户改（空 = 用内置默认）
        if (h.prompt !== undefined) {
          const p = String(h.prompt).slice(0, 8000)
          if (p.trim()) next.prompt = p
          else delete next.prompt
        }
        // 日记推送窗口（面板上可调：从几点到几点之间随机挑一分钟推「给他看」）
        if (h.diaryPush && typeof h.diaryPush === 'object') {
          next.diaryPush = { ...(cur.diaryPush ?? {}) }
          if (h.diaryPush.enabled !== undefined) next.diaryPush.enabled = h.diaryPush.enabled === true
          if (h.diaryPush.startMinute !== undefined) next.diaryPush.startMinute = clamp(h.diaryPush.startMinute, 0, 1439, 1430)
          if (h.diaryPush.endMinute !== undefined) next.diaryPush.endMinute = clamp(h.diaryPush.endMinute, 0, 1439, 1438)
        }
      }
      const wrote = writeAtomic(hbFile, JSON.stringify(next, null, 2) + '\n')
      if (body.core && typeof body.core === 'object') {
        const c = { ...loadConfig(), ...body.core }
        writeAtomic(path.join(CORE, 'config.json'), JSON.stringify({
          enabled: c.enabled !== false,
          refreshMinutes: clamp(c.refreshMinutes, 1, 60, 5),
          indexHours: clamp(c.indexHours, 1, 24, 1),
          searchK: clamp(c.searchK, 1, 20, 5),
          maxChunkChars: clamp(c.maxChunkChars, 200, 4000, 800),
        }, null, 2) + '\n')
      }
      log('控制台改配置：' + JSON.stringify(body).slice(0, 200))
      return { ok: wrote, heartbeat: next }
    })

    // ── B 站控制台（早期）：读/写巡检那份配置，独立于巡检页面 ──
    //   巡检（设置 → 巡检）是插件自己的界面，一个字没动；
    //   这里是我们 Agent Core 控制台里的 B 站页，读写的是同一份 ~/.dsh/bili-whale.config.json。
    const BILI_CFG = path.join(DSH, 'bili-whale.config.json')
    const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
    const readBiliCfg = () => readJsonSafe(BILI_CFG) ?? {}
    const KNOWN_BILI = new Set(['scheduler', 'persona', 'preferences', 'owner', 'self', 'quota', 'share', 'listen', 'diary', 'night', 'home', 'toolsPath'])

    // 体检：代跑 bili.mjs deps --json（走本机 loopback，不受插件信任栅栏影响）
    route('exact', '/dsh-agent-core/bili/deps', () => {
      const cfg = readBiliCfg()
      const tools = cfg.toolsPath
        ? path.join(cfg.toolsPath, fs.existsSync(path.join(cfg.toolsPath, 'bili.mjs')) ? 'bili.mjs' : '')
        : path.join(DSH, 'plugins', 'dsh-bili-whale', 'tools', 'bili.mjs')
      const target = fs.existsSync(tools) ? tools : path.join(DSH, 'plugins', 'dsh-bili-whale', 'tools', 'bili.mjs')
      if (!fs.existsSync(target)) return { ok: false, error: '找不到 bili.mjs：' + target }
      // ：deps 有「不通过项」时是**非零退出**（比如生物钟关着），
      //   execFileSync 会直接抛 → 体检整块报错。改成 spawnSync：拿到 stdout 就解析，
      //   并且把「生物钟关着」当成正常状态（是我们主动关的）。
      try {
        const r = spawnSync(process.execPath, [target, 'deps', '--json'], { timeout: 60000, windowsHide: true, encoding: 'utf8' })
        const raw = String(r.stdout || '').trim()
        let parsed = null
        try { parsed = JSON.parse(raw) } catch {}
        if (!parsed) return { ok: false, error: 'deps 没有返回 JSON：' + String(r.stderr || '').slice(0, 200), items: [] }
        // 早期：生物钟这一项由**我们**重新判定，别信 deps 的报警。
        //   deps 只会看「计划时间过了没」，而关着的时候计划必然过期 → 恢复后它仍喊旧计划。
        //   真实判据：① 总开关开没开 ② whale-night.json 还在不在被 tick 写（60 秒一次）
        const biliCfg = readBiliCfg() || {}
        const schOff = biliCfg.scheduler?.enabled === false
        let schSnap = null
        try { schSnap = JSON.parse(fs.readFileSync(path.join(DSH, 'whale-night.json'), 'utf8')) } catch {}
        let schFresh = false
        try { schFresh = (Date.now() - fs.statSync(path.join(DSH, 'whale-night.json')).mtimeMs) < 300000 } catch {}
        const items = (parsed.items ?? []).map((it) => {
          if (!/生物钟|调度器/.test(String(it.name || ''))) return it
          if (schOff) return { ...it, ok: true, detail: '已关闭（总开关关着；想开就在这一页打开）' }
          if (schFresh) {
            const next = schSnap?.atText ? (' · 计划 ' + schSnap.atText) : ''
            const wakes = schSnap?.wakes != null ? (' · 今日已醒 ' + schSnap.wakes + ' 次') : ''
            return { ...it, ok: true, detail: '运行中（每 60 秒 tick）' + wakes + next }
          }
          return it
        })
        let self = null
        try {
          const ck = items.find((it) => it.name === 'B站 cookie')
          const m = String(ck?.detail ?? '').match(/已登录：(.+?)（mid (\d+)）/i)
          if (m) self = { name: m[1], mid: m[2] }
        } catch {}
        const ok = items.every((it) => it.ok !== false)
        return { ok, items, self, node: parsed.node ?? null }
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 300), items: [] }
      }
    })
    route('exact', '/dsh-agent-core/bili/settings', (req) => {
      const cfg = readBiliCfg()
      if (req.method === 'GET') {
        const night = readJsonSafe(path.join(DSH, 'whale-night.json'))
        const quota = readJsonSafe(path.join(HOME, '.bili-ai', 'quota.json')) ?? { log: [] }
        const today = new Date().toLocaleDateString('sv-SE')
        const todays = (quota.log ?? []).filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today)
        return {
          ok: true,
          config: cfg,
          configPath: BILI_CFG,
          status: {
            schedulerEnabled: cfg?.scheduler?.enabled !== false,
            plan: night ? { action: night.action, atText: night.atText ?? null, wakes: night.wakes ?? 0 } : null,
            shares: todays.filter((x) => x.share).length,
            sharesMax: cfg?.quota?.shareDaily ?? 3,
            commentsToday: todays.length,
          },
        }
      }
      return undefined
    })

    route('exact', '/dsh-agent-core/bili/settings-save', (req) => {
      // POST 走单独路径，避免与 GET 同路径抢匹配
      if (req.method !== 'POST') return { ok: false, error: 'POST only' }
      const chunks = []
      return new Promise((resolve) => {
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const incoming = body?.config && typeof body.config === 'object' ? body.config : body
            const cur = readBiliCfg()
            delete cur.__hasUserFile
            const filtered = {}
            for (const [k, v] of Object.entries(incoming || {})) if (KNOWN_BILI.has(k)) filtered[k] = v
            const next = { ...cur, ...filtered }
            // 校验：作息窗口时间 + 数值范围（和巡检页同口径，别写出让生物钟算不出下次唤醒的值）
            const n = next.night ?? {}
            if (Array.isArray(n.windows) && n.windows.length) {
              for (const [i, w] of n.windows.entries()) {
                const ok = (s) => typeof s === 'string' && /^(\d|0\d|1\d|2[0-3]):[0-5]\d$/.test(s)
                if (!ok(w?.start) || !ok(w?.end)) return resolve({ ok: false, error: '第 ' + (i + 1) + ' 个窗口时间要 HH:MM' })
                if (w.start === w.end) return resolve({ ok: false, error: '第 ' + (i + 1) + ' 个窗口起止相同，永远不会醒' })
                w.wakes = Math.min(12, Math.max(1, Number(w.wakes) || 1))
              }
            }
            n.maxWakesPerDay = Math.min(12, Math.max(0, Number(n.maxWakesPerDay ?? 0) || 0))
            n.skipChance = Math.min(0.95, Math.max(0, Number(n.skipChance) || 0))
            n.minGapMin = Math.max(1, Number(n.minGapMin) || 10)
            n.maxVideos = Math.min(20, Math.max(1, Number(n.maxVideos) || 5))
            next.night = n
            next.quota = next.quota ?? {}
            next.quota.shareDaily = Math.min(20, Math.max(0, Number(next.quota.shareDaily ?? 3) || 0))
            fs.writeFileSync(BILI_CFG, JSON.stringify(next, null, 2) + '\n', 'utf8')
            resolve({ ok: true, config: next, configPath: BILI_CFG, note: '已写入（立即生效的字段下一轮 tick 就按新值跑）' })
          } catch (e) {
            resolve({ ok: false, error: String(e?.message ?? e) })
          }
        })
      })
    })

    // ── 独立控制台页面：不依赖客户端 bundle，浏览器直接打开 ──
    //   前端在 lib/panel.html（按 mtime 读，改页面不用重启宿主）
    route('exact', '/dsh-agent-core/panel', (req, res) => {
      const file = path.join(DSH, 'plugins', 'dsh-agent-core', 'lib', 'panel.html')
      const html = (() => { try { return fs.readFileSync(file, 'utf8') } catch { return '<h1>panel.html missing</h1>' } })()
      try {
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(html)
      } catch {}
      return undefined
    })

    // ── 规则体检（直接跑 checks.mjs，把差异集合拿回来）──
    route('exact', '/dsh-agent-core/checks', () => {
      try {
        const out = execFileSync(process.execPath, [path.join(DSH, 'bili-whale', 'checks.mjs'), '--json'], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
        return { ok: true, ...JSON.parse(out) }
      } catch (e) {
        const txt = String(e?.stdout ?? '')
        try { return { ok: false, ...JSON.parse(txt) } } catch { return { ok: false, error: String(e?.message ?? e) } }
      }
    })

    // 通用任务：列表 + 上次运行
    route('exact', '/dsh-agent-core/jobs', () => ({
      ok: true,
      jobs: loadJobs(path.join(CORE, 'jobs.json')),
      state: readJsonSafe(path.join(CORE, 'jobs-state.json'), {}) ?? {},
    }))

    // ── 日志尾巴（控制台直接看，不用去翻文件）──
    route('exact', '/dsh-agent-core/logs', (req) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      const which = u.searchParams.get('name') ?? 'core'
      const map = {
        core: path.join(CORE, 'core.log'),
        heartbeat: path.join(DSH, 'heartbeat.log'),
        restart: path.join(CORE, 'restart.log'),
        checks: path.join(CORE, 'checks.log'),
        channel: String(getChannel().logs?.() ?? path.join(DSH, 'channel.log')),
      }
      const file = map[which] ?? map.core
      const lines = (() => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-120) } catch { return [] } })()
      return { ok: true, name: which, file, lines }
    })

    let activeProvider = null
    const providerReady = (async () => { activeProvider = await loadProvider((loadConfig().memoryProvider || 'builtin'), { index: buildIndex, search }) })()

    route('exact', '/dsh-agent-core/search', async (req) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      const q = u.searchParams.get('q') ?? ''
      const k = Number(u.searchParams.get('k') ?? 5)
      if (!idxBuilt) refreshIndex()
      try { await providerReady } catch {}
      const fn = activeProvider?.search ?? search
      const hits = idxBuilt ? fn(idxBuilt, q, k) : []
      return {
        ok: true, q, provider: activeProvider?.name ?? 'builtin',
        hits: hits.map((h) => ({ score: h.score, file: h.file, heading: h.heading, text: h.text.slice(0, 400) })),
      }
    })

    // skills 目录（Hermes 的 skills 索引）
    route('exact', '/dsh-agent-core/skills', () => ({ ok: true, skills: listSkills(path.join(CORE, 'skills')) }))

    // 记忆 provider 列表
    route('exact', '/dsh-agent-core/providers', () => ({ ok: true, providers: listProviders(), active: activeProvider?.name ?? 'builtin', fallback: activeProvider?.fallback ?? null }))

    // 轨迹导出：把某个会话转成 ShareGPT JSONL（POST {session}）
    route('exact', '/dsh-agent-core/trajectory', async (req) => {
      if (String(req.method).toUpperCase() !== 'POST') return { ok: false, error: 'POST only' }
      const raw = await new Promise((resolve) => {
        let d = ''
        req.on('data', (c) => { d += c; if (d.length > 4096) d = d.slice(0, 4096) })
        req.on('end', () => resolve(d || '{}'))
        req.on('error', () => resolve('{}'))
      })
      let body = {}
      try { body = JSON.parse(raw) } catch { body = {} }
      const sid = String(body.session ?? currentSessionId())
      if (!sid) return { ok: false, error: '没有会话 id' }
      const dir = path.join(DSH, 'sessions', '--' + String(MEM).replace(/[:\\/]/g, '-') + '--', sid)
      const r = exportSession(dir, sid)
      log('轨迹导出：' + JSON.stringify(r).slice(0, 160))
      return r
    })

    route('exact', '/dsh-agent-core/lineage', () => {
      let lines = []
      try { lines = fs.readFileSync(LINEAGE, 'utf8').trim().split('\n').filter(Boolean).slice(-20).map((l) => JSON.parse(l)) } catch {}
      return { ok: true, lineage: lines }
    })

    // ── 控制台用的两个接口：看三层原文 / 手动动作 ─────────────────
    route('exact', '/dsh-agent-core/tiers', () => {
      const p = readJsonSafe(path.join(CORE, 'prompt.json'), {}) ?? {}
      return { ok: true, builtAt: p.builtAt ?? null, context: p.context ?? '', volatile: p.volatile ?? '', volatileFull: p.volatileFull ?? '', stable: p.stable ?? null }
    })

    route('exact', '/dsh-agent-core/act', async (req) => {
      if (String(req.method).toUpperCase() !== 'POST') return { ok: false, error: 'POST only' }
      const raw = await new Promise((resolve) => {
        let d = ''
        req.on('data', (c) => { d += c; if (d.length > 8192) { d = d.slice(0, 8192) } })
        req.on('end', () => resolve(d || '{}'))
        req.on('error', () => resolve('{}'))
      })
      let body = {}
      try { body = JSON.parse(raw) } catch { body = {} }
      const cmd = String(body.cmd ?? '')
      try {
        if (cmd === 'rebuild') { buildAll(); refreshIndex(); writeAlive({ phase: 'manual-rebuild' }); return { ok: true, cmd } }
        if (cmd === 'index') { refreshIndex(); writeAlive({ phase: 'manual-index' }); return { ok: true, cmd, chunks: idxBuilt?.chunks ?? 0 } }
        if (cmd.startsWith('restart-')) {
          const mode = cmd.replace('restart-', '')
          if (!['dsh', 'channel', 'both'].includes(mode)) return { ok: false, error: 'mode?' }
          const script = path.join(DSH, 'bili-whale', 'restart.mjs')
          const { spawn } = await import('node:child_process')
          const child = spawn(process.execPath, [script, '--mode', mode, '--reason', 'console'], { detached: true, stdio: 'ignore', windowsHide: true })
          child.unref()
          log(`控制台请求重启：${mode}（pid ${child.pid}）`)
          return { ok: true, cmd, mode, dispatched: true }
        }
        return { ok: false, error: 'unknown cmd' }
      } catch (e) {
        log(`act ${cmd} 失败：` + String(e?.message ?? e))
        return { ok: false, error: String(e?.message ?? e) }
      }
    })

    ctx.effect(() => () => {
      stopped = true
      if (timerTiers) clearTimeout(timerTiers)
      if (timerIndex) clearTimeout(timerIndex)
      if (timerJobs) clearTimeout(timerJobs)
      for (const d of routes) { try { d?.() } catch {} }
      log('插件停止')
    })
  },
}
