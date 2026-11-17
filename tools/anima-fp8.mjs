/**
 * anima-fp8.mjs — 和 anima.mjs 同一套工作流，只是 UNETLoader 用 fp8_e4m3fn 载入
 * 目的：16G 内存机器上把底模从 ~4.1GB 压到 ~2GB，绕开动态加载读取失败
 * 用法：node anima-fp8.mjs --prompt "..." [--lora <名> --lora-strength 0.9] [--negative "..."] [--w 896 --h 1152 --steps 30 --cfg 4 --seed 1] [--go]
 */
import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE } from '../core/lib/config.mjs'

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const OUT = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')
const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

const prompt = String(arg('--prompt') || '').trim()
const negative = String(arg('--negative') || 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, bad anatomy, extra digits, watermark, text').trim()
const W = Number(arg('--w') || 896)
const H = Number(arg('--h') || 1152)
const steps = Math.max(4, Math.min(60, Number(arg('--steps') || 30)))
const cfg = Math.max(1, Math.min(20, Number(arg('--cfg') || 4)))
const seed = Number(arg('--seed') || Math.floor(Math.random() * 1e9))
const unet = String(arg('--unet') || 'anima-base-v1.0.safetensors')
const lora = arg('--lora')
const loraStrength = Number(arg('--lora-strength') || 0.9)
const shift = Number(arg('--shift') || 3.0)
const dtype = String(arg('--dtype') || 'fp8_e4m3fn')

if (!prompt) { console.error('用法: --prompt "..." [--lora <名>] [--go]'); process.exit(2) }

async function up() { try { const r = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(4000) }); return r.ok } catch { return false } }

let modelSrc = ['1', 0]
let clipSrc = ['2', 0]
const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: dtype } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: clipSrc, text: prompt } },
  5: { class_type: 'CLIPTextEncode', inputs: { clip: clipSrc, text: negative } },
  6: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
}
if (lora) {
  wf[7] = { class_type: 'LoraLoader', inputs: { model: modelSrc, clip: clipSrc, lora_name: lora, strength_model: loraStrength, strength_clip: loraStrength } }
  modelSrc = ['7', 0]
  clipSrc = ['7', 1]
  wf[4].inputs.clip = clipSrc
  wf[5].inputs.clip = clipSrc
}
wf[8] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: modelSrc, shift } }
wf[9] = {
  class_type: 'KSampler',
  inputs: { model: ['8', 0], seed, steps, cfg, sampler_name: 'er_sde', scheduler: 'simple', positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], denoise: 1.0 },
}
wf[10] = { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } }
wf[11] = { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: 'animafp8' } }

console.log('Anima(fp8): ' + unet + ' dtype=' + dtype + (lora ? ' + LoRA ' + lora + '@' + loraStrength : ''))
console.log('  ' + W + 'x' + H + '  steps ' + steps + '  cfg ' + cfg + '  seed ' + seed)
if (!GO) { console.log('（预演）加 --go'); process.exit(0) }
if (!(await up())) { console.error('X ComfyUI 没在跑'); process.exit(1) }

const t0 = Date.now()
const r = await fetch(COMFY + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'animafp8-' + process.pid }) })
const j = await r.json()
if (!r.ok) { console.error('X 提交失败 ' + JSON.stringify(j).slice(0, 500)); process.exit(1) }
const id = j.prompt_id
let imgs = null
while (Date.now() - t0 < 600000) {
  const h = await (await fetch(COMFY + '/history/' + id)).json()
  const e = h[id]
  if (e?.outputs) for (const node of Object.values(e.outputs)) if (node.images?.length) { imgs = node.images; break }
  if (imgs) break
  if (e?.status?.status_str === 'error') { console.error('X 执行出错'); process.exit(1) }
  await new Promise((res) => setTimeout(res, 1500))
}
if (!imgs) { console.error('X 超时'); process.exit(1) }
fs.mkdirSync(OUT, { recursive: true })
let i = 0
for (const img of imgs) {
  const url = COMFY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=output'
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  const f = path.join(OUT, 'animafp8-' + Date.now() + '-' + i + '.png')
  fs.writeFileSync(f, buf)
  console.log('OK ' + f + '  ' + (buf.length / 1024 | 0) + ' KB')
  i++
}
console.log('用时 ' + Math.round((Date.now() - t0) / 1000) + 's')
