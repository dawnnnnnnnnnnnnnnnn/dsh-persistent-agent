#!/usr/bin/env node
/**
 * tools/guard-media.mjs —— 提交前的素材与体积闸
 *
 * SPDX-License-Identifier: MIT
 *
 * 为什么需要它：.gitignore 只管"没被 add 过"的文件。一旦哪天用 `git add -f`、
 * 或者换个客户端（IDE、网页、别的工具）提交，忽略规则就不一定生效。
 * 这个脚本读的是**暂存区**——即将真正进入历史的那些 blob，拦在这里才拦得住。
 *
 * 拦三类：
 *   1. 图片 / 音视频 / 模型权重（按扩展名）
 *   2. 任何超过阈值的文件（按字节，默认 256 KB）
 *   3. 路径里出现素材目录名（images / refs / 参考 / 训练 / lora / models）
 *
 * 用法：
 *   node tools/guard-media.mjs             检查暂存区，有问题 exit 1
 *   node tools/guard-media.mjs --install    装成本仓库的 pre-commit hook
 *
 * 绕过（确实需要提交二进制时）：git commit --no-verify，并在 commit message 里写清楚原因。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|psd|mp4|mov|webm|avi|mkv|wav|mp3|flac|m4a|ogg|safetensors|ckpt|pt|pth|onnx|bin|gguf|pkl|npy|npz|zip|7z|rar|tar|gz|lora)$/i
const MEDIA_DIR = /(^|\/)(images?|imgs?|refs?|参考|素材|设定集|训练|lora|models?|outputs?|shots?)(\/|$)/i
const MAX_BYTES = Number(process.env.GUARD_MAX_BYTES || 256 * 1024)

const args = process.argv.slice(2)

// ── 安装成 pre-commit hook ──
if (args.includes('--install')) {
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()
  const hookPath = path.join(gitDir, 'hooks', 'pre-commit')
  const body = `#!/bin/sh
# 由 tools/guard-media.mjs --install 生成：拦住素材 / 权重 / 超大文件
exec node "$(git rev-parse --show-toplevel)/tools/guard-media.mjs"
`
  fs.mkdirSync(path.dirname(hookPath), { recursive: true })
  fs.writeFileSync(hookPath, body, { mode: 0o755 })
  console.log('已安装 pre-commit hook → ' + hookPath)
  console.log('以后每次 git commit 都会先跑这个检查；确实要提交二进制时用 git commit --no-verify。')
  process.exit(0)
}

// ── 读暂存区（不用工作树：暂存区才是即将进入历史的内容）──
let staged = []
try {
  staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
} catch (e) {
  console.error('读不到暂存区：' + String(e?.message ?? e))
  process.exit(2)
}

if (staged.length === 0) {
  console.log('暂存区为空，跳过。')
  process.exit(0)
}

const problems = []
for (const rel of staged) {
  const abs = path.resolve(rel)
  // 扩展名
  if (MEDIA_EXT.test(rel)) {
    problems.push({ rel, why: '素材/权重类文件（' + path.extname(rel) + '）' })
    continue
  }
  // 目录名
  if (MEDIA_DIR.test(rel)) {
    problems.push({ rel, why: '路径落在素材目录里' })
    continue
  }
  // 体积
  try {
    const size = fs.statSync(abs).size
    if (size > MAX_BYTES) {
      problems.push({ rel, why: '超过 ' + Math.round(MAX_BYTES / 1024) + ' KB（实际 ' + Math.round(size / 1024) + ' KB）' })
    }
  } catch { /* 已删除的文件忽略 */ }
}

if (problems.length === 0) {
  console.log('✓ 暂存区检查通过：' + staged.length + ' 个文件，无素材/权重/超大文件')
  process.exit(0)
}

console.error('✗ 拒绝提交，' + problems.length + ' 个文件有问题：')
for (const p of problems) console.error('  ' + p.rel + '  —— ' + p.why)
console.error('')
console.error('素材、模型、生成图都不进仓库。确实需要时：git commit --no-verify')
process.exit(1)
