/**
 * img2img.mjs —— 图生图（保脸/保色/保细节），可只改指定区域
 *
 * 为什么单写一个：需要「严格按参考图来」——
 * 用参考图当 init latent 低 denoise 重画，脸、瞳孔、配色这些细节都会保留；
 * 纯文生图做不到这一点。
 *
 * 用法：
 *   # 整张图轻度重绘（几乎等于原图，只微调质感/光线）
 *   node img2img.mjs --image 参考.png --prompt "写实照片…" --denoise 0.35 --go
 *
 *   # 只重绘局部（脸不动），比如换衣服或改姿势
 *   node img2img.mjs --image 参考.png --rect 0.18,0.30,0.64,0.68 --prompt "…新描述…" --denoise 0.6 --go
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { WORKSPACE } from '../core/lib/config.mjs'

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const OUT = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')
const D = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
}
const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

const image = arg('--image')
const prompt = String(arg('--prompt') || '').trim()
const negative = String(arg('--negative') || '插画，动画，赛璐璐，平涂，塑料感，变形，模糊，低清，打码，文字，水印').trim()
const denoise = Math.max(0.05, Math.min(1, Number(arg('--denoise') || 0.45)))
const steps = Math.max(1, Math.min(60, Number(arg('--steps') || 40)))
const cfg = Math.max(1, Math.min(12, Number(arg('--cfg') || 4.5)))
const rectArg = String(arg('--rect') || '')
const feather = Math.max(0, Math.min(200, Number(arg('--feather') || 32)))
const tag = String(arg('--tag') || 'img2img')
const targetH = Number(arg('--height') || 1408)

if (!image || !prompt) { console.error('用法: --image <图> --prompt "…" [--denoise 0.5] [--rect x,y,w,h] [--go]'); process.exit(2) }
if (!fs.existsSync(image)) { console.error('✗ 图不存在: ' + image); process.exit(2) }

// ── 尺寸探测 ──
function dims(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf.length > 30 && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16)
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
    if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 } }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      i += 2 + len
    }
  }
  throw new Error('读不出尺寸')
}

function maskPng(w, h, featherPx) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const rs = y * (w * 3 + 1)
    for (let x = 0; x < w; x++) {
      const d = Math.min(x, y, w - 1 - x, h - 1 - y)
      const v = featherPx > 0 && d < featherPx ? Math.round(255 * (d / featherPx)) : 255
      const o = rs + 1 + x * 3
      raw[o] = raw[o + 1] = raw[o + 2] = v
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 })
  const tbl = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
  const crc = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = tbl[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
  const chunk = (ty, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const t = Buffer.from(ty, 'ascii'); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

async function upload(name, buf, type = 'image/png') {
  const fd = new FormData()
  fd.set('image', new Blob([buf], { type }), name)
  fd.set('overwrite', 'true')
  const r = await fetch(COMFY + '/upload/image', { method: 'POST', body: fd })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200))
  return j.name
}
async function submit(wf) {
  const r = await fetch(COMFY + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'i2i-' + process.pid }) })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 400))
  return j.prompt_id
}
async function waitDone(id, ms = 400000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const j = await (await fetch(COMFY + '/history/' + id)).json()
    const e = j[id]
    if (e?.outputs) for (const n of Object.values(e.outputs)) if (n.images?.length) return n.images[0]
    if (e?.status?.status_str === 'error') throw new Error('执行出错')
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('超时')
}

const buf = fs.readFileSync(image)
const { w, h } = dims(buf)
// 统一到 64 的倍数、高度对齐 targetH（保持比例）
const scale = targetH / h
const W64 = Math.round((w * scale) / 64) * 64
const H64 = Math.round(targetH / 64) * 64
console.log('原图 ' + w + '×' + h + ' → 工作尺寸 ' + W64 + '×' + H64)
console.log('denoise=' + denoise + ' steps=' + steps + ' cfg=' + cfg + (rectArg ? ' rect=' + rectArg : '（整张）'))

let rect = null
if (rectArg) {
  const [a, b, c, d] = rectArg.split(',').map(Number)
  const isRatio = [a, b, c, d].every((n) => n <= 1)
  rect = isRatio
    ? { x0: Math.round(a * W64), y0: Math.round(b * H64), x1: Math.round((a + c) * W64), y1: Math.round((b + d) * H64) }
    : { x0: a, y0: b, x1: a + c, y1: b + d }
}
if (!GO) { console.log('（预演）加 --go 才真跑'); process.exit(0) }

const upImg = await upload('i2i_' + Date.now() + '.png', buf, 'image/png')
const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: D.unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: D.clip, type: 'qwen_image', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: D.vae } },
  4: { class_type: 'LoadImage', inputs: { image: upImg, upload: 'image' } },
  // 统一尺寸
  5: { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width: W64, height: H64, crop: 'disabled' } },
  6: {
    class_type: 'TextEncodeQwenImage21',
    inputs: { clip: ['2', 0], prompt, negative_prompt: negative, resolution: 1024 },
  },
  7: { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
  8: {
    class_type: 'KSampler',
    inputs: { model: ['1', 0], seed: Math.floor(Math.random() * 1e9), steps, cfg, sampler_name: 'euler', scheduler: 'simple', positive: ['6', 0], negative: ['6', 1], latent_image: ['7', 0], denoise },
  },
  9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
}

let outNode = '9'
if (rect) {
  // 只把指定区域换掉：源 = 重绘结果裁切，目标 = 原图，带羽化贴回
  const rw = rect.x1 - rect.x0
  const rh = rect.y1 - rect.y0
  wf[10] = { class_type: 'ImageCrop', inputs: { image: ['9', 0], width: rw, height: rh, x: rect.x0, y: rect.y0 } }
  const upM = await upload('i2i_mask_' + Date.now() + '.png', maskPng(rw, rh, feather), 'image/png')
  wf[11] = { class_type: 'LoadImage', inputs: { image: upM, upload: 'image' } }
  wf[12] = { class_type: 'ImageToMask', inputs: { image: ['11', 0], channel: 'red' } }
  wf[13] = { class_type: 'ImageCompositeMasked', inputs: { destination: ['5', 0], source: ['10', 0], x: rect.x0, y: rect.y0, resize_source: false, mask: ['12', 0] } }
  outNode = '13'
}
wf[14] = { class_type: 'SaveImage', inputs: { images: [outNode, 0], filename_prefix: tag } }

try {
  const id = await submit(wf)
  const img = await waitDone(id)
  const url = COMFY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=output'
  const out = Buffer.from(await (await fetch(url)).arrayBuffer())
  fs.mkdirSync(OUT, { recursive: true })
  const f = path.join(OUT, tag + '-' + Date.now() + '.png')
  fs.writeFileSync(f, out)
  console.log('✓ ' + f + '  ' + (out.length / 1024 | 0) + ' KB')
} catch (e) {
  console.error('✗ ' + String(e?.message ?? e).slice(0, 300))
  process.exit(1)
}
