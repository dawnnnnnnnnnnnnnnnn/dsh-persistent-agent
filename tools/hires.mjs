/**
 * hires.mjs —— 二次采样（hires.fix）：先出图，再放大重采一遍，细节是"长出来"的
 *
 * 为什么这一步最关键：一次采样的图只是"大局对"，放大就糊。
 * 二次采样 = latent 放大 1.5–2× → 降 denoise 再采一遍，模型会在更大的画布上补细节。
 *
 * 用法：
 *   node hires.mjs --image <底图> --prompt "..." [--scale 1.6] [--denoise 0.45] [--steps 22] [--go]
 *   node hires.mjs --ref <参考图> --prompt "..." --denoise 0.5 [--go]     # 直接从参考图起
 */
import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE, DSH_HOME } from '../core/lib/config.mjs'

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const OUT = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')
const PLUGIN = path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-qwen-paint', 'lib', 'index.js')

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

const image = arg('--image')
const prompt = String(arg('--prompt') || '').trim()
const negative = String(arg('--negative') || '低清，模糊，糊，变形，畸形，多余手指，文字，水印').trim()
const scale = Math.max(1.1, Math.min(2.2, Number(arg('--scale') || 1.6)))
const denoise = Math.max(0.15, Math.min(0.7, Number(arg('--denoise') || 0.45)))
const steps = Math.max(4, Math.min(40, Number(arg('--steps') || 22)))
const firstDenoise = Number(arg('--first-denoise') || 0.5)
const cfg = Number(arg('--cfg') || 4.5)
const seed = Number(arg('--seed') || Math.floor(Math.random() * 1e9))
const tag = String(arg('--tag') || 'hires')

if (!image || !prompt) { console.error('用法: --image <底图> --prompt "..." [--scale 1.6] [--denoise 0.45] [--go]'); process.exit(2) }
if (!fs.existsSync(image)) { console.error('X 图不存在: ' + image); process.exit(2) }

const mod = await import('file:///' + PLUGIN)
const it = mod.__internal ?? {}
const D = it.DEFAULTS

async function up() { try { const r = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(4000) }); return r.ok } catch { return false } }
async function upload(name, buf) {
  const fd = new FormData()
  fd.set('image', new Blob([buf], { type: 'image/png' }), name)
  fd.set('overwrite', 'true')
  const r = await fetch(COMFY + '/upload/image', { method: 'POST', body: fd })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200))
  return j.name
}
async function submit(wf) {
  const r = await fetch(COMFY + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'hires-' + process.pid }) })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 400))
  return j.prompt_id
}
async function waitDone(id, ms = 600000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const j = await (await fetch(COMFY + '/history/' + id)).json()
    const e = j[id]
    if (e?.outputs) for (const n of Object.values(e.outputs)) if (n.images?.length) return n.images[0]
    if (e?.status?.status_str === 'error') throw new Error('执行出错')
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('超时')
}

if (!(await up())) { console.error('X ComfyUI 没在跑'); process.exit(1) }

const buf = fs.readFileSync(image)
const upName = await upload('hires_' + Date.now() + '.png', buf)

const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: D.unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: D.clip, type: 'qwen_image', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: D.vae } },
  4: { class_type: 'LoadImage', inputs: { image: upName, upload: 'image' } },
  5: { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width: 768, height: 1152, crop: 'disabled' } },
  6: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt, negative_prompt: negative, resolution: 1024 } },
  // 第一段：768×1152 出基础图
  7: { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
  8: {
    class_type: 'KSampler',
    inputs: { model: ['1', 0], seed, steps: 28, cfg, sampler_name: 'euler', scheduler: 'simple', positive: ['6', 0], negative: ['6', 1], latent_image: ['7', 0], denoise: firstDenoise },
  },
  9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  // 第二段：放大 scale 倍 → 重新编码 → 低 denoise 二次采样
  10: {
    class_type: 'ImageScale',
    inputs: { image: ['9', 0], upscale_method: 'lanczos', width: Math.round((768 * scale) / 64) * 64, height: Math.round((1152 * scale) / 64) * 64, crop: 'disabled' },
  },
  11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['3', 0] } },
  12: {
    class_type: 'KSampler',
    inputs: { model: ['1', 0], seed: seed + 1, steps, cfg, sampler_name: 'euler', scheduler: 'simple', positive: ['6', 0], negative: ['6', 1], latent_image: ['11', 0], denoise },
  },
  13: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['3', 0] } },
  14: { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: tag } },
}

console.log('hires: 768x1152 → ' + Math.round((768 * scale) / 64) * 64 + 'x' + Math.round((1152 * scale) / 64) * 64 + '  denoise ' + denoise + '  steps ' + steps)
if (!GO) { console.log('（预演）加 --go'); process.exit(0) }

try {
  const t0 = Date.now()
  const id = await submit(wf)
  const img = await waitDone(id)
  const url = COMFY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=output'
  const out = Buffer.from(await (await fetch(url)).arrayBuffer())
  fs.mkdirSync(OUT, { recursive: true })
  const f = path.join(OUT, tag + '-' + Date.now() + '.png')
  fs.writeFileSync(f, out)
  console.log('OK ' + f + '  ' + (out.length / 1024 | 0) + ' KB  ' + Math.round((Date.now() - t0) / 1000) + 's')
} catch (e) {
  console.error('X ' + String(e?.message ?? e).slice(0, 300))
  process.exit(1)
}
