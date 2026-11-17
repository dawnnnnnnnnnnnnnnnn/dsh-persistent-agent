/**
 * hires-anima.mjs —— Anima 档的二次采样（hires.fix）
 *
 * 为什么要单独一份：hires.mjs 里用的是 Qwen 的 TextEncodeQwenImage21，
 * 跟 Anima（Cosmos 架构）不通用，拿去放大 Anima 的图会花掉。
 *
 * 流程：底图 → ImageScale ×scale → VAEEncode → KSampler(denoise 0.45) → 存
 *
 * 用法：
 *   node hires-anima.mjs --image <底图> --prompt "<同款提示词>" [--scale 1.5] [--denoise 0.45] [--go]
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
const prompt = String(arg('--prompt') || '').trim()
const negative = String(arg('--negative') || 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, bad anatomy, extra digits, watermark, text').trim()
const scale = Math.max(1.1, Math.min(2.0, Number(arg('--scale') || 1.5)))
const denoise = Math.max(0.2, Math.min(0.6, Number(arg('--denoise') || 0.45)))
const steps = Math.max(8, Math.min(40, Number(arg('--steps') || 26)))
const cfg = Number(arg('--cfg') || 4.5)
const seed = Number(arg('--seed') || Math.floor(Math.random() * 1e9))
const tag = String(arg('--tag') || 'hires-anima')
const unet = String(arg('--unet') || 'anima-base-v1.0.safetensors')
const lora = arg('--lora')
const loraStrength = Number(arg('--lora-strength') || 0.85)
const shift = Number(arg('--shift') || 3.0)

if (!image || !prompt) { console.error('用法: --image <底图> --prompt "..." [--scale 1.5] [--denoise 0.45] [--lora <名>] [--go]'); process.exit(2) }
if (!fs.existsSync(image)) { console.error('X 图不存在: ' + image); process.exit(2) }

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
  const r = await fetch(COMFY + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'hires-anima-' + process.pid }) })
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
    if (e?.status?.status_str === 'error') throw new Error('执行出错')
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('超时')
}

/** 读 PNG 尺寸（ImageScale 传 0 会被当成原尺寸，必须显式给宽高） */
function pngSize(file) {
  const b = fs.readFileSync(file)
  if (b.length < 24) return null
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

if (!(await up())) { console.error('X ComfyUI 没在跑'); process.exit(1) }

const sz = pngSize(image) || { w: 896, h: 1152 }
const TW = Math.round((sz.w * scale) / 8) * 8
const TH = Math.round((sz.h * scale) / 8) * 8
const uploaded = await upload(image)
console.log('底图已上传: ' + uploaded)

let modelSrc = ['1', 0]
let clipSrc = ['2', 0]
const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  4: { class_type: 'LoadImage', inputs: { image: uploaded } },
  5: { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width: TW, height: TH, crop: 'disabled' } },
}
if (lora) {
  wf[10] = { class_type: 'LoraLoader', inputs: { model: modelSrc, clip: clipSrc, lora_name: lora, strength_model: loraStrength, strength_clip: loraStrength } }
  modelSrc = ['10', 0]
  clipSrc = ['10', 1]
}
wf[6] = { class_type: 'CLIPTextEncode', inputs: { clip: clipSrc, text: prompt } }
wf[7] = { class_type: 'CLIPTextEncode', inputs: { clip: clipSrc, text: negative } }
wf[8] = { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } }
wf[9] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: modelSrc, shift } }
wf[11] = {
  class_type: 'KSampler',
  inputs: {
    model: ['9', 0], seed, steps, cfg, sampler_name: 'er_sde', scheduler: 'simple',
    positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0], denoise,
  },
}
wf[12] = { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } }
wf[13] = { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: tag } }

console.log(' ' + TW + '×' + TH + ' (×' + scale + '  denoise ' + denoise + '  steps ' + steps + '  cfg ' + cfg)
if (!GO) { console.log('（预演）加 --go'); process.exit(0) }

try {
  const t0 = Date.now()
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, tag + '-' + Date.now() + '.workflow.json'), JSON.stringify(wf, null, 2), 'utf8')
  const id = await submit(wf)
  const imgs = await waitDone(id)
  let i = 0
  for (const img of imgs) {
    const url = COMFY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=output'
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    const f = path.join(OUT, tag + '-' + Date.now() + '-' + i + '.png')
    fs.writeFileSync(f, buf)
    console.log('OK ' + f + '  ' + (buf.length / 1024 | 0) + ' KB')
    i++
  }
  console.log('用时 ' + Math.round((Date.now() - t0) / 1000) + 's')
} catch (e) {
  console.error('X ' + String(e?.message ?? e).slice(0, 300))
  process.exit(1)
}
