#!/usr/bin/env node
/**
 * 表情包库 —— 她自己挑，不是批量抓。
 *
 *   node sticker.mjs grab --chat private:{{OWNER_QQ}} --n 20 --tag agent
 *        从某个聊天/群最近的图片里挑着收（默认只收"表情"，--photos 才收普通图）
 *   node sticker.mjs save --url <图片地址> [--tag agent] [--note 为什么喜欢]
 *   node sticker.mjs save --file <本地路径> [--tag …]
 *   node sticker.mjs save --msg <message_id> [--tag …]      （用 NapCat get_msg 取原图）
 *   node sticker.mjs import --dir <文件夹> [--tag …]
 *   node sticker.mjs list [--n 20] [--tag agent]
 *   node sticker.mjs random [--tag agent]
 *   node sticker.mjs send <hash|路径> --to private:<qq>|group:<群号> [--go]
 *   node sticker.mjs stats
 *
 * 规矩：默认预演、按 sha256 去重、一次只发一张；普通照片默认不收。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { onebot } from '../config.mjs'

const API = process.env.NAPCAT_API || 'http://127.0.0.1:5700'
const TOKEN = process.env.NAPCAT_TOKEN || onebot.token
const HOME = process.env.USERPROFILE || os.homedir()
const ROOT = path.join(HOME, '.dsh', 'bili-whale', 'stickers')
const INDEX = path.join(ROOT, 'index.json')

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const pick = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }
const has = (n) => argv.includes('--' + n)
const GO = has('go')

async function call(action, params = {}) {
  const r = await fetch(`${API}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(params),
  })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { raw: t.slice(0, 300) } }
}

const readIndex = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')) } catch { return { items: [] } } }
const writeIndex = (o) => { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(o, null, 2) + '\n') }

async function cookieHeader() {
  try { const j = await call('get_cookies', { domain: 'qq.com' }); return String(j?.data?.cookies ?? '') } catch { return '' }
}

async function download(url, cookie) {
  const r = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...(cookie ? { cookie } : {}),
    },
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 400) throw new Error('太小 ' + buf.length + 'B')
  return buf
}

function extOf(buf, name = '') {
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'webp'
  const e = path.extname(name).replace('.', '').toLowerCase()
  return ['gif', 'png', 'jpg', 'jpeg', 'webp'].includes(e) ? (e === 'jpeg' ? 'jpg' : e) : 'jpg'
}

/** 存一张：去重 + 落盘 + 记账 */
function saveBuf(buf, idx, have, meta) {
  if (!buf || buf.length > 4 * 1024 * 1024) return null
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
  if (have.has(hash)) return null
  const ext = extOf(buf, meta.file ?? '')
  fs.mkdirSync(ROOT, { recursive: true })
  const file = hash + '.' + ext
  fs.writeFileSync(path.join(ROOT, file), buf)
  const item = { hash, file, bytes: buf.length, tags: meta.tag ? [String(meta.tag)] : [], note: meta.note ?? '', from: meta.from ?? '', at: new Date().toISOString() }
  idx.items.push(item)
  have.add(hash)
  return item
}

const tag = pick('tag')

