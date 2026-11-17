/**
 * adapters/onebot/index.mjs —— OneBot 11 / NapCat 适配器
 *
 * 实现 core/lib/channel.mjs 的契约，让核心层不用知道 QQ 的存在：
 *   receive(handler) 收消息 → 归一成标准事件
 *   send(chatId,text) 发文本
 *   sendMedia(chatId,files) 发图 / 发语音 / 发文件
 *   resolveIdentity(raw) 认人（谁是使用者、谁是机器人自己）
 *   limits() 平台限额
 *
 * 用法（宿主里）：
 *   import { registerChannel } from '@agent/core/lib/channel.mjs'
 *   import onebotAdapter from './adapters/onebot/index.mjs'
 *   registerChannel(onebotAdapter)
 *
 * 只走 OneBot 11 的 HTTP API + 正向 WebSocket，不需要额外依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { onebot, PLACEHOLDER, warnIfIncomplete } from './config.mjs'
import * as sessions from './sessions.mjs'

const TIMEOUT_MS = 15_000

function unset(v) {
  const s = String(v ?? '').trim()
  return !s || /^\{\{[A-Z_]+\}\}$/.test(s) || s.startsWith('填')
}

/** 调 OneBot HTTP API */
async function call(action, params = {}) {
  if (unset(onebot.token)) throw new Error('onebot: 没有 token，先在 agent.config.json 的 onebot.token 里填')
  const url = onebot.apiBase + '/' + action
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(unset(onebot.token) ? {} : { authorization: 'Bearer ' + onebot.token }),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('onebot ' + action + ' HTTP ' + res.status)
  const body = await res.json()
  if (body?.status === 'failed' || (body?.retcode !== undefined && body.retcode !== 0)) {
    throw new Error('onebot ' + action + ' 失败：' + (body?.message ?? body?.wording ?? JSON.stringify(body).slice(0, 160)))
  }
  return body?.data ?? body
}

/** chatId → {kind:'group'|'private', id} */
function target(chatId) {
  const s = String(chatId ?? '').trim()
  if (s === 'owner' || s === 'master' || !s) return { kind: 'private', id: onebot.ownerQQ }
  if (s.startsWith('group:')) return { kind: 'group', id: s.slice(6) }
  if (s.startsWith('private:')) return { kind: 'private', id: s.slice(8) }
  return { kind: 'private', id: s }
}

/** 发一条消息（自动按群/私聊选 action） */
async function sendRaw(chatId, message) {
  const t = target(chatId)
  if (t.kind === 'group') return call('send_group_msg', { group_id: Number(t.id), message })
  return call('send_private_msg', { user_id: Number(t.id), message })
}

function segmentFor(file) {
  const abs = path.resolve(String(file))
  if (!fs.existsSync(abs)) throw new Error('onebot: 文件不存在 ' + abs)
  const ext = path.extname(abs).toLowerCase()
  const data = { file: 'file:///' + abs.replace(/\\/g, '/') }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return { type: 'image', data }
  if (['.mp3', '.wav', '.amr', '.silk', '.ogg', '.flac'].includes(ext)) return { type: 'record', data }
  return { type: 'file', data }
}

