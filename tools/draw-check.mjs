#!/usr/bin/env node
/**
 * draw-check.mjs —— 出图功能的体检（30 秒内跑完，不生成图片）
 *
 * 检查项：
 *   1. ComfyUI 在线
 *   2. 模型文件齐全（anima / text encoder / vae / 两个 LoRA）
 *   3. 插件补丁标记齐全（Anima 引擎 / 姿势 / CJK / 单主体 / 服装开关 / 体型参数 / 特征修正）
 *   4. 参考库有条目（image-studio）
 *   5. 清理任务与自愈任务在
 *
 * 用法：node draw-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE, COMFY_ROOT } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const COMFY = path.join(COMFY_ROOT, 'ComfyUI')
const rows = []
const add = (ok, name, detail = '') => rows.push({ ok, name, detail })

async function comfyUp() {
  try {
    const r = await fetch('http://127.0.0.1:8188/system_stats', { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

const files = [
  ['底模 anima', COMFY + '/models/diffusion_models/anima-base-v1.0.safetensors', 3.5e9],
  ['文本编码器', COMFY + '/models/text_encoders/qwen_3_06b_base.safetensors', 1.0e9],
  ['VAE', COMFY + '/models/vae/qwen_image_vae.safetensors', 2.0e8],
]
for (const [name, p, min] of files) {
  let ok = false
  let detail = '缺失'
  try {
    const st = fs.statSync(p)
    ok = st.size >= min
    detail = (st.size / 1e9).toFixed(2) + ' GB'
  } catch {}
  add(ok, name, detail)
}

const plugin = path.join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-qwen-paint', 'lib', 'index.js')
const marks = [
  ['Anima 引擎', 'buildAnimaWorkflow'],
  ['style 参数', "enum: ['anime', 'real']"],
  ['姿势强化', 'poseBoost'],
  ['中文词典', 'cjkAugment'],
  ['单人守卫', 'soloGuard'],
  ['服装开关', 'outfitToggle'],
  ['体型参数', 'bodyScale'],
  ['特征修正', 'featurePrompt'],
]
let src = ''
try { src = fs.readFileSync(plugin, 'utf8') } catch {}
for (const [name, needle] of marks) add(src.includes(needle), '插件补丁 · ' + name, src.includes(needle) ? '在' : '缺')

const lib = path.join(HOME, '.dsh', 'image-studio', 'library')
for (const cat of ['characters', 'outfits']) {
  let n = 0
  try { n = fs.readdirSync(path.join(lib, cat)).filter((d) => fs.existsSync(path.join(lib, cat, d, 'entry.json'))).length } catch {}
  add(n > 0, '参考库 ' + cat, n + ' 条')
}

for (const [name, rel] of [['hires-anima 二次采样','hires-anima.mjs'],['脸部裁切','face-crop.py'],['脸部贴回','face-paste.py']]) {
  add(fs.existsSync(path.join(HOME, '.dsh', 'bili-whale', rel)), name, fs.existsSync(path.join(HOME, '.dsh', 'bili-whale', rel)) ? '在' : '缺')
}

const up = await comfyUp()
add(up, 'ComfyUI 在线', up ? '8188' : '没起来（出图前会自己启）')

const out = rows.map((r) => (r.ok ? '✓' : '✗') + ' ' + r.name + (r.detail ? '  ' + r.detail : ''))
console.log(out.join('\n'))
const bad = rows.filter((r) => !r.ok)
console.log('\n' + (bad.length ? '✗ ' + bad.length + ' 项需要处理：' + bad.map((b) => b.name).join(', ') : '✓ 全部通过（' + rows.length + ' 项）'))
process.exit(bad.length ? 1 : 0)
