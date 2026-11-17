#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：运行时读取 dsh-nekowhale-stickers 已下载到本地的贴纸素材
 * （https://github.com/Loping151/dsh-nekowhale-stickers）。
 * 该项目的代码为 Apache-2.0，知识库数据与素材为 CC BY-NC 4.0（禁止商用）。
 * 本文件不含其代码，也不打包任何素材；素材版权归原作者，见其 NOTICE / LICENSE-ASSETS。
 * 详见 THIRD-PARTY-NOTICES.md §5
 */
/**
 * sticker-qq.mjs —— 把表情包（dsh-nekowhale-stickers）真正发到 QQ
 *
 * 背景：那个插件只管「挑图 + 造图 + 返回网页链接」，没有 QQ 通道。
 *      这个脚本补上最后一公里：byhash 里的 gif → 上传到 QQ。
 *
 * 用法：
 *   node sticker-qq.mjs "摸鱼"                  # 按名字模糊找一张，发给使用者
 *   node sticker-qq.mjs "3N05_摸鱼"             # 精确名（sticker_search 的输出）
 *   node sticker-qq.mjs "摸鱼" --to group:onebot.groupId
 *   node sticker-qq.mjs --render "举牌" "今天也要摸鱼"   # 现场做一张文字表情包再发
 *   node sticker-qq.mjs "摸鱼" --dry             # 只看会发哪张
 *
 * 素材来源：~/.dsh/nekowhale-stickers/byhash/<hash>.gif（插件自己下载的）
 *          缺了就现下（manifest 里有 hash，站点 gif_base=/media/gif）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { onebot } from '../config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const KIT = path.join(DSH, 'nekowhale-stickers')
const MANIFEST = path.join(KIT, 'manifest.json')
const META = path.join(DSH, 'profiles', 'web', 'node_modules', 'dsh-nekowhale-stickers', 'meta', 'nekowhale.json')
const SITE = 'https://kiriyuki.com'
const MEDIA = path.join(DSH, 'media', 'onebot')
const API = process.env.QQ_API || 'http://127.0.0.1:5700'
const TOKEN = process.env.QQ_API_TOKEN || onebot.token
const OWNER = onebot.ownerQQ

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const flag = (k) => argv.includes(k)
const DRY = flag('--dry')
const TO = String(arg('--to') || 'owner')

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

function loadManifest() {
  const m = readJson(MANIFEST)
  if (!m || !Array.isArray(m.items)) return null
  return m
}

/** 名字 → manifest 条目（精确 stem 优先，其次包含匹配） */
function findItem(m, q) {
  const q2 = String(q).trim()
  const items = m.items
  let hit = items.find((x) => x.stem === q2 || x.id === q2 || `${x.code}_${x.name}` === q2)
  if (!hit) hit = items.find((x) => `${x.code}_${x.name}`.includes(q2) || x.name === q2 || x.stem.includes(q2))
  if (!hit) hit = items.find((x) => (x.name || '').includes(q2))
  return hit || null
}

/** 确保本地有这张 gif，返回本地路径 */
async function ensureAsset(m, item) {
  const f = path.join(KIT, 'byhash', `${item.hash}.gif`)
  if (fs.existsSync(f) && fs.statSync(f).size > 1024) return f
  // 正确格式：site + gif_base + /<包名>/<文件名>（实测 200，1.5 MB）
  const base = SITE + (m.gif_base || '/media/gif')
  const url = base + '/' + encodeURIComponent(item.pack) + '/' + encodeURIComponent(item.file)
  const alt = SITE + (item.drag_url || '')
  for (const u of [url, alt]) {
    try {
      const r = await fetch(u)
      if (!r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 1024) continue
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, buf)
      return f
    } catch {}
  }
  return null
}

async function sendImage(file, target) {
  fs.mkdirSync(MEDIA, { recursive: true })
  const copy = path.join(MEDIA, 'sticker-' + path.basename(file))
  try { fs.copyFileSync(file, copy) } catch {}

  const seg = [{ type: 'image', data: { file: 'file:///' + file.replace(/\\/g, '/') } }]
  let action = 'send_private_msg'
  let body = { user_id: OWNER, message: seg }
  if (target.startsWith('group:')) {
    action = 'send_group_msg'
    body = { group_id: Number(target.slice(6)), message: seg }
  } else if (target.startsWith('private:')) {
    body = { user_id: Number(target.slice(8)), message: seg }
  }

  const r = await fetch(API + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(body),
  })
  const t = await r.text()
  return { ok: r.ok, status: r.status, text: t.slice(0, 200) }
}

