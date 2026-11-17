#!/usr/bin/env node
/**
 * draw.mjs —— 绘图（两档）
 *
 *   本地档（默认）：不经过这个脚本 —— 用 dsh-qwen-paint 的 draw_image 工具（ComfyUI 本地出图，不花钱）
 *   高档（GPT）：   这个脚本负责。（可自定义）**每次用前要他批准，但数量不限**
 *
 * 为什么高档要单独一个脚本：要把「批准」做成机制，而不是靠自觉。
 *   ① 她先问他 → 他同意 → `draw.mjs approve` 写一个 10 分钟有效的令牌
 *   ② `draw.mjs hq --prompt "..." --go` 凭令牌出图；没有令牌直接退出
 *
 * 用法：
 *   node draw.mjs check                       看配置齐不齐、网络通不通（不花钱）
 *   node draw.mjs approve                     他同意了，发令牌
 *   node draw.mjs hq --prompt "..." --go      出图（--size 1024x1024 可选）
 *   node draw.mjs hq --prompt "..." --go --n 2
 *
 * 配置来源（按优先级）：环境变量 > ~/.gateway.env
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_IMAGE_MODEL
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const ENV_FILE = path.join(HOME, '.gateway.env')
const TOKEN = path.join(DSH, 'agent-core', 'draw-token.json')
const OUT_DIR = process.env.AGENT_IMAGES_OUT || path.join(WORKSPACE, 'dsh-data', 'images')

// 早期：本地生图受「亲密模式」约束 —— 内容敏感的图只有使用者私聊、且开关开着才放行。
// 判定交给 intimate.mjs（唯一开关来源），这里只读它的结果。
function intimateGate() {
  try {
    const st = path.join(HOME, '.dsh', 'agent-core', 'intimate.json')
    const j = JSON.parse(fs.readFileSync(st, 'utf8'))
    return j.enabled === true && Number(j.expiresAt ?? 0) > Date.now()
  } catch { return false }
}
function assertIntimate(flag) {
  if (!flag) return true
  if (intimateGate()) return true
  console.error('✗ 这类内容只在使用者私聊、且亲密模式开着时才能做：先 node intimate.mjs on')
  return false
}
const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const flag = (k) => argv.includes(k)

function envFromFile() {
  const out = {}
  try {
    // 注意：Windows 的 .env 是 CRLF，JS 正则里 . 不匹配 \r，按 \n 切会让每行末尾留一个 \r → 整行匹配失败。
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
  return out
}
const fileEnv = envFromFile()
const KEY = process.env.OPENAI_API_KEY || fileEnv.OPENAI_API_KEY || ''
const BASE = (process.env.OPENAI_BASE_URL || fileEnv.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = process.env.OPENAI_IMAGE_MODEL || fileEnv.OPENAI_IMAGE_MODEL || 'gpt-image-1'

if (cmd === 'check' || !cmd) {
  console.log('== 绘图高档（GPT）体检 ==')
  console.log('  base   :', BASE)
  console.log('  model  :', MODEL)
  console.log('  key    :', KEY ? ('有（' + KEY.slice(0, 3) + '…，长度 ' + KEY.length + '）') : '**没有** → 在 ~/.gateway.env 填 OPENAI_API_KEY')
  console.log('  输出目录:', OUT_DIR)
  if (!KEY) { console.log('\n✗ 缺 key，出不了图'); process.exit(1) }
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 12000)
    const r = await fetch(BASE + '/models', { headers: { authorization: 'Bearer ' + KEY }, signal: ctl.signal })
    clearTimeout(t)
    console.log('  连通性 :', 'HTTP ' + r.status + (r.ok ? ' ✓' : ' ✗'))
    if (!r.ok) console.log('           ', (await r.text()).slice(0, 160).replace(/\s+/g, ' '))
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    console.log('  连通性 : ✗ ' + String(e?.message ?? e).slice(0, 120))
    console.log('            （连不上通常是没开代理，或 base 写错）')
    process.exit(1)
  }
}

if (cmd === 'approve') {
  fs.mkdirSync(path.dirname(TOKEN), { recursive: true })
  fs.writeFileSync(TOKEN, JSON.stringify({ at: new Date().toISOString(), expiresAt: Date.now() + 10 * 60 * 1000 }) + '\n')
  console.log('✓ 已批准出图（10 分钟内有效，次数不限）')
  process.exit(0)
}

if (cmd === 'hq') {
  const prompt = String(arg('--prompt') || '').trim()
  if (!assertIntimate(flag('--intimate'))) process.exit(4)
  const size = String(arg('--size') || '1024x1024')
  const n = Math.max(1, Math.min(4, Number(arg('--n') || 1)))
  const GO = flag('--go')
  if (!prompt) { console.error('用法: hq --prompt "..." [--size 1024x1024] [--n 1] --go'); process.exit(2) }

  let tok = {}
  try { tok = JSON.parse(fs.readFileSync(TOKEN, 'utf8')) } catch {}
  if (Number(tok.expiresAt ?? 0) < Date.now()) {
    console.error('✗ 没有有效批准：先问他，同意后跑 node draw.mjs approve')
    process.exit(3)
  }
  if (!KEY) { console.error('✗ 没配 OPENAI_API_KEY（~/.gateway.env）'); process.exit(1) }

  if (!GO) {
    console.log('（预演）会调用：' + BASE + '/images/generations')
    console.log('  model=' + MODEL + '  size=' + size + '  n=' + n)
    console.log('  prompt=' + prompt.slice(0, 160))
    console.log('加 --go 才真出图。')
    process.exit(0)
  }

  let data = null
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 180000)
    const r = await fetch(BASE + '/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, prompt, n, size }),
      signal: ctl.signal,
    })
    clearTimeout(t)
    const txt = await r.text()
    if (!r.ok) {
      console.error('✗ HTTP ' + r.status + '：' + txt.slice(0, 220).replace(/\s+/g, ' '))
      process.exit(1)
    }
    data = JSON.parse(txt)
  } catch (e) {
    console.error('✗ 请求失败：' + String(e?.message ?? e).slice(0, 160))
    process.exit(1)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let saved = 0
  for (const [i, item] of (data?.data ?? []).entries()) {
    try {
      if (item.b64_json) {
        const f = path.join(OUT_DIR, `gpt-${stamp}-${i}.png`)
        fs.writeFileSync(f, Buffer.from(item.b64_json, 'base64'))
        console.log('✓ ' + f)
        saved += 1
      } else if (item.url) {
        const r = await fetch(item.url)
        const buf = Buffer.from(await r.arrayBuffer())
        const f = path.join(OUT_DIR, `gpt-${stamp}-${i}.png`)
        fs.writeFileSync(f, buf)
        console.log('✓ ' + f)
        saved += 1
      }
    } catch (e) { console.error('  保存失败：' + String(e?.message ?? e).slice(0, 100)) }
  }
  if (!saved) { console.error('✗ 没拿到图片数据'); process.exit(1) }
  // 早期：批准是「一次批准、10 分钟内次数不限」——不要因为出图成功就把令牌删掉
  console.log('共 ' + saved + ' 张，目录：' + OUT_DIR)
  process.exit(0)
}

console.error('用法: check | approve | hq --prompt "..." --go')
process.exit(2)
