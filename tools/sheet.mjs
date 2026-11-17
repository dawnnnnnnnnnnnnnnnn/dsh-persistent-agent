#!/usr/bin/env node
/**
 * sheet.mjs —— 把表情包拼成"联系人表"（每张 4×4=16 格），方便一次性看一批。
 * 输出：~/.dsh/bili-whale/stickers/_sheets/sheet-01.png ...
 * 同时写 _sheets/map-01.json：格子序号 → 贴纸 hash
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.USERPROFILE || ''
const DIR = path.join(HOME, '.dsh', 'bili-whale', 'stickers')
const OUT = path.join(DIR, '_sheets')
const FRAMES = path.join(OUT, 'frames')
const per = 16
const cols = 4

fs.mkdirSync(FRAMES, { recursive: true })
const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'))
const items = idx.items
console.log('总数:', items.length)

// 1) 抽首帧（缩到 160x160，统一尺寸，保证拼图整齐）
const frames = []
for (let i = 0; i < items.length; i++) {
  const it = items[i]
  const src = path.join(DIR, it.file)
  const dst = path.join(FRAMES, String(i).padStart(3, '0') + '.png')
  if (!fs.existsSync(dst)) {
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vframes', '1',
        '-vf', 'scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2:color=0x222222',
        dst], { windowsHide: true, timeout: 30000 })
    } catch { /* 坏图跳过 */ }
  }
  if (fs.existsSync(dst)) frames.push({ i, hash: it.hash, png: dst })
}
console.log('抽到首帧:', frames.length)

// 2) 每 16 张拼一张表
const sheets = []
for (let s = 0; s * per < frames.length; s++) {
  const batch = frames.slice(s * per, s * per + per)
  const n = batch.length
  const rows = Math.ceil(n / cols)
  const listFile = path.join(OUT, `list-${String(s + 1).padStart(2, '0')}.txt`)
  fs.writeFileSync(listFile, batch.map((b) => "file '" + b.png.replace(/\\/g, '/') + "'").join('\n') + '\n')
  const out = path.join(OUT, `sheet-${String(s + 1).padStart(2, '0')}.png`)
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `tile=${cols}x${rows}:padding=4:margin=4:color=0x111111`, '-frames:v', '1', out],
      { windowsHide: true, timeout: 60000 })
  } catch (e) { console.log('拼图失败', out, e.message) }
  fs.writeFileSync(path.join(OUT, `map-${String(s + 1).padStart(2, '0')}.json`),
    JSON.stringify(batch.map((b) => ({ hash: b.hash, file: items[b.i].file })), null, 2))
  sheets.push(out)
}
console.log('生成表:', sheets.length)
sheets.forEach((s) => console.log(' ', s))
