/**
 * upscale.mjs —— 用 4x-UltraSharp 超分（可选缩到目标长边）
 *
 * 用法：
 *   node upscale.mjs --image <图> [--long 2688] [--model 4x-UltraSharp.pth] [--go]
 *
 * 说明：直接 4x 会把 896×1152 放大到 3584×4608，12 GB 显存和 16 GB 内存都吃不住；
 *      所以默认放大后缩到长边 2688（= 3x），既保留细节又不爆。
 */
import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE } from '../core/lib/config.mjs'

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const OUT = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')
const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

const image = arg('--image')
const long = Math.max(1024, Math.min(4096, Number(arg('--long') || 2688)))
const model = String(arg('--model') || '4x-UltraSharp.pth')
const tag = String(arg('--tag') || 'up4x')

if (!image) { console.error('用法: --image <图> [--long 2688] [--go]'); process.exit(2) }
if (!fs.existsSync(image)) { console.error('X 图不存在: ' + image); process.exit(2) }

function pngSize(file) {
  const b = fs.readFileSync(file)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}
async function up() { try { const r = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(4000) }); return r.ok } catch { return false } }
async function upload(file) {
  const buf = fs.readFileSync(file)
  const fd = new FormData()
  fd.append('image', new Blob([buf], { type: 'image/png' }), path.basename(file))
  fd.append('overwrite', 'true')
  const r = await fetch(COMFY + '/upload/image', { method: 'POST', body: fd })
  const j = await r.json()
  return j.name || path.basename(file)
}
async function submit(wf) {
  const r = await fetch(COMFY + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'upscale-' + process.pid }) })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 400))
  return j.prompt_id
}
async function waitDone(id, ms = 900000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const j = await (await fetch(COMFY + '/history/' + id)).json()
    const e = j[id]
    if (e?.outputs) for (const n of Object.values(e.outputs)) if (n.images?.length) return n.images
    if (e?.status?.status_str === 'error') {
      const msg = (e.status.messages || []).find((m) => m[0] === 'execution_error')
      throw new Error('执行出错: ' + String(msg?.[1]?.exception_message || '').slice(0, 200))
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new Error('超时')
}

if (!(await up())) { console.error('X ComfyUI 没在跑'); process.exit(1) }

const sz = pngSize(image)
const scale = long / Math.max(sz.w, sz.h)
const TW = Math.round((sz.w * scale) / 8) * 8
const TH = Math.round((sz.h * scale) / 8) * 8

const wf = {
  1: { class_type: 'LoadImage', inputs: { image: await upload(image) } },
  2: { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
  3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
  4: { class_type: 'ImageScale', inputs: { image: ['3', 0], upscale_method: 'lanczos', width: TW, height: TH, crop: 'disabled' } },
  5: { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: tag } },
}

console.log(' ' + sz.w + '×' + sz.h + ' → ' + TW + '×' + TH + '（' + model + '）')
if (!GO) { console.log('（预演）加 --go'); process.exit(0) }

try {
  const t0 = Date.now()
  fs.mkdirSync(OUT, { recursive: true })
  const id = await submit(wf)
  const imgs = await waitDone(id)
  let i = 0
  for (const img of imgs) {
    const url = COMFY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=output'
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    const f = path.join(OUT, tag + '-' + Date.now() + '-' + i + '.png')
    fs.writeFileSync(f, buf)
    console.log('OK ' + f + '  ' + (buf.length / 1024 / 1024).toFixed(1) + ' MB')
    i++
  }
  console.log('用时 ' + Math.round((Date.now() - t0) / 1000) + 's')
} catch (e) {
  console.error('X ' + String(e?.message ?? e).slice(0, 300))
  process.exit(1)
}
