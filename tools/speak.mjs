#!/usr/bin/env node
/**
 * speak.mjs —— 一句话走完整链路：SSR 声音合成 → 本地播放 + Live2D 口型 → 可选发 QQ
 *
 * 用法：
 *   node speak.mjs "要说的内容"                     本地播放 + 口型
 *   node speak.mjs "要说的内容" --style gentle
 *   node speak.mjs "要说的内容" --send               同时发 QQ 语音条
 *   node speak.mjs --wav {{WORKSPACE}}/path\x.wav              直接用一个已有音频驱动口型
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { WORKSPACE, DSH_HOME, COMFY_ROOT } from '../core/lib/config.mjs'
import path from 'node:path'

const NODE = process.execPath
const PY = process.env.COMFY_PY || path.join(COMFY_ROOT, 'python_embeded', 'python.exe')
const TTS = path.join(DSH_HOME, 'bili-whale', 'feiyu-tts.mjs')
const SAY = path.join(DSH_HOME, 'bili-whale', 'vts-say.py')

const args = process.argv.slice(2)
const takeFlag = (n) => {
  const i = args.indexOf(n)
  if (i === -1) return null
  const v = args[i + 1]
  args.splice(i, v && !v.startsWith('--') ? 2 : 1)
  return v && !v.startsWith('--') ? v : true
}

const style = takeFlag('--style') || 'cute'
const wavArg = takeFlag('--wav')
const send = args.includes('--send')
if (send) args.splice(args.indexOf('--send'), 1)
const text = args.join(' ').trim()

let wav = wavArg

if (!wav) {
  if (!text) { console.error('用法: node speak.mjs "内容" [--style cute|gentle] [--send]'); process.exit(2) }
  const out = execFileSync(NODE, [TTS, text, '--style', String(style)], { encoding: 'utf8' })
  const m = out.match(/OK\s+(\S+\.(?:wav|mp3))/)
  if (!m) { console.error('合成失败:\n' + out); process.exit(1) }
  wav = m[1]
  console.log('  合成: ' + wav)
}

if (!fs.existsSync(wav)) { console.error('音频不存在: ' + wav); process.exit(1) }

// 口型 + 播放
const sayArgs = [SAY, '--wav', wav]
execFileSync(PY, sayArgs, { stdio: 'inherit' })

if (send) {
  const out = TARGET ? execFileSync(NODE, [path.join(DSH_HOME, 'bili-whale', 'send-voice.mjs'), TARGET, wav], { encoding: 'utf8' }) : 'SKIP'
  console.log('  QQ: ' + out.trim())
}
