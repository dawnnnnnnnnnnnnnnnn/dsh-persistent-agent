/**
 * inpaint.mjs —— 局部重绘（ComfyUI 原生 inpaint 流程）
 *
 * 为什么单独做：整张重画改不动的地方（比如某一块细节），用 inpaint 只重画那一小块，
 * 保分辨率、保构图、保脸。
 *
 * 用法：
 *   node inpaint.mjs --image <原图> --rect 340,620,240,220 --prompt "detailed ..." [--go]
 *   node inpaint.mjs --image <原图> --rect 0.36,0.55,0.28,0.2 --prompt "..." [--go]   # 用比例
 *
 * 选项：
 *   --negative "…"    负面词（cfg>1 才生效）
 *   --steps 40        步数
 *   --cfg 4           CFG（默认 4，inpaint 想要细节就别用 1）
 *   --denoise 0.85    重绘强度（0.6 保守 / 0.85 常用 / 1.0 完全重画）
 *   --feather 24      羽化像素（边缘更自然）
 *   --grow 8          mask 膨胀
 *   --tag <名字>      输出文件名标签
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'
import { WORKSPACE, COMFY_ROOT } from '../core/lib/config.mjs'

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const DSH = path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
const OUT_DIRS = [process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images'), path.join(WORKSPACE, 'backup', 'inpaint-out')]
const DEFAULTS = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
}

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')
const image = arg('--image')
const rectArg = String(arg('--rect') || '')
const prompt = String(arg('--prompt') || '').trim()
const negative = String(arg('--negative') || 'blurry, mosaic, bar, blank, deformed, extra limbs, watermark, text').trim()
const steps = Math.max(1, Math.min(60, Number(arg('--steps') || 28)))
const cfg = Math.max(1, Math.min(12, Number(arg('--cfg') || 4)))
const denoise = Math.max(0.05, Math.min(1, Number(arg('--denoise') || 0.85)))
const feather = Math.max(0, Math.min(200, Number(arg('--feather') || 24)))
const grow = Math.max(0, Math.min(64, Number(arg('--grow') || 8)))
const tag = String(arg('--tag') || 'inpaint')
const MODE_OFFICIAL = String(arg('--mode') || 'composite') === 'official'

if (!image || !rectArg || !prompt) {
  console.error('用法: inpaint.mjs --image <图> --rect x,y,w,h（或比例）--prompt "…" [--go]')
  process.exit(2)
}
if (!fs.existsSync(image)) { console.error('✗ 原图不存在: ' + image); process.exit(2) }

// ── 读图片尺寸（PNG / WebP / JPEG）──
function dims(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16)
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const m = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
  }
  throw new Error('读不出尺寸（支持 png / webp / jpg）')
}

// ── 造一张灰度 mask PNG（白=重绘区）──
function makeMaskPng(w, h, rect, featherPx) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  const { x0, y0, x1, y1 } = rect
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 3 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      let v = 0
      const dx = Math.max(x0 - x, 0, x - x1)
      const dy = Math.max(y0 - y, 0, y - y1)
      const d = Math.hypot(dx, dy)
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) v = 255
      else if (featherPx > 0 && d <= featherPx) v = Math.round(255 * (1 - d / featherPx))
      const o = rowStart + 1 + x * 3
      raw[o] = raw[o + 1] = raw[o + 2] = v
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 })
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc = (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const cr = Buffer.alloc(4)
    cr.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, cr])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function upload(name, buf, type) {
  const fd = new FormData()
  fd.set('image', new Blob([buf], { type }), name)
  fd.set('overwrite', 'true')
  const r = await fetch(COMFY + '/upload/image', { method: 'POST', body: fd })
  const j = await r.json()
  if (!r.ok) throw new Error('上传失败: ' + JSON.stringify(j).slice(0, 200))
  return j.name
}

async function submit(wf) {
  const r = await fetch(COMFY + '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'inpaint-' + process.pid }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error('提交失败: ' + JSON.stringify(j).slice(0, 400))
  return j.prompt_id
}

async function waitDone(id) {
  const t0 = Date.now()
  while (Date.now() - t0 < 300000) {
    const j = await (await fetch(COMFY + '/history/' + id)).json()
    const e = j[id]
    if (e?.outputs) for (const n of Object.values(e.outputs)) if (n.images?.length) return n.images[0]
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('超时')
}

// ComfyUI 会被插件的「空闲 5 分钟自动关停」杀掉，所以每次跑前自己确认一遍、必要时自己拉起来。
const COMFY_PY = process.env.COMFY_PY || path.join(COMFY_ROOT, 'python_embeded', 'python.exe')
const COMFY_MAIN = path.join(COMFY_ROOT, 'ComfyUI', 'main.py')
const COMFY_WD = path.join(COMFY_ROOT, 'ComfyUI')

async function comfyUp() {
  try { const r = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(3000) }); return r.ok } catch { return false }
}

async function ensureComfy() {
  if (await comfyUp()) return true
  if (!fs.existsSync(COMFY_MAIN)) return false
  console.log('ComfyUI 没在跑，正在拉起…')
  const { spawn } = await import('node:child_process')
  const p = spawn(COMFY_PY, [COMFY_MAIN, '--listen', '127.0.0.1', '--port', '8188'], {
    cwd: COMFY_WD, detached: true, stdio: 'ignore', windowsHide: true,
  })
  p.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await comfyUp()) { console.log('就绪（' + (i * 2) + ' 秒）'); return true }
  }
  return false
}

if (!(await ensureComfy())) { console.error('✗ ComfyUI 起不来（' + COMFY_MAIN + '）'); process.exit(1) }

const buf = fs.readFileSync(image)
const { w, h } = dims(buf)
const parts = rectArg.split(',').map(Number)
if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) { console.error('✗ --rect 要 4 个数字'); process.exit(2) }
const isRatio = parts.every((n) => n <= 1)
const [a, b, c, d] = parts
const rect = isRatio
  ? { x0: Math.round(a * w), y0: Math.round(b * h), x1: Math.round((a + c) * w), y1: Math.round((b + d) * h) }
  : { x0: a, y0: b, x1: a + c, y1: b + d }

console.log('原图: ' + image + '  ' + w + '×' + h)
console.log('重绘区: x ' + rect.x0 + '–' + rect.x1 + '  y ' + rect.y0 + '–' + rect.y1 + '（' + (rect.x1 - rect.x0) + '×' + (rect.y1 - rect.y0) + '）')
console.log('参数: steps=' + steps + ' cfg=' + cfg + ' denoise=' + denoise + ' feather=' + feather + ' grow=' + grow)
console.log('提示词: ' + prompt.slice(0, 120))
if (!GO) { console.log('\n（预演）加 --go 才真跑'); process.exit(0) }

const baseName = 'inp_' + Date.now() + path.extname(image)
const maskName = 'mask_' + Date.now() + '.png'
const upBase = await upload(baseName, buf, 'image/png')

// ───────────────────────────────────────────────────────────────
// Qwen-Image 2.1 的正确 inpaint 姿势：
//   ❌ VAEEncodeForInpaint + Qwen 专用编码节点 → 报 "Boolean value of Tensor … ambiguous"
//   ❌ CLIPTextEncode → 条件空间不对，重绘区变成乱码
//   ✅ 裁出目标区 → 放大到 1024 级 → 用图生图重画 → 缩回原尺寸 → 带羽化贴回
//      这套走的是节点自己支持的「参考图」模式，稳定、且细节是按大图尺度重画的。
// ───────────────────────────────────────────────────────────────
const rw = rect.x1 - rect.x0
const rh = rect.y1 - rect.y0
const scale = Math.min(3, Math.max(1, Math.round((768 / Math.max(rw, rh)) * 10) / 10))
const bigW = Math.max(64, Math.round((rw * scale) / 64) * 64)
const bigH = Math.max(64, Math.round((rh * scale) / 64) * 64)

// composite 模式要两种 mask：
//   · official：整幅尺寸、只在目标区为白
//   · composite：重画块尺寸、整块为白（边缘羽化），这样 ImageCompositeMasked 贴回去才严丝合缝
const maskForOfficial = makeMaskPng(w, h, rect, feather)
let maskForComposite = null
if (!MODE_OFFICIAL) {
  maskForComposite = makeMaskPng(rw, rh, { x0: 0, y0: 0, x1: rw - 1, y1: rh - 1 }, feather)
}
const upMask = await upload(maskName, MODE_OFFICIAL ? maskForOfficial : maskForComposite, 'image/png')
console.log('已上传: ' + upBase + ' / ' + upMask)

const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: DEFAULTS.unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: DEFAULTS.clip, type: 'qwen_image', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: DEFAULTS.vae } },
  4: { class_type: 'LoadImage', inputs: { image: upBase, upload: 'image' } },
  // ① 裁出目标区
  5: { class_type: 'ImageCrop', inputs: { image: ['4', 0], width: rw, height: rh, x: rect.x0, y: rect.y0 } },
  // ② 放大到 1024 级别（细节按大尺度重画）
  6: { class_type: 'ImageScale', inputs: { image: ['5', 0], upscale_method: 'lanczos', width: bigW, height: bigH, crop: 'disabled' } },
  // ③ 图生图：把放大后的裁片当参考
  7: {
    class_type: 'TextEncodeQwenImage21',
    // 不传 images：这个版本的 nodes_qwen.py 里 `images = images or {}` 收到张量会抛
    // "Boolean value of Tensor … ambiguous"。省略后它拿到 None，走纯文本条件。
    inputs: { clip: ['2', 0], prompt, negative_prompt: negative, resolution: 1024 },
  },
  // 用普通 VAEEncode 拿 latent（inpaint 编码器在这个模型上不配合）
  '7b': { class_type: 'VAEEncode', inputs: { pixels: ['6', 0], vae: ['3', 0] } },
  8: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      seed: Math.floor(Math.random() * 1e9),
      steps,
      cfg,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: ['7', 0],
      negative: ['7', 1],
      latent_image: ['7b', 0],
      denoise,
    },
  },
  9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  // ④ 缩回原尺寸
  10: { class_type: 'ImageScale', inputs: { image: ['9', 0], upscale_method: 'lanczos', width: rw, height: rh, crop: 'disabled' } },
  // ⑤ 带羽化贴回原图
  11: { class_type: 'LoadImage', inputs: { image: upMask, upload: 'image' } },
  12: { class_type: 'ImageToMask', inputs: { image: ['11', 0], channel: 'red' } },
  13: {
    class_type: 'ImageCompositeMasked',
    inputs: { destination: ['4', 0], source: ['10', 0], x: rect.x0, y: rect.y0, resize_source: false, mask: ['12', 0] },
  },
  14: { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: tag } },
}

console.log('裁切放大倍数: ' + scale + '×（重画区 ' + bigW + '×' + bigH + '）')

// ── official 模式：官方 inpaint 流程（VAEEncodeForInpaint + Qwen 文本条件）──
//    之前失败的两个原因都已绕开：
//      ① 节点 5 缺 resolution → 已给
//      ② images 传张量会崩（nodes_qwen.py: images = images or {}）→ 这里干脆不传 images
let wfToUse = wf
if (MODE_OFFICIAL) {
  wfToUse = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: DEFAULTS.unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: DEFAULTS.clip, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: DEFAULTS.vae } },
    4: { class_type: 'LoadImage', inputs: { image: upBase, upload: 'image' } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: { clip: ['2', 0], prompt, negative_prompt: negative, resolution: 1024 },
    },
    6: { class_type: 'LoadImage', inputs: { image: upMask, upload: 'image' } },
    7: { class_type: 'ImageToMask', inputs: { image: ['6', 0], channel: 'red' } },
    8: {
      class_type: 'VAEEncodeForInpaint',
      inputs: { pixels: ['4', 0], vae: ['3', 0], mask: ['7', 0], grow_mask_by: grow },
    },
    9: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: Math.floor(Math.random() * 1e9),
        steps,
        cfg,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['5', 0],
        negative: ['5', 1],
        latent_image: ['8', 0],
        denoise,
      },
    },
    10: { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    11: { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: tag + '_official' } },
  }
  console.log('模式: official（VAEEncodeForInpaint，原图尺寸重绘）')
} else {
  console.log('模式: composite（裁切→放大→图生图→贴回）')
}

try {
  const id = await submit(wfToUse)
  console.log('排队: ' + id)
  const img = await waitDone(id)
  const url = COMFY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=' + (img.type || 'output')
  const out = Buffer.from(await (await fetch(url)).arrayBuffer())
  const dir = OUT_DIRS[0]
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, tag + '-' + Date.now() + '.png')
  fs.writeFileSync(dest, out)
  console.log('✓ ' + dest + '  ' + (out.length / 1024 | 0) + ' KB')
} catch (e) {
  console.error('✗ ' + String(e?.message ?? e).slice(0, 400))
  process.exit(1)
}
