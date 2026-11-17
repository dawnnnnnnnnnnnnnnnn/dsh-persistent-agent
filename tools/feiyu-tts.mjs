#!/usr/bin/env node
/**
 * feiyu-tts.mjs —— SSR 角色声音：说话 / 换声 / 唱歌 的统一入口
 *
 * 后端是 WSL 里的 FeiyuVoice 服务（http://127.0.0.1:9880），需要它在跑：
 *   wsl -d Ubuntu-24.04 -- bash /mnt/d/feiyu/wsl-start-service.sh
 *
 * 用法：
 *   node feiyu-tts.mjs "要说的内容"                      默认 cute 声线
 *   node feiyu-tts.mjs "要说的内容" --style gentle
 *   node feiyu-tts.mjs "要说的内容" --send               同时发 QQ 语音条
 *   node feiyu-tts.mjs --caps                           打印服务能力
 *   node feiyu-tts.mjs --health                         健康检查
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WORKSPACE, DSH_HOME, COMFY_ROOT } from '../core/lib/config.mjs'

const BASE = process.env.FEIYU_API || 'http://127.0.0.1:9880'
const KEY_FILE = process.env.FEIYU_KEY_FILE || path.join(WORKSPACE, 'feiyu-voice', 'server', '.runtime', 'voice-service', 'api_key.txt')
const OUT_DIR = process.env.FEIYU_OUT || path.join(WORKSPACE, 'feiyu', 'out')
const TARGET = process.env.AGENT_CHAT_ID || ''
const PY = process.env.COMFY_PY || path.join(COMFY_ROOT, 'python_embeded', 'python.exe')
const NODE = process.execPath

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return null
  const v = args[i + 1]
  args.splice(i, v && !v.startsWith('--') ? 2 : 1)
  return v && !v.startsWith('--') ? v : true
}

function apiKey() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim() } catch { return process.env.FEIYU_API_KEY || '' }
}

async function call(method, p, body, raw = false) {
  const r = await fetch(BASE + p, {
    method,
    headers: { authorization: 'Bearer ' + apiKey(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  })
  if (raw) return { ok: r.ok, status: r.status, buf: Buffer.from(await r.arrayBuffer()) }
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, json: j }
}

async function waitJob(id, timeoutSec = 600) {
  const t0 = Date.now()
  for (;;) {
    const r = await call('GET', '/v1/jobs/' + id)
    const st = r.json?.status
    if (st === 'success') return true
    if (st === 'failed' || st === 'interrupted') throw new Error('任务失败: ' + (r.json?.error || st))
    if ((Date.now() - t0) / 1000 > timeoutSec) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 1500))
  }
}

async function speech(text, style) {
  const sub = await call('POST', '/v1/speech', { text, style, voice: 'feiyu' })
  if (!sub.ok || !sub.json?.id) throw new Error('提交失败: ' + JSON.stringify(sub.json).slice(0, 200))
  await waitJob(sub.json.id)
  const audio = await call('GET', '/v1/jobs/' + sub.json.id + '/audio', null, true)
  if (!audio.ok) throw new Error('取音频失败 HTTP ' + audio.status)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const wav = path.join(OUT_DIR, 'feiyu-' + Date.now() + '.wav')
  fs.writeFileSync(wav, audio.buf)
  return wav
}

function toMp3(wav) {
  const mp3 = wav.replace(/\.wav$/, '.mp3')
  try {
    execFileSync(PY, ['-c', `
import subprocess, sys, imageio_ffmpeg, os
exe = imageio_ffmpeg.get_ffmpeg_exe() if hasattr(imageio_ffmpeg, 'get_ffmpeg_exe') else None
sys.exit(0 if exe else 1)
`], { stdio: 'ignore' })
  } catch {}
  // 用 WSL 的 ffmpeg 转（最快最稳）
  try {
    execFileSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'ffmpeg', '-y', '-loglevel', 'error',
      '-i', wav.replace(/^([A-Z]):/, (m, d) => '/mnt/' + d.toLowerCase()),
      '-b:a', '128k',
      mp3.replace(/^([A-Z]):/, (m, d) => '/mnt/' + d.toLowerCase())], { stdio: 'ignore' })
    if (fs.existsSync(mp3)) return mp3
  } catch {}
  return wav
}

function sendVoice(file) {
  try {
    const out = TARGET ? execFileSync(NODE, [path.join(DSH_HOME, 'bili-whale', 'send-voice.mjs'), TARGET, file], { encoding: 'utf8' }) : 'SKIP'
    return out.trim()
  } catch (e) {
    return '发送失败: ' + String(e.message).slice(0, 100)
  }
}

async function main() {
  if (args.includes('--caps') || args.includes('--health')) {
    const p = args.includes('--caps') ? '/v1/capabilities' : '/health'
    const r = await call('GET', p)
    console.log(JSON.stringify(r.json, null, 1))
    return
  }
  const style = (flag('--style') || 'cute').toString()
  const send = args.includes('--send')
  if (send) args.splice(args.indexOf('--send'), 1)
  const text = args.join(' ').trim()
  if (!text) { console.error('用法: node feiyu-tts.mjs "要说的内容" [--style cute|gentle] [--send]'); process.exit(2) }

  const t0 = Date.now()
  const wav = await speech(text, style)
  const mp3 = toMp3(wav)
  console.log('OK  ' + mp3 + '  (' + Math.round(fs.statSync(mp3).size / 1024) + ' KB, ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)')
  if (send) console.log('QQ: ' + sendVoice(mp3))
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })
