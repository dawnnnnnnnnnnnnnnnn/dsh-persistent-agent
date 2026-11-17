/**
 * sdxl.mjs —— 用 SDXL 系底模出图（NoobAI / Illustrious 这类二次元模型）
 *
 * 和 img2img.mjs 的区别：这个是 **CheckpointLoader**（整套 SDXL），
 * 不是 Qwen 那套 UNETLoader + 专用文本编码节点。
 *
 * 用法：
 *   node sdxl.mjs --ckpt NoobAI-XL-v1.1.safetensors \
 *        --prompt "1girl, solo, ..." --negative "lowres, bad anatomy, ..." \
 *        [--w 832 --h 1216 --steps 28 --cfg 6.5 --seed 12345] [--go]
 */
import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE } from '../core/lib/config.mjs'

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const OUT = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')
const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const GO = argv.includes('--go')

const ckpt = arg('--ckpt')
const prompt = String(arg('--prompt') || '').trim()
const negative = String(arg('--negative') || 'lowres, bad anatomy, bad hands, extra digits, watermark, text, jpeg artifacts').trim()
const W = Number(arg('--w') || 832)
const H = Number(arg('--h') || 1216)
const steps = Math.max(1, Math.min(60, Number(arg('--steps') || 28)))
const cfg = Math.max(1, Math.min(15, Number(arg('--cfg') || 6.5)))
const seed = Number(arg('--seed') || Math.floor(Math.random() * 1e9))
const sampler = String(arg('--sampler') || 'euler_ancestral')
const scheduler = String(arg('--scheduler') || 'karras')
const tag = String(arg('--tag') || 'sdxl')
const n = Math.max(1, Math.min(4, Number(arg('--n') || 1)))

if (!ckpt || !prompt) { console.error('用法: --ckpt <底模> --prompt "..." [--go]'); process.exit(2) }

async function up() { try { const r = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(4000) }); return r.ok } catch { return false } }
async function submit(wf) {
  const r = await fetch(COMFY + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'sdxl-' + process.pid }) })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 400))
  return j.prompt_id
}
async function waitDone(id, ms = 400000) {
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

const wf = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
  2: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: prompt } },
  3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: negative } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: n } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], seed, steps, cfg,
      sampler_name: sampler, scheduler,
      positive: ['2', 0], negative: ['3', 0],
      latent_image: ['4', 0], denoise: 1.0,
    },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: tag } },
}

console.log('底模 ' + ckpt + '  尺寸 ' + W + '×' + H + '  steps ' + steps + '  cfg ' + cfg + '  seed ' + seed)
if (!GO) { console.log('（预演）加 --go 才真跑'); process.exit(0) }

try {
  const t0 = Date.now()
  const id = await submit(wf)
  const imgs = await waitDone(id)
  fs.mkdirSync(OUT, { recursive: true })
  for (const img of imgs) {
    const url = COMFY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=output'
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    const f = path.join(OUT, tag + '-' + Date.now() + '-' + imgs.indexOf(img) + '.png')
    fs.writeFileSync(f, buf)
    console.log('OK ' + f + '  ' + (buf.length / 1024 | 0) + ' KB')
  }
  console.log('用时 ' + Math.round((Date.now() - t0) / 1000) + 's')
} catch (e) {
  console.error('X ' + String(e?.message ?? e).slice(0, 300))
  process.exit(1)
}
