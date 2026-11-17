#!/usr/bin/env node
/**
 * face.mjs —— 中文情绪 → VTS 表情（供其它脚本一行调用，异步不等）
 *
 * 用法：
 *   node face.mjs 害羞
 *   node face.mjs happy
 *   node face.mjs --clear
 *
 * 设计：把 VTS 那套 python 调用包成 fire-and-forget，调用方不必等（不会拖慢聊天）。
 */
import { spawn } from 'node:child_process'
import { DSH_HOME, COMFY_ROOT } from '../core/lib/config.mjs'
import path from 'node:path'

const PY = process.env.COMFY_PY || path.join(COMFY_ROOT, 'python_embeded', 'python.exe')
const CLI = process.env.VTS_CLI || path.join(DSH_HOME, 'bili-whale', 'vts-cli.py')

// 中文/英文 → vts-cli 的 mood 名
const MAP = [
  [/害羞|脸红|羞|不好意思|shy/, 'shy'],
  [/开心|高兴|笑|好耶|喜欢|happy|happy|glad/, 'happy'],
  [/可爱|撒娇|卖萌|cute/, 'cute'],
  [/爱|心动|lo ve|love|heart/, 'love'],
  [/难过|低落|想你|sad/, 'sad'],
  [/哭|委屈|被骂|难过死|cry/, 'cry'],
  [/生气|讨厌|哼|angry|mad/, 'angry'],
  [/想|思考|琢磨|thinking|hmm/, 'thinking'],
  [/认真|严肃|工作|serious/, 'serious'],
  [/晕|转圈|懵|dizzy|confus/, 'dizzy'],
  [/惊|诶|欸|surprise|what/, 'surprised'],
  [/紧张|慌|冷汗|nervous|anxious/, 'nervous'],
  [/哼|嘟嘴|不满|pout/, 'pout'],
]

export function moodOf(text = '') {
  const t = String(text)
  for (const [re, mood] of MAP) if (re.test(t)) return mood
  return ''
}

export function face(emotionOrText, opts = {}) {
  const mood = MAP.some(([re]) => re.source === String(emotionOrText)) ? emotionOrText : (moodOf(emotionOrText) || String(emotionOrText || '').trim())
  if (!mood) return
  const args = [CLI]
  if (mood === '--clear') args.push('clear')
  else args.push('mood', mood)
  const child = spawn(PY, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  if (opts.log) console.log('face → ' + mood)
}

// 直接跑：node face.mjs 害羞
if (process.argv[1] && process.argv[1].endsWith('face.mjs')) {
  const arg = process.argv[2] || ''
  if (!arg) { console.error('用法: node face.mjs <情绪词> | --clear'); process.exit(2) }
  face(arg, { log: true })
}
