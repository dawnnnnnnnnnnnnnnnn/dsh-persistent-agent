/**
 * 抗造工具 —— 插件里所有 I/O 都走这里，保证不会因为一个坏文件/满磁盘把宿主拖死。
 */
import fs from 'node:fs'
import path from 'node:path'

export const clamp = (n, min, max, fallback) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

export function safeRead(file, max = 2_000_000) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > max) return ''
    return fs.readFileSync(file, 'utf8')
  } catch { return '' }
}

export function readJsonSafe(file, fallback = null) {
  const t = safeRead(file)
  if (!t) return fallback
  try { return JSON.parse(t) } catch { return fallback }
}

/** 原子写：先写 .tmp 再 rename，避免读到半个文件（DSH 同时读 prompt.txt 时会踩到） */
export function writeAtomic(file, text) {
  try {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
    return true
  } catch { return false }
}

export function appendLog(file, line, maxBytes = 512_000) {
  try {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    try {
      const st = fs.statSync(file)
      if (st.size > maxBytes) {
        // 保留最后 1/4，防日志无限涨
        const keep = fs.readFileSync(file, 'utf8').slice(-Math.floor(maxBytes / 4))
        fs.writeFileSync(file, keep)
      }
    } catch {}
    fs.appendFileSync(file, line)
  } catch {}
}

/** 简易退避：连续失败 n 次后，间隔翻倍，最多 8 倍 */
export function backoffMs(baseMs, failures) {
  const mult = Math.min(8, Math.max(1, 2 ** Math.min(3, failures | 0)))
  return baseMs * mult
}
