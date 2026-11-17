#!/usr/bin/env node
/**
 * 出图器（通用 OpenAI 兼容版）—— 接哪家都行，只认 images/generations。
 *
 * 用法：
 *   node imagegen.mjs --prompt "一个卡通角色在键盘上睡觉" [--size 1024x1024] [--n 1] [--out 名字.png]
 *   node imagegen.mjs --edit 原图.png --prompt "改成水彩风"
 *
 * 配置（读 ~/.gateway.env，也认环境变量）：
 *   OPENAI_API_KEY     密钥
 *   OPENAI_BASE_URL    例如 https://api.siliconflow.cn/v1
 *   OPENAI_IMAGE_MODEL 例如 Kwai-Kolors/Kolors
 *
 * 成功打印本地路径；失败原样打印 HTTP 状态和响应体。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DSH_HOME } from '../core/lib/config.mjs'

const OUT_DIR = process.env.AGENT_IMAGES_OUT || path.join(DSH_HOME, 'shots', 'imagegen')

async function readEnvFile(p) {
  try {
    const text = await readFile(p, 'utf8')
    const out = {}
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i === -1) continue
      let v = t.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[t.slice(0, i).trim()] = v
    }
    return out
  } catch { return {} }
}

const envFiles = [path.join(os.homedir(), '.gateway.env'), path.join(process.cwd(), '.env')]
const env = {}
for (const f of envFiles) Object.assign(env, await readEnvFile(f))

const KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || ''
const BASE = (process.env.OPENAI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = process.env.OPENAI_IMAGE_MODEL || env.OPENAI_IMAGE_MODEL || 'gpt-image-1'

const argv = process.argv.slice(2)
const arg = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i === -1 ? def : (argv[i + 1] ?? def)
}

const prompt = arg('prompt')
if (!prompt) {
  console.error('缺 --prompt')
  process.exit(2)
}
if (!KEY) {
  console.error('还没配密钥：把 OPENAI_API_KEY 填进 ' + path.join(os.homedir(), '.gateway.env'))
  console.error('当前 BASE=' + BASE + ' MODEL=' + MODEL)
  process.exit(3)
}

const size = arg('size', '1024x1024')
const n = Number(arg('n', 1))
const editFrom = arg('edit')

async function callJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}\n${text.slice(0, 800)}`)
  return JSON.parse(text)
}

async function callMultipart(url, fields, filePath) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v))
  const buf = await readFile(filePath)
  fd.append('image', new Blob([buf]), path.basename(filePath))
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}\n${text.slice(0, 800)}`)
  return JSON.parse(text)
}

await mkdir(OUT_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const outBase = arg('out') || `img-${stamp}.png`

let data
if (editFrom) {
  if (!existsSync(editFrom)) { console.error('原图不存在: ' + editFrom); process.exit(4) }
  data = await callMultipart(`${BASE}/images/edits`, { model: MODEL, prompt, size, n }, editFrom)
} else {
  data = await callJson(`${BASE}/images/generations`, { model: MODEL, prompt, size, n })
}

const items = data.data || data.images || []
if (!items.length) {
  console.error('返回里没有图：' + JSON.stringify(data).slice(0, 600))
  process.exit(5)
}

let idx = 0
for (const it of items) {
  const p = path.join(OUT_DIR, idx === 0 ? outBase : outBase.replace(/(\.\w+)$/, `-${idx}$1`))
  if (it.b64_json) {
    await writeFile(p, Buffer.from(it.b64_json, 'base64'))
  } else if (it.url) {
    const r = await fetch(it.url)
    if (!r.ok) { console.error('下载失败 ' + r.status + ' ' + it.url); continue }
    await writeFile(p, Buffer.from(await r.arrayBuffer()))
  } else {
    console.error('这条没有图数据：' + JSON.stringify(it).slice(0, 300))
    continue
  }
  console.log(p)
  idx++
}