const adapter = {
  label: 'onebot',

  // ── 契约：收消息 ────────────────────────────────────────────
  /**
   * 订阅 OneBot 事件，把平台消息归一化成标准事件：
   *   { chatId, userId, text, media, at, raw }
   * 返回一个 unsubscribe 函数。
   */
  async receive(handler) {
    if (typeof handler !== 'function') throw new Error('onebot.receive: 需要 handler 函数')
    if (typeof WebSocket === 'undefined') throw new Error('onebot.receive: 当前 Node 没有全局 WebSocket（需要 >= 22）')
    const ws = new WebSocket(onebot.wsBase + '/event', unset(onebot.token) ? undefined : { headers: { authorization: 'Bearer ' + onebot.token } })
    ws.addEventListener('message', (ev) => {
      let data
      try { data = JSON.parse(String(ev.data)) } catch { return }
      if (data?.post_type !== 'message') return
      const isGroup = data.message_type === 'group'
      const chatId = isGroup ? 'group:' + data.group_id : 'private:' + data.user_id
      const segs = Array.isArray(data.message) ? data.message : []
      const text = segs.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('')
      const media = segs.filter((s) => s.type !== 'text').map((s) => ({ type: s.type, data: s.data ?? {} }))
      try {
        Promise.resolve(handler({
          chatId,
          userId: String(data.user_id ?? ''),
          text,
          media,
          at: new Date(),
          raw: data,
        })).catch(() => {})
      } catch {}
    })
    ws.addEventListener('error', () => {})
    return () => { try { ws.close() } catch {} }
  },

  // ── 契约：发文本 ────────────────────────────────────────────
  async send(chatId, text, opts = {}) {
    const body = [{ type: 'text', data: { text: String(text ?? '') } }]
    if (opts.at) body.unshift({ type: 'at', data: { qq: String(opts.at) } })
    return sendRaw(chatId, body)
  },

  // ── 契约：发媒体 ────────────────────────────────────────────
  async sendMedia(chatId, files) {
    const list = Array.isArray(files) ? files : [files]
    const out = []
    for (const f of list) {
      if (!f) continue
      out.push(await sendRaw(chatId, [segmentFor(f)]))
    }
    return out
  },

  // ── 契约：认人 ──────────────────────────────────────────────
  resolveIdentity(raw) {
    const id = String(raw?.userId ?? raw?.user_id ?? raw?.id ?? raw?.from ?? raw ?? '')
    const isOwner = id && id === onebot.ownerQQ
    const isSelf = id && id === onebot.botQQ
    return {
      id,
      name: String(raw?.sender?.card || raw?.sender?.nickname || raw?.name || id || 'unknown'),
      isOwner,
      isSelf,
      label: isOwner ? 'owner' : isSelf ? 'self' : (raw?.name || id || 'guest'),
    }
  },

  // ── 契约：限额 ──────────────────────────────────────────────
  limits() {
    return {
      maxTextChars: 1800,             // OneBot 单条文本的稳妥上限
      maxMediaBytes: 30 * 1024 * 1024,
      minIntervalMs: 1200,            // 别把网关打爆
      maxMediaCount: 9,
    }
  },

  // ── 可选扩展 ────────────────────────────────────────────────
  sessionOf(chatId = 'owner') { return sessions.get(chatId) },

  sessions: {
    get: sessions.get,
    set: sessions.set,
    heal: sessions.heal,
    newest: sessions.newest,
    lastActivityMs: sessions.lastActivityMs,
    root: sessions.sessionRoot,
  },

  mediaDir() { return onebot.mediaDir },

  /** 健康快照，core 的 /status 直接透传 */
  async probe() {
    const out = { channel: 'onebot', api: onebot.apiBase, ok: false }
    try {
      const login = await call('get_login_info', {})
      out.ok = true
      out.login = { userId: String(login?.user_id ?? ''), nickname: String(login?.nickname ?? '') }
    } catch (e) {
      out.detail = String(e?.message ?? e).slice(0, 200)
    }
    try {
      const q = path.join(onebot.mediaDir, 'group-quota.json')
      out.quota = JSON.parse(fs.readFileSync(q, 'utf8'))
    } catch {}
    try {
      const s = path.join(onebot.mediaDir, 'group-owner-seen.json')
      const seen = JSON.parse(fs.readFileSync(s, 'utf8'))
      out.groupsSeen = Object.keys(seen).length
    } catch {}
    return out
  },

  /** 平台特有的提示词小抄：核心层不认识这些工具，由适配器提供 */
  hints() {
    const tool = (name) => path.join(process.env.AGENT_TOOLS_DIR || path.join(onebot.mediaDir, '..', '..', 'bili-whale'), name)
    return [
      '   - 顺手刷一眼他的空间（脚本自己掷骰，有概率）：`node ' + tool('qzone-heartbeat.mjs') + '`',
      '     - `STATE=NO_NEW` / `SKIP_ROLL` → 什么都不做；`LIKED` → 看 `CAND` 行，真有话说才评论',
      '     - `REPLY_CAND` → 有人留言，必须回：`node ' + tool('qzone.mjs') + ' reply <postTid> <cid> <uin> "你的话" --go`',
      '   - 纪念日：`node ' + tool('occasion.mjs') + ' check`；新增：`--name "…" --note "…" --go`',
    ]
  },
}

warnIfIncomplete()

export default adapter
export { adapter, onebot, PLACEHOLDER, call }
