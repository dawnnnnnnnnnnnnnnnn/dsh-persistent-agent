/**
 * face-edit.mjs —— 用「底图 + 身份参考图」做换脸式重绘（云端 GPT 图像，锁脸）
 *
 * 用途：拿一张现成的底图（姿势/构图/光影/衣服都不动），只把人物的脸、头发、
 *       面部特征换成另一张参考图里的人（{{BOT_NAME}}）。
 *
 * 用法：
 *   node face-edit.mjs --base 13.png --face {{BOT_NAME}}-参考.png \
 *        --prompt "…要换成什么样…" [--size 1024x1536] [--n 1] [--go]
 *
 * 走的是 POST {BASE}/images/edits（multipart，多张 image：第一张是底图，第二张是身份参考）
 * 需要先 node draw.mjs approve
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const ENV_FILE = path.join(HOME, '.gateway.env')
const TOKEN = path.join(DSH, 'agent-core', 'draw-token.json')
const OUT = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

function envFile() {
  const o = {}
  try {
    for (const l of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/)
      if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
  return o
}
const E = envFile()
const KEY = process.env.OPENAI_API_KEY || E.OPENAI_API_KEY || ''
const BASE = (process.env.OPENAI_BASE_URL || E.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = (process.env.OPENAI_IMAGE_MODEL || E.OPENAI_IMAGE_MODEL || 'gpt-image-2').trim()
const SIZE = String(arg('--size') || '1024x1536')
const N = String(arg('--n') || '1')

const base = arg('--base')
const face = arg('--face')
const prompt = String(arg('--prompt') || '').trim()

if (!base || !face || !prompt) { console.error('用法: --base <底图> --face <身份参考> --prompt "…" [--go]'); process.exit(2) }
for (const f of [base, face]) if (!fs.existsSync(f)) { console.error('文件不存在: ' + f); process.exit(2) }
if (!KEY) { console.error('缺 OPENAI_API_KEY'); process.exit(1) }

let tok = {}
try { tok = JSON.parse(fs.readFileSync(TOKEN, 'utf8')) } catch {}
if (Number(tok.expiresAt ?? 0) < Date.now()) { console.error('✗ 没有有效批准：先 node draw.mjs approve'); process.exit(3) }

if (!GO) {
  console.log('（预演）')
  console.log('  base  : ' + base)
  console.log('  face  : ' + face)
  console.log('  model : ' + MODEL + '  size=' + SIZE)
  console.log('  prompt: ' + prompt.slice(0, 200))
  process.exit(0)
}

const mime = (f) => /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg'
const fd = new FormData()
fd.set('model', MODEL)
fd.set('prompt', prompt)
fd.set('size', SIZE)
fd.set('n', N)
// 第一张 = 底图，第二张及以后 = 身份参考
fd.append('image[]', new Blob([fs.readFileSync(base)], { type: mime(base) }), path.basename(base))
fd.append('image[]', new Blob([fs.readFileSync(face)], { type: mime(face) }), path.basename(face))

let data
try {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 300000)
  const r = await fetch(BASE + '/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + KEY }, body: fd, signal: ctl.signal })
  clearTimeout(timer)
  const txt = await r.text()
  if (!r.ok) { console.error('✗ HTTP ' + r.status + '：' + txt.slice(0, 400).replace(/\s+/g, ' ')); process.exit(1) }
  data = JSON.parse(txt)
} catch (e) {
  console.error('✗ 请求失败：' + String(e?.message ?? e).slice(0, 200)); process.exit(1)
}

fs.mkdirSync(OUT, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
let saved = 0
for (const [i, it] of (data?.data ?? []).entries()) {
  let buf = null
  if (it.b64_json) buf = Buffer.from(it.b64_json, 'base64')
  else if (it.url) buf = Buffer.from(await (await fetch(it.url)).arrayBuffer())
  if (!buf) continue
  const f = path.join(OUT, 'face-' + stamp + '-' + i + '.png')
  fs.writeFileSync(f, buf)
  console.log('✓ ' + f + '  ' + (buf.length / 1024 | 0) + ' KB')
  saved++
}
if (!saved) { console.error('✗ 没拿到图：' + JSON.stringify(data).slice(0, 300)); process.exit(1) }
