#!/usr/bin/env node
/**
 * sing.mjs —— 把一首歌换成我的嗓子，一条龙。
 *
 * 为什么有这个脚本（早期 定）：
 *   早上那版和 09:02 那版混出来的东西差不多响，但听着不一样。
 *   差别出在「用哪个 python 跑、用哪个参考音色、怎么混」这三处。
 *   这三处只要靠手敲，下次就会跑偏。所以锁进脚本里。
 *
 * 用法：
 *   node sing.mjs --song "{{WORKSPACE}}/path\to\song.wav" --name letmego
 *   node sing.mjs --url "https://www.bilibili.com/video/BVxxx" --name something
 *   node sing.mjs --song ... --name ... --ref ref-agent.wav --steps 24
 *
 * 产物：{{WORKSPACE}}/xi-sing\out\<name>-agent.mp3（同时复制一份到 memory\，方便发语音条）
 *
 * 三条硬规矩（踩过坑）：
 *   1. 转换必须用 {{WORKSPACE}}/xi-sing\venv 里的 python，全局 Python312 没有 torch。
 *   2. 分离人声用 {{WORKSPACE}}/dafeiyu-tts\venv 里的 demucs（xi-sing 那个 venv 没装）。
 *   3. 混音用 normalize=0，否则伴奏会把人声压下去。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { WORKSPACE } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const ROOT = process.env.AGENT_SING_ROOT || path.join(WORKSPACE, 'xi-sing')
const VENV_PY = path.join(ROOT, 'venv', 'Scripts', 'python.exe')
const DEMUCS = process.env.DEMUCS || path.join(WORKSPACE, 'dafeiyu-tts', 'venv', 'Scripts', 'demucs.exe')
const YTDLP = path.join(ROOT, 'bin', 'yt-dlp.exe')
const INFER_DIR = path.join(ROOT, 'seed-vc')
const OUT = path.join(ROOT, 'out')
const TO_MEMORY = path.join(HOME, '.dsh', 'memory')

const argv = process.argv.slice(2)
const arg = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }

let song = arg('--song')
const url = arg('--url')
const name = arg('--name') || 'song'
const ref = arg('--ref', process.env.AGENT_VC_REF || 'reference.wav')
const steps = arg('--steps', '24')

function log(m) { console.log(m) }
function run(cmd, args, cwd) {
  log('  $ ' + path.basename(cmd) + ' ' + args.filter((a) => a.length < 120).join(' '))
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', windowsHide: true })
  if (r.status !== 0) throw new Error(path.basename(cmd) + ' 退出码 ' + r.status)
}

if (!song && !url) {
  console.error('用法: node sing.mjs --song <文件> | --url <链接> --name <名字> [--ref ref-agent.wav] [--steps 24]')
  process.exit(2)
}
for (const f of [VENV_PY, INFER_DIR]) {
  if (!fs.existsSync(f)) { console.error('缺文件：' + f); process.exit(2) }
}
fs.mkdirSync(OUT, { recursive: true })

// 1) 下载（给了链接才做）
if (url) {
  const out = path.join(ROOT, 'src', name + '.%(ext)s')
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true })
  log('① 下载音频')
  run(YTDLP, ['-x', '--audio-format', 'wav', '-o', out, url])
  song = path.join(ROOT, 'src', name + '.wav')
}
if (!fs.existsSync(song)) { console.error('找不到源曲：' + song); process.exit(2) }

// 2) 分人声
const stemDir = path.join(ROOT, 'stems', 'htdemucs', name)
const vocals = path.join(stemDir, 'vocals.wav')
const inst = path.join(stemDir, 'no_vocals.wav')
if (!fs.existsSync(vocals) || !fs.existsSync(inst)) {
  log('② 分离人声 / 伴奏')
  if (!fs.existsSync(DEMUCS)) { console.error('缺 demucs：' + DEMUCS); process.exit(2) }
  run(DEMUCS, ['--two-stems=vocals', '-o', path.join(ROOT, 'stems'), '-n', 'htdemucs', song])
} else {
  log('② 人声已经分过，跳过')
}

// 3) 音色转换（必须 GPU 那套 venv）
log('③ 换成我的嗓子')
run(VENV_PY, [
  'inference.py',
  '--source', vocals,
  '--target', path.join(ROOT, ref),
  '--output', OUT,
  '--diffusion-steps', steps,
  '--inference-cfg-rate', '0.7',
  '--f0-condition', 'True',
  '--auto-f0-adjust', 'False',
  '--fp16', 'True',
], INFER_DIR)

// 找最新出来的那条人声
const cand = fs.readdirSync(OUT)
  .filter((f) => f.startsWith('vc_vocals_') && f.endsWith('.wav'))
  .map((f) => ({ f, m: fs.statSync(path.join(OUT, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)
if (!cand.length) { console.error('转换没有产物'); process.exit(1) }
const vcVocals = path.join(OUT, cand[0].f)
log('  人声：' + cand[0].f)

// 4) 混回伴奏
const mp3 = path.join(OUT, name + '-agent.mp3')
log('④ 混回伴奏')
run('ffmpeg', [
  '-y', '-i', vcVocals, '-i', inst,
  // 最后那个 alimiter 是 早期 补的：头一版 amix 之后峰值冲过 0 dBFS，声音在响处会劈
  '-filter_complex', '[1:a]volume=1.0[bg];[0:a][bg]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95',
  '-b:a', '192k', mp3,
])

// 5) 复制进 memory（发语音条只认工作区里的文件）
const local = path.join(TO_MEMORY, path.basename(mp3))
fs.copyFileSync(mp3, local)
log('完成：' + mp3)
log('已复制：' + local)
