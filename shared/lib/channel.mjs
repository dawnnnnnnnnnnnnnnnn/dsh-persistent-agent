/**
 * channel.mjs —— 通道适配器契约（core 只认这个文件，不认任何具体平台）
 *
 *   receive(handler)         收消息
 *   send(chatId, text)       发文本
 *   sendMedia(chatId, files) 发媒体
 *   resolveIdentity(raw)     认人 → { id, name, isOwner, isSelf, label }
 *   limits()                 限额 → { maxTextChars, maxMediaBytes, minIntervalMs }
 *
 * 具体平台（OneBot / NapCat、Discord、Telegram…）在 adapters/<name>/ 里实现，
 * 再 registerChannel() 注册。core 不 import 任何平台客户端。
 *
 * 可选扩展（有就用，没有核心降级）：
 *   label / sessionOf(id) / sessions.* / probe() / hints() / mediaDir() / logs()
 */
export const CONTRACT_VERSION = '1.0.0'

/** 契约要求的方法（缺一个就不合格） */
export const REQUIRED = ['receive', 'send', 'sendMedia', 'resolveIdentity', 'limits']

/** 校验适配器实现；不合格抛错并指明缺什么 */
export function defineChannel(impl, meta = {}) {
  if (!impl || typeof impl !== 'object') throw new Error('channel: 实现必须是一个对象')
  const missing = REQUIRED.filter((m) => typeof impl[m] !== 'function')
  if (missing.length) {
    throw new Error('channel: 适配器缺方法 ' + missing.join(', ') + '（契约 v' + CONTRACT_VERSION + '）')
  }
  const lim = impl.limits()
  if (!lim || typeof lim !== 'object') throw new Error('channel: limits() 必须返回对象')
  return Object.freeze({ ...impl, contract: CONTRACT_VERSION, label: impl.label || meta.label || 'chat' })
}

let _channel = null

export function registerChannel(impl, meta) {
  _channel = defineChannel(impl, meta)
  return _channel
}

export function hasChannel() { return _channel !== null }

/** 拿适配器；没注册时返回空通道，调用方不用到处判空 */
export function getChannel() { return _channel ?? NULL_CHANNEL }

const NULL_CHANNEL = {
  contract: CONTRACT_VERSION,
  label: 'none',
  async receive() { return () => {} },
  async send() { throw new Error('channel: 没有注册适配器，消息发不出去（见 adapters/README.md）') },
  async sendMedia() { throw new Error('channel: 没有注册适配器，媒体发不出去') },
  resolveIdentity(raw) {
    const id = String(raw?.id ?? raw?.userId ?? raw?.from ?? raw ?? '')
    return { id, name: id || 'unknown', isOwner: false, isSelf: false, label: id || 'unknown' }
  },
  limits() { return { maxTextChars: 1800, maxMediaBytes: 20 * 1024 * 1024, minIntervalMs: 1200 } },
  sessionOf() { return '' },
  sessions: { get: () => '', set: () => false, heal: () => false, newest: () => '', lastActivityMs: () => 0 },
  probe() { return { channel: 'none', ok: false, detail: '没有注册适配器' } },
  hints() { return [] },
  mediaDir() { return '' },
  logs() { return '' },
}

/** 按通道上限切长文本 */
export function splitText(text, max) {
  const s = String(text ?? '')
  const limit = Number(max) > 0 ? Number(max) : 1800
  if (s.length <= limit) return [s]
  const out = []
  let rest = s
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
