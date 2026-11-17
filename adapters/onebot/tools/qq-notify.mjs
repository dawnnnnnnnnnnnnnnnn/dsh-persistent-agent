#!/usr/bin/env node
/**
 * 把本通道的推送发到 QQ —— 走本机 NapCat 的 OneBot 11 HTTP 接口。
 *
 * 谁调它：dsh-bili-whale 的 notify.mjs（配置里 notify.type = "command"）
 *   cmd  = node
 *   args = ["{{DSH_HOME}}\\bili-whale\\qq-notify.mjs", "--to", "{{OWNER_QQ}}"]
 *   消息由 notify.mjs 自动作为**最后一个参数**追加（同时也在环境变量 WHALE_NOTIFY_TEXT 里）
 *
 * 也可以手动跑：
 *   node qq-notify.mjs "随便一句话"
 *   node qq-notify.mjs --to {{OWNER_QQ}} --title 巡检 "今天看了两条"
 *   node qq-notify.mjs --group 123456789 "发到群"
 *   node qq-notify.mjs --check            # 只检查 NapCat 通不通、当前登录的是哪个号
 *
 * 依赖：本机 NapCat 开着，且 onebot11 配置里 httpServers 启用（现在就是 127.0.0.1:5700）。
 */

const DEFAULTS = {
  api: 'http://127.0.0.1:5700',
  token: onebot.token,
  to: onebot.ownerQQ,   // 使用者 QQ（adminUsers）
}

const argv = process.argv.slice(2)
const pick = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

const api = (pick('api') ?? process.env.QQ_NOTIFY_API ?? DEFAULTS.api).replace(/\/+$/, '')
const token = pick('token') ?? process.env.QQ_NOTIFY_TOKEN ?? DEFAULTS.token
const to = String(pick('to') ?? process.env.QQ_NOTIFY_TO ?? DEFAULTS.to)
const group = pick('group') ? String(pick('group')) : ''
const title = pick('title') ?? process.env.WHALE_NOTIFY_TITLE ?? ''

// 消息正文：优先 --msg，其次环境变量（notify.mjs 会塞），最后取最后一个非开关参数
const msgArg = pick('msg')
let text = msgArg ?? process.env.WHALE_NOTIFY_TEXT ?? ''
if (!text) {
  const skip = new Set()
  for (const flag of ['--to', '--group', '--api', '--token', '--title', '--msg']) {
    const i = argv.indexOf(flag)
    if (i >= 0) { skip.add(i); skip.add(i + 1) }
  }
  const last = argv.map((a, i) => ({ a, i })).filter(({ a, i }) => !skip.has(i) && !a.startsWith('--')).pop()
  text = last?.a ?? ''
}
text = String(text).trim()

/** NapCat 的鉴权：Header Bearer 和 access_token 查询参数两种都试，哪个通算哪个 */
async function call(action, params) {
  const url = `${api}/${action}`
  const body = JSON.stringify(params)
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  let r = await fetch(url, { method: 'POST', headers, body })
  if (r.status === 401 || r.status === 403) {
    r = await fetch(`${url}?access_token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  }
  const raw = await r.text()
  let j = null
  try { j = JSON.parse(raw) } catch { /* 非 JSON */ }
  return { status: r.status, ok: r.ok, json: j, raw }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 长消息切块（QQ 单条有上限，且太长的摘要没人看） */
function chunks(s, size = 900) {
  const out = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out.length ? out : ['']
}

if (has('check')) {
  const info = await call('get_login_info', {})
  console.log('NapCat:', api)
  console.log('retcode:', info.json?.retcode, 'status:', info.status)
  console.log('登录号:', JSON.stringify(info.json?.data ?? info.raw.slice(0, 200)))
  process.exit(info.json?.retcode === 0 ? 0 : 1)
}

if (!text) {
  console.error('没有消息正文。用法: node qq-notify.mjs "要发的话"  |  --check')
  process.exit(2)
}

const full = title ? `【${title}】\n${text}` : text
const parts = chunks(full)
let sent = 0
for (const part of parts) {
  const params = group
    ? { group_id: Number(group), message: [{ type: 'text', data: { text: part } }] }
    : { user_id: Number(to), message: [{ type: 'text', data: { text: part } }] }
  const action = group ? 'send_group_msg' : 'send_private_msg'
  const r = await call(action, params)
  const retcode = r.json?.retcode
  if (retcode !== 0) {
    console.error(`✗ 发送失败（${action}）HTTP ${r.status} retcode=${retcode} ${r.raw.slice(0, 300)}`)
    process.exit(1)
  }
  sent += 1
  if (parts.length > 1) await sleep(400)
}

console.log(`✓ 已推送到 QQ${group ? `群 ${group}` : ` ${to}`}（${sent} 条，${full.length} 字）`)
