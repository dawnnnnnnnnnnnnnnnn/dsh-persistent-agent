/**
 * draw-ref.mjs —— 用参考图出图（GPT images/edits 通道）
 *
 * 目的：让 GPT "看着"一张图来画（脸、身材、衣服都参考它），而不是只读文字。
 *
 * 用法：
 *   node draw-ref.mjs --ref <参考图> --prompt "..." [--size 1024x1536] [--n 1] [--go]
 *
 * 说明：
 *   · 走 POST {BASE}/images/edits（multipart/form-data），字段：model / image / prompt / size / n
 *   · 需要先 approve（和 draw.mjs 共用同一个令牌文件）
 *   · 输出写 {{WORKSPACE}}/dsh-data\images\
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const ENV_FILE = path.join(HOME, '.gateway.env')
const TOKEN = path.join(DSH, 'agent-core', 'draw-token.json')
const OUT_DIR = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

function envFromFile() {
  const out = {}
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
  return out
}
const fileEnv = envFromFile()
const KEY = process.env.OPENAI_API_KEY || fileEnv.OPENAI_API_KEY || ''
const BASE = (process.env.OPENAI_BASE_URL || fileEnv.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = arg('--model') || process.env.OPENAI_IMAGE_MODEL || fileEnv.OPENAI_IMAGE_MODEL || 'gpt-image-2'

// --preset：从预设文件里取参考图与 prompt（预设名由文件定义，不在代码里列举），
// 这样"以后生图的形象设定"只有一处来源，改 json 就等于改全部。
const PRESET_FILE = process.env.AGENT_PRESET_FILE || path.join(DSH, 'memory', '形象', '生图设定.json')
function loadPreset(name) {
  try {
    const j = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8').replace(/^\uFEFF/, ''))
    const p = j[name]
    if (!p) return null
    return {
      ref: path.join(DSH, p.reference ?? ''),
      prompt: String(p.prompt ?? ''),
      size: String(p.size ?? '1024x1536'),
    }
  } catch { return null }
}
const presetName = arg('--preset')
const preset = presetName ? loadPreset(presetName) : null
if (presetName && !preset) { console.error('没有这个预设: ' + presetName + '（可选 普通版 / Q版）'); process.exit(2) }

const ref = arg('--ref') || preset?.ref
const prompt = String(arg('--prompt') || preset?.prompt || '').trim()
const size = String(arg('--size') || preset?.size || '1024x1536')
const n = String(arg('--n') || '1')

if (!ref || !prompt) { console.error('用法: draw-ref.mjs --ref <图> --prompt "..." [--size 1024x1536] [--go]'); process.exit(2) }
if (!fs.existsSync(ref)) { console.error('参考图不存在: ' + ref); process.exit(2) }
if (!KEY) { console.error('缺 OPENAI_API_KEY'); process.exit(1) }

let tok = {}
try { tok = JSON.parse(fs.readFileSync(TOKEN, 'utf8')) } catch {}
if (Number(tok.expiresAt ?? 0) < Date.now()) {
  console.error('✗ 没有有效批准：先问他，同意后跑 node draw.mjs approve')
  process.exit(3)
}

if (!GO) {
  console.log('（预演）POST ' + BASE + '/images/edits')
  console.log('  model=' + MODEL + '  ref=' + ref + '  size=' + size + '  n=' + n)
  console.log('  prompt=' + prompt.slice(0, 200))
  console.log('加 --go 才真出图。')
  process.exit(0)
}

const buf = fs.readFileSync(ref)
const name = path.basename(ref)
const fd = new FormData()
fd.set('model', MODEL)
fd.set('prompt', prompt)
fd.set('size', size)
fd.set('n', n)
fd.set('image', new Blob([buf], { type: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' }), name)

let data = null
try {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 240000)
  const r = await fetch(BASE + '/images/edits', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY },
    body: fd,
    signal: ctl.signal,
  })
  clearTimeout(timer)
  const txt = await r.text()
  if (!r.ok) {
    console.error('✗ HTTP ' + r.status + '：' + txt.slice(0, 300).replace(/\s+/g, ' '))
    process.exit(1)
  }
  data = JSON.parse(txt)
} catch (e) {
  console.error('✗ 请求失败：' + String(e?.message ?? e).slice(0, 200))
  process.exit(1)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
let saved = 0
for (const [i, item] of (data?.data ?? []).entries()) {
  try {
    if (item.b64_json) {
      const f = path.join(OUT_DIR, `ref-${stamp}-${i}.png`)
      fs.writeFileSync(f, Buffer.from(item.b64_json, 'base64'))
      console.log('✓ ' + f)
      saved += 1
    } else if (item.url) {
      const rr = await fetch(item.url)
      const b = Buffer.from(await rr.arrayBuffer())
      const f = path.join(OUT_DIR, `ref-${stamp}-${i}.png`)
      fs.writeFileSync(f, b)
      console.log('✓ ' + f)
      saved += 1
    }
  } catch (e) { console.error('保存失败：' + String(e?.message ?? e).slice(0, 100)) }
}
if (!saved) { console.error('✗ 没拿到图片数据；原始返回：' + JSON.stringify(data).slice(0, 300)); process.exit(1) }
console.log('共 ' + saved + ' 张')
