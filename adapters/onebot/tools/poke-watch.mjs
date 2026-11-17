#!/usr/bin/env node
/**
 * poke-watch.mjs —— 接住「戳一戳」，使用者戳我我就回。
 *
 * 背景：dsh-im 的 onebot 通道不转发 notice 事件，所以戳一戳根本到不了会话里。
 * 这个脚本自己连 NapCat 额外开的那个 WebSocket（onebot11 配置里叫 poke-watch，5701），
 * 只听 notice/poke，改完不回 DSH —— 直接打 HTTP 接口干活。
 *
 * 规则（（可自定义））：
 *   - 私聊：他戳我 → 必须戳回去（表情包可有可无）
 *   - 群里：他戳我 → 必须回一张表情包
 *   - 别人戳我 → 不理
 *
 * 由计划任务 PokeWatch 在登录时拉起，脚本自己重连，挂了重连就行。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { onebot } from '../config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const LOG = path.join(DSH, 'bili-whale', 'poke-watch.log')
const STICKERS = path.join(DSH, 'bili-whale', 'stickers')

const API = process.env.QQ_API || 'http://127.0.0.1:5700'
const TOKEN = process.env.QQ_API_TOKEN || onebot.token
const WS = process.env.POKE_WS || `ws://127.0.0.1:5701/?access_token=${encodeURIComponent(TOKEN)}`

const OWNER = onebot.ownerQQ      // 只有他是使用者
const SELF = onebot.botQQ       // 我自己
const MAX_STICKER = 1024 * 1024 // 大 gif 发不出去，挑 1MB 以内的

function log(m) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}\n`)
  } catch {}
}

async function call(action, params) {
  try {
    const r = await fetch(`${API}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(params),
    })
    const j = await r.json().catch(() => null)
    return j
  } catch (e) {
    log(`${action} 挂了：${e.message}`)
    return null
  }
}

function pickSticker() {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(STICKERS, 'index.json'), 'utf8'))
    const pool = (idx.items ?? []).filter((i) => (i.bytes ?? 0) > 0 && (i.bytes ?? 0) <= MAX_STICKER)
    if (!pool.length) return null
    const it = pool[Math.floor(Math.random() * pool.length)]
    return { ...it, path: path.join(STICKERS, it.file) }
  } catch (e) {
    log('读表情库失败：' + e.message)
    return null
  }
}

async function onPoke(ev) {
  // 实测（早期 NapCat）：戳一戳走的是 notice_type=notify + sub_type=poke，
  // 不是 notice_type=poke。两种都认，免得版本一换又聋了。
  const isPoke = ev?.notice_type === 'poke' || (ev?.notice_type === 'notify' && ev?.sub_type === 'poke')
  if (ev?.post_type !== 'notice' || !isPoke) return
  const target = Number(ev.target_id ?? ev.self_id ?? 0)
  if (target && target !== SELF) return            // 戳的不是我
  const from = Number(ev.user_id ?? 0)
  if (from !== OWNER) {                            // 别人戳：装死
    log(`忽略来自 ${from} 的戳`)
    return
  }

  if (ev.group_id) {                               // 群里：必发一张
    const st = pickSticker()
    if (!st) { log('表情库里没有能发的'); return }
    let buf
    try { buf = fs.readFileSync(st.path) } catch { log('读不到 ' + st.path); return }
    const r = await call('send_group_msg', {
      group_id: Number(ev.group_id),
      message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }],
    })
    log(`群 ${ev.group_id} 被戳 → 表情 ${st.hash} ${r?.retcode === 0 ? 'OK' : 'FAIL'}`)
  } else {                                         // 私聊：戳回去
    const r = await call('send_poke', { user_id: OWNER })
    log(`私聊被戳 → 戳回 ${r?.retcode === 0 ? 'OK' : 'FAIL'}`)
  }
}

let backoff = 3000
let current = null

function connect() {
  let ws
  try {
    ws = new WebSocket(WS)
    current = ws
  } catch (e) {
    log('建连失败：' + e.message)
    setTimeout(connect, backoff)
    return
  }
  ws.addEventListener('open', () => {
    backoff = 3000
    log('已连上')
  })
  ws.addEventListener('message', (e) => {
    let ev
    try { ev = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)) } catch { return }
    if (process.env.POKE_DEBUG || ev?.post_type === 'notice') {
      log('EV ' + JSON.stringify(ev).slice(0, 240))
    }
    onPoke(ev).catch((err) => log('处理出错：' + err.message))
  })
  ws.addEventListener('close', () => {
    log('断了，' + Math.round(backoff / 1000) + ' 秒后重连')
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 60000)
  })
  ws.addEventListener('error', () => { try { ws.close() } catch {} })
}

log('启动')

// 早期 教训：进程会悄悄死掉，任务状态显示就绪但其实没在跑。
// 兜住异常 + 每 60 秒自检，断了就自己重连，别指望外面盯。
process.on('uncaughtException', (e) => log('未捕获异常：' + String(e?.stack ?? e)))
process.on('unhandledRejection', (e) => log('未处理的 rejection：' + String(e?.stack ?? e)))

setInterval(() => {
  if (!current || current.readyState > 1) {   // 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
    log('自检：连接不在了，重连')
    try { current?.close() } catch {}
    connect()
  }
}, 60_000)

connect()

