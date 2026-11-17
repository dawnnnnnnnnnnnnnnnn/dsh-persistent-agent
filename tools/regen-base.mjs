/**
 * regen-base.mjs —— 把「只用了 aesthetic 新模型」的图，用旧模型 anima-base-v1.0 补一份
 *
 * 读 {{WORKSPACE}}/backup/aesthetic-inventory.json（_inventory.mjs 生成），逐条用原 prompt/seed/步数/cfg 重跑，
 * 只把底模换成 base。产物 tag 前缀由 AGENT_OLD_PREFIX 决定（默认 old-）。
 *
 * 用法：node regen-base.mjs [--limit N] [--dry]
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { WORKSPACE, cfg, DSH_HOME } from '../core/lib/config.mjs'
import path from 'node:path'

const DIR = path.join(WORKSPACE, 'dsh-data', 'images')
const INV = path.join(WORKSPACE, 'backup', 'aesthetic-inventory.json')
const LOG = path.join(WORKSPACE, 'backup', 'regen-base.log')
const ANIMA = path.join(DSH_HOME, 'bili-whale', 'anima.mjs')
const NODE = process.execPath

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const li = argv.indexOf('--limit')
const LIMIT = li >= 0 ? Number(argv[li + 1]) : 999

const inv = JSON.parse(fs.readFileSync(INV, 'utf8'))

/**
 * 旧模型（base v1.0）自己的最佳参数 —— 不继承 Aesthetic 的调参。
 * Aesthetic 那套是 0.88 / cfg 4.4 / 34 步（为了压住它过软的画风）；
 * base 不用那些，用它一直在用的 0.9 / cfg 4.3 / 32 步。
 */
const BASE_PROFILE = { lora: 0.9, cfg: 4.3, steps: 32, sampler: 'er_sde' }
function log(s) {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${s}`
  fs.appendFileSync(LOG, line + '\n')
  console.log(line)
}

// 已有的 base 产物（按 seed 去重）
const existing = new Set()
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.png')) continue
  if (new RegExp('^' + (process.env.AGENT_OLD_PREFIX || 'old-')).test(f)) {
    const m = f.match(/-s(\d+)-/)
    if (m) existing.add(m[1])
  }
}

let done = 0
let skip = 0
let fail = 0
for (const rec of inv) {
  if (done >= LIMIT) break
  const baseTag = (process.env.AGENT_OLD_PREFIX || 'old-') + (rec.file.match(/^(.+?)-\d{13}/) ? rec.file.match(/^(.+?)-\d{13}/)[1] : rec.file).replace(/\.workflow\.json$/, '')
  if (existing.has(String(rec.seed))) { skip++; continue }
  if (DRY) { console.log('（预演）' + baseTag + ' seed=' + rec.seed); done++; continue }

  const args = [
    ANIMA,
    '--prompt', rec.prompt,
    '--negative', rec.negative,
    '--unet', 'anima-base-v1.0.safetensors',
    '--lora', rec.lora?.name || process.env.AGENT_LORA || '',
    '--lora-strength', String(BASE_PROFILE.lora),
    '--steps', String(BASE_PROFILE.steps),
    '--cfg', String(BASE_PROFILE.cfg),
    '--sampler', String(BASE_PROFILE.sampler),
    '--seed', String(rec.seed),
    '--w', String(rec.w ?? 896),
    '--h', String(rec.h ?? 1152),
    '--tag', baseTag,
    '--go',
  ]
  const r = spawnSync(NODE, args, { encoding: 'utf8', timeout: 300000 })
  const out = (r.stdout || '') + (r.stderr || '')
  if (out.includes('OK ')) { done++; log('OK ' + baseTag + ' seed=' + rec.seed) }
  else { fail++; log('NG ' + baseTag + ' seed=' + rec.seed + ' :: ' + out.slice(-160).replace(/\n/g, ' ')) }
}
log(`结束：成功 ${done} / 跳过 ${skip} / 失败 ${fail}`)