// ── 现场做一张（走插件 CLI，不重复实现模板）────────────────────────────
const renderTpl = arg('--render')
if (renderTpl) {
  const text = String(argv[argv.indexOf('--render') + 2] || '').trim()
  const cli = path.join(DSH, 'profiles', 'web', 'node_modules', 'dsh-nekowhale-stickers', 'lib', 'cli.js')
  if (!fs.existsSync(cli)) { console.error('✗ 找不到插件 CLI：' + cli); process.exit(1) }
  const { execFileSync } = await import('node:child_process')
  let out = ''
  try {
    out = execFileSync(process.execPath, [cli, 'render', renderTpl, text], { encoding: 'utf8', timeout: 60000, windowsHide: true })
  } catch (e) {
    console.error('✗ 渲染失败：' + String(e?.message ?? e).slice(0, 160))
    process.exit(1)
  }
  const m = out.match(/([A-Za-z]:\\[^\s)\]]+|~\/[^\s)\]]+)/)
  const file = m ? m[1] : null
  if (!file || !fs.existsSync(file)) { console.error('✗ 没拿到渲染产物：' + out.slice(0, 200)); process.exit(1) }
  if (DRY) { console.log('（预演）会发：' + file); process.exit(0) }
  // 早期：贴纸发出去的同时，让桌面上的 Live2D 也变表情（双通道）
  try {
    const { face } = await import('./face.mjs')
    face((typeof pick !== 'undefined' && pick && pick.emotion) ? String(pick.emotion) : ((typeof query !== 'undefined' && query) ? String(query) : ''))
  } catch {}
  const r = await sendImage(file, TO)
  if (r.ok) recordSend()
  console.log((r.ok ? '✓ 已发' : '✗ 发送失败') + ' → ' + TO + '  ' + r.text)
  process.exit(r.ok ? 0 : 1)
}

/** 发完记一笔，让 inbound 的「表情包提醒」知道刚发过（冷却/上限都靠它） */
function recordSend() {
  try {
    const st = path.join(DSH, 'agent-core', 'sticker-nudge.json')
    let cur = {}
    try { cur = JSON.parse(fs.readFileSync(st, 'utf8')) } catch {}
    const today = new Date().toLocaleDateString('sv-SE')
    const count = cur.date === today ? Number(cur.count ?? 0) + 1 : 1
    fs.mkdirSync(path.dirname(st), { recursive: true })
    fs.writeFileSync(st, JSON.stringify({ date: today, count, lastAt: Date.now() }, null, 2) + '\n')
  } catch {}
}
// ── 正常：按名字挑一张 ────────────────────────────────────────────────
const q = argv.find((a) => !a.startsWith('--'))
if (!q) { console.error('用法: sticker-qq.mjs "摸鱼" [--to owner|group:<id>|private:<qq>] [--dry]'); process.exit(2) }

const m = loadManifest()
if (!m) { console.error('✗ 没有 manifest：先让插件同步一次（sticker_manage sync）'); process.exit(1) }

let item = findItem(m, q)

// 名字没命中 → 退到「标签 / 情绪 / 用法」里找（meta 里有 tags/emotion/use/desc）
if (!item) {
  const meta = readJson(META)
  // meta 的结构是 { schema, kit, packs, emotions, stickers[] }
  const arr = Array.isArray(meta) ? meta : (meta?.stickers ?? meta?.items ?? [])
  const qq = String(q).trim()
  const cands = arr.filter((x) => {
    const blob = [x.id, x.emotion, ...(x.tags ?? []), x.use, x.desc, x.meme].join(' ')
    return blob.includes(qq)
  })
  if (cands.length) {
    const pickMeta = cands[Math.floor(Math.random() * cands.length)]
    item = m.items.find((x) => x.hash === pickMeta.hash) || null
    if (item) console.log('（按标签命中：' + (pickMeta.emotion || '') + ' / ' + (pickMeta.tags || []).slice(0, 3).join(',') + '）')
  }
}
if (!item) { console.error('✗ 没找到匹配的表情：' + q + '（名字、标签、情绪都没命中）'); process.exit(3) }

const file = await ensureAsset(m, item)
if (!file) { console.error('✗ 素材下载失败：' + item.id); process.exit(1) }

if (DRY) {
  console.log('（预演）会发：' + item.id)
  console.log('  文件：' + file + '  ' + (fs.statSync(file).size / 1024 | 0) + ' KB')
  console.log('  目标：' + TO)
  process.exit(0)
}

// 早期：贴纸发出去的同时，让桌面上的 Live2D 也变表情（双通道）
  try {
    const { face } = await import('./face.mjs')
    face((typeof pick !== 'undefined' && pick && pick.emotion) ? String(pick.emotion) : ((typeof query !== 'undefined' && query) ? String(query) : ''))
  } catch {}
  const r = await sendImage(file, TO)
if (r.ok) recordSend()
console.log((r.ok ? '✓ 已发' : '✗ 发送失败') + '：' + item.id + ' → ' + TO)
console.log('  ' + r.text)
process.exit(r.ok ? 0 : 1)
