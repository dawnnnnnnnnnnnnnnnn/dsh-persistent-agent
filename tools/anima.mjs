/**
 * anima.mjs —— Anima 底模 + 角色 LoRA 出图（按官方示例工作流搭的）
 *
 * 官方示例里的 Anima 分支（anima_comparison.json）：
 *   UNETLoader anima-*.safetensors + CLIPLoader qwen_3_06b_base(type=stable_diffusion)
 *   VAELoader qwen_image_vae + ModelSamplingAuraFlow(shift 3.0)
 *   EmptyLatentImage 896×1152 + KSampler(er_sde, simple, 30 步, cfg 4)
 *
 * 用法：
 *   node anima.mjs --prompt "1girl, sitting, ..." [--lora <名> --lora-strength 0.9]
 *        [--negative "..."] [--w 896 --h 1152 --steps 30 --cfg 4 --seed 123] [--n 1] [--go]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WORKSPACE, DSH_HOME } from '../core/lib/config.mjs'
// 早期：命令行也要过中文→tag 词典，否则中文提示词会被模型当成漫画分镜
const CJK = await import(pathToFileURL(path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-qwen-paint', 'lib', 'cjk-tags.mjs')).href).catch(() => null)

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const OUT = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')
const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

const prompt = String(arg('--prompt') || '').trim()
const negative = String(arg('--negative') || 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, bad anatomy, extra digits, watermark, text').trim()
const QUALITY = String(arg('--quality') || 'small').toLowerCase()
const BASE = QUALITY === 'final' ? { w: 896, h: 1152 } : { w: 640, h: 896 }
const W = Number(arg('--w') || BASE.w)
const H = Number(arg('--h') || BASE.h)
const steps = Math.max(4, Math.min(60, Number(arg('--steps') || 25)))
const cfg = Math.max(1, Math.min(20, Number(arg('--cfg') || 4)))
const seed = Number(arg('--seed') || Math.floor(Math.random() * 1e9))
const n = Math.max(1, Math.min(4, Number(arg('--n') || 1)))
const tag = String(arg('--tag') || 'anima')
const unet = String(arg('--unet') || 'anima-base-v1.0.safetensors')
const lora = arg('--lora') || process.env.AGENT_LORA || ''
const loraStrength = Number(arg('--lora-strength') || 0.9)   // ：0.9（0.85 到 1.0 是平台期，0.9 综合最好）
const shift = Number(arg('--shift') || 3.0)
// --no-canon：跳过体型/比例约束
const promptTagged = (() => {
  if (!CJK?.augmentPromptWithCjkTags) return prompt
  try { return CJK.augmentPromptWithCjkTags(prompt).prompt } catch { return prompt }
})()

// 角色触发词 / 正典约束：由使用者提供（本项目不带任何角色设定）
const TRIGGER = process.env.AGENT_TRIGGER || ''
const CANON = process.env.AGENT_CANON || ''
const CANON_NEG = process.env.AGENT_CANON_NEG || ''

if (!prompt) { console.error('用法: --prompt "..." [--lora <名> --lora-strength 0.9] [--go]'); process.exit(2) }

async function up() { try { const r = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(4000) }); return r.ok } catch { return false } }
async function submit(wf) {
  const r = await fetch(COMFY + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'anima-' + process.pid }) })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 400))
  return j.prompt_id
}
async function waitDone(id, ms = 600000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const j = await (await fetch(COMFY + '/history/' + id)).json()
    const e = j[id]
    if (e?.outputs) for (const node of Object.values(e.outputs)) if (node.images?.length) return node.images
    if (e?.status?.status_str === 'error') throw new Error('执行出错')
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('超时')
}

if (!(await up())) { console.error('X ComfyUI 没在跑'); process.exit(1) }

// 节点图：unet → (lora) → ModelSamplingAuraFlow → KSampler
let modelSrc = ['1', 0]
let clipSrc = ['2', 0]
const wf = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: clipSrc, text: TRIGGER + promptTagged + CANON } },
  5: { class_type: 'CLIPTextEncode', inputs: { clip: clipSrc, text: negative + CANON_NEG } },
  6: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: n } },
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
  inputs: {
    model: ['8', 0], seed, steps, cfg,
    sampler_name: 'er_sde', scheduler: 'simple',
    positive: ['4', 0], negative: ['5', 0],
    latent_image: ['6', 0], denoise: 1.0,
  },
}
wf[10] = { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } }
wf[11] = { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: tag } }

console.log('Anima: ' + unet + (lora ? ' + LoRA ' + lora + '@' + loraStrength : ' (无 LoRA)'))
console.log('  ' + W + '×' + H + '  steps ' + steps + '  cfg ' + cfg + '  shift ' + shift + '  seed ' + seed)
if (!GO) { console.log('（预演）加 --go'); process.exit(0) }

try {
  const t0 = Date.now()
  // 早期：把工作流一起存下来 —— ComfyUI 重启会丢历史，参数不能跟着丢
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, tag + '-' + Date.now() + '.workflow.json'), JSON.stringify(wf, null, 2), 'utf8') } catch {}
  const id = await submit(wf)
  const imgs = await waitDone(id)
  fs.mkdirSync(OUT, { recursive: true })
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
  console.error('X ' + String(e?.message ?? e).slice(0, 400))
  process.exit(1)
}