if (cmd === 'save') {
  const idx = readIndex()
  const have = new Set(idx.items.map((i) => i.hash))
  const cookie = await cookieHeader()
  try {
    if (pick('url')) {
      const buf = await download(pick('url'), cookie)
      const it = saveBuf(buf, idx, have, { tag, note: pick('note'), from: 'url' })
      writeIndex(idx)
      console.log(it ? '✓ 收下了 ' + it.hash + '（' + (it.bytes / 1024).toFixed(0) + 'KB）' : '这个已经有了 / 太大')
    } else if (pick('file')) {
      const p = pick('file')
      const buf = fs.readFileSync(p)
      const it = saveBuf(buf, idx, have, { tag, note: pick('note'), from: 'file', file: p })
      writeIndex(idx)
      console.log(it ? '✓ 收下了 ' + it.hash : '这个已经有了')
    } else if (pick('msg')) {
      const m = await call('get_msg', { message_id: Number(pick('msg')) })
      const segs = m.data?.message ?? []
      let got = 0
      for (const s of segs) {
        if (s.type !== 'image' || !s.data?.url) continue
        const buf = await download(String(s.data.url), cookie)
        if (saveBuf(buf, idx, have, { tag, note: pick('note'), from: 'msg' })) got++
      }
      writeIndex(idx)
      console.log('✓ 从消息里收了 ' + got + ' 张')
    } else {
      console.error('用法: save --url <地址> | --file <路径> | --msg <message_id> [--tag …] [--note …]')
      process.exit(2)
    }
  } catch (e) { console.error('✗ ' + e.message); process.exit(1) }
  process.exit(0)
}

