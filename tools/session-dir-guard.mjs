#!/usr/bin/env node
/**
 * session-dir-guard.mjs —— 检查「会话目录名 == 内部 session id」
 *
 * 早期 事故记录：
 *   我把 sessions\--C-Users-<user>-.dsh-memory--\bili-whale 改名成 bili-whale-old-20261026，
 *   目录名和 session.v4 里的 id 对不上 → 工作区/目录选择服务启动失败 → DSH 起不来。
 *   教训：sessions 目录里的文件夹名 = 会话 id，**任何情况下不许改名**。
 *
 * 这个脚本只读：扫每个会话目录，解出 session.v4 头里的 id，跟目录名比对，不一致就报。
 * 用法：node session-dir-guard.mjs [--fix-name]   （--fix-name 会把目录名改回内部 id）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { WORKSPACE } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const ROOTS = [
  path.join(HOME, '.dsh', 'sessions'),
  path.join(WORKSPACE, 'dsh-data', 'sessions'),
]
const FIX = process.argv.includes('--fix-name')

function readHeaderId(file) {
  try {
    const buf = fs.readFileSync(file)
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const i = buf.indexOf(magic)
    if (i < 0) return null
    const out = zlib.zstdDecompressSync(buf.subarray(i, Math.min(buf.length, i + 64 * 1024))).toString('utf8')
    const first = out.split('\n').find((l) => l.trim().startsWith('{'))
    const o = JSON.parse(first)
    return o.id ?? null
  } catch {
    return null
  }
}

let bad = 0
let checked = 0
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(root, ws.name)
    let entries = []
    try { entries = fs.readdirSync(wsDir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const f = path.join(wsDir, e.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      checked++
      const id = readHeaderId(f)
      if (!id) continue
      if (id !== e.name) {
        bad++
        console.log('✘ 名字不一致: ' + path.join(wsDir, e.name) + '\n    内部 id = ' + id)
        if (FIX) {
          const target = path.join(wsDir, id)
          if (!fs.existsSync(target)) { fs.renameSync(path.join(wsDir, e.name), target); console.log('  → 已改名回 ' + id) }
          else console.log('  → 目标已存在，未动')
        }
      }
    }
  }
}
console.log('\n检查 ' + checked + ' 个会话，名字不一致 ' + bad + ' 个')
if (bad && !FIX) console.log('用 --fix-name 修（把目录名改回内部 id）')
process.exit(bad ? 1 : 0)