if (cmd === 'grab') {
  const idx = readIndex()
  const have = new Set(idx.items.map((i) => i.hash))
  const chat = pick('chat') || 'private:' + onebot.ownerQQ
  const n = Number(pick('n') ?? 20)
  const wantPhotos = has('photos')
  const cookie = await cookieHeader()
  const [kind, id] = chat.split(':')
  const h = kind === 'group'
    ? await call('get_group_msg_history', { group_id: Number(id), count: n })
    : await call('get_friend_msg_history', { user_id: Number(id), count: n })
  const msgs = h.data?.messages ?? []
  let added = 0, seen = 0
  for (const m of msgs) {
    for (const s of m.message ?? []) {
      if (s.type !== 'image') continue
      const sub = Number(s.data?.sub_type ?? 0)
      if (!wantPhotos && sub !== 1 && sub !== 7) continue
      if (!s.data?.url) continue
      seen++
      try {
        const buf = await download(String(s.data.url), cookie)
        if (saveBuf(buf, idx, have, { tag, note: pick('note'), from: chat, file: String(s.data.file ?? '') })) added++
      } catch {}
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  writeIndex(idx)
  console.log('扫了 ' + chat + ' 最近 ' + msgs.length + ' 条｜候选 ' + seen + ' 张｜收下 ' + added + ' 张｜库存 ' + idx.items.length)
  process.exit(0)
}

if (cmd === 'import') {
  const dir = pick('dir')
  if (!dir || !fs.existsSync(dir)) { console.error('用法: import --dir <文件夹> [--tag …]'); process.exit(2) }
  const idx = readIndex()
  const have = new Set(idx.items.map((i) => i.hash))
  let added = 0, skipped = 0
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (!st.isFile()) continue
    if (!/\.(gif|png|jpe?g|webp)$/i.test(f)) { skipped++; continue }
    try {
      const it = saveBuf(fs.readFileSync(p), idx, have, { tag, note: pick('note'), from: 'import', file: f })
      if (it) added++; else skipped++
    } catch { skipped++ }
  }
  writeIndex(idx)
  console.log('导入 ' + dir + '｜新增 ' + added + '｜跳过 ' + skipped + '｜库存 ' + idx.items.length)
  process.exit(0)
}

if (cmd === 'list') {
  const idx = readIndex()
  const n = Number(pick('n') ?? 20)
  const items = (tag ? idx.items.filter((i) => (i.tags ?? []).includes(tag)) : idx.items).slice(-n).reverse()
  console.log('库存 ' + idx.items.length + ' 张，显示 ' + items.length + '：')
  for (const i of items) console.log('  ' + i.hash + '  ' + (i.bytes / 1024).toFixed(0) + 'KB  ' + ((i.tags ?? []).join(',') || '-') + '  ' + (i.note || '') + '  ' + i.file)
  process.exit(0)
}

if (cmd === 'random') {
  const idx = readIndex()
  const pool = tag ? idx.items.filter((i) => (i.tags ?? []).includes(tag)) : idx.items
  if (!pool.length) { console.log('没有符合条件的表情，先 save / grab'); process.exit(1) }
  console.log(path.join(ROOT, pool[Math.floor(Math.random() * pool.length)].file))
  process.exit(0)
}

// tag —— 给某张图打情绪标签（她自己用过就知道是什么表情）
if (cmd === 'tag') {
  const hash = argv[1]
  const emotion = argv[2]
  if (!hash || !emotion) { console.error('用法: node sticker.mjs tag <hash> <情绪> [--note 说明]'); process.exit(2) }
  const idx = readIndex()
  const it = idx.items.find((x) => x.hash === hash || x.file === hash)
  if (!it) { console.error('没找到这张：' + hash); process.exit(2) }
  it.tags = Array.isArray(it.tags) ? it.tags : []
  if (!it.tags.includes(emotion)) it.tags.push(emotion)
  const note = pick('note')
  if (note) it.note = note
  writeIndex(idx)
  console.log('✓ ' + it.hash + ' 标签: ' + it.tags.join(',') + (it.note ? ('  说明: ' + it.note) : ''))
  process.exit(0)
}

// untagged —— 还有哪些没打情绪标签（前 N 张）
if (cmd === 'untagged') {
  const idx = readIndex()
  const EMOTIONS = ['开心', '难过', '生气', '委屈', '困', '无语', '害羞', '得意', '疑惑', '累', '中性']
  const list = idx.items.filter((x) => !(x.tags ?? []).some((t) => EMOTIONS.includes(t)))
  const n = Number(pick('n') ?? 20)
  console.log('未打情绪标签: ' + list.length + ' / ' + idx.items.length)
  for (const x of list.slice(0, n)) console.log('  ' + x.hash + '  ' + x.file)
  process.exit(0)
}

if (cmd === 'stats') {
  const idx = readIndex()
  const byTag = {}
  let bytes = 0
  for (const i of idx.items) { for (const t of (i.tags ?? ['未分类'])) byTag[t] = (byTag[t] ?? 0) + 1; bytes += i.bytes }
  console.log('共 ' + idx.items.length + ' 张，' + (bytes / 1024 / 1024).toFixed(1) + ' MB')
  for (const [k, v] of Object.entries(byTag)) console.log('  ' + k + ': ' + v)
  process.exit(0)
}

if (cmd === 'send') {
  const want = argv[1]
  if (!want) { console.error('用法: send <hash|路径> --to private:<qq>|group:<群号> [--go]'); process.exit(2) }
  const idx = readIndex()
  const it = idx.items.find((i) => i.hash === want || i.file === want)
  const file = want.includes(path.sep) ? want : path.join(ROOT, it ? it.file : want)
  if (!fs.existsSync(file)) { console.error('找不到文件：' + file); process.exit(1) }
  const buf = fs.readFileSync(file)
  const to = pick('to') || ''
  console.log('将要发：' + path.basename(file) + '（' + (buf.length / 1024).toFixed(0) + 'KB）→ ' + (to || '(未指定)'))
  if (!GO) { console.log('（预演：加 --go 才真发）'); process.exit(0) }
  const [kind, id] = to.split(':')
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const params = kind === 'group'
    ? { group_id: Number(id), message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }] }
    : { user_id: Number(id), message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }] }
  const r = await call(action, params)
  console.log(r.retcode === 0 ? '✓ 已发送' : '✗ 失败：' + JSON.stringify(r).slice(0, 200))
  process.exit(r.retcode === 0 ? 0 : 1)
}

console.log(`用法:
  grab   --chat private:<qq>|group:<群号> [--n 20] [--tag …] [--photos]
  save   --url <地址> | --file <路径> | --msg <message_id> [--tag …] [--note …]
  import --dir <文件夹> [--tag …]
  list [--n 20] [--tag …]   random [--tag …]   stats
  send   <hash|路径> --to private:<qq>|group:<群号> [--go]`)
