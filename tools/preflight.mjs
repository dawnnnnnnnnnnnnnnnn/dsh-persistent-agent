#!/usr/bin/env node
/**
 * tools/preflight.mjs —— 发布前总闸
 *
 * SPDX-License-Identifier: MIT
 *
 * 依次跑四道检查，任何一道失败就退出 1，不许继续推：
 *
 *   1. 语法     所有 .mjs/.js 过 node --check
 *   2. 素材     guard-media：暂存区里不许有图片/权重/超大文件
 *   3. 脱敏     scan-privacy：按目录扫，命中就拦
 *   4. 人设词   自定义词表，扫到就拦
 *
 * 用法：
 *   node tools/preflight.mjs          跑一遍全部
 *   node tools/preflight.mjs --install 装成 pre-commit + pre-push hook
 *
 * 装了 hook 之后，`git commit` 和 `git push` 都会先过这一遍。
 * 真需要绕过：git commit --no-verify / git push --no-verify（并写清原因）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..')
process.chdir(ROOT)

// 人设 / 素材 / 私域词表：命中就拦。
// 这份表只放"绝不该出现在这个仓库里"的词，不放任何真实值。
const FORBIDDEN = [
  // 关系设定
  /主人/, /她对我/, /我的音色/, /她的脸/,
  // 角色外观类
  /鳍耳/, /鲸尾/, /女仆装/, /靛蓝/, /荷叶边/, /呆毛/, /白丝/,
  // 素材库结构
  /设定集/, /写实参考/, /旧模-|\b旧模/,
  // 音色 / 模型私有代号
  /zipzippipe/i, /whale_girl/i, /8766/,
  // 本机
  /\bROG\b/, /Jinan/i, /\/mnt\/d\//,
]

const args = process.argv.slice(2)
const INSTALL = args.includes('--install')

// ── 安装 hooks ──
if (INSTALL) {
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()
  const hookBody = `#!/bin/sh
# 由 tools/preflight.mjs --install 生成
exec node "$(git rev-parse --show-toplevel)/tools/preflight.mjs"
`
  for (const h of ['pre-commit', 'pre-push']) {
    const p = path.join(gitDir, 'hooks', h)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, hookBody, { mode: 0o755 })
    console.log('已装 ' + h + ' → ' + p)
  }
  console.log('以后 commit / push 前都会先过 preflight；确实要绕过用 --no-verify。')
  process.exit(0)
}

const results = []
const fail = (name, detail) => results.push({ name, ok: false, detail })
const pass = (name, detail) => results.push({ name, ok: true, detail })

// ── ① 语法 ──
{
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!/^(dist|ref|node_modules|\.git)$/.test(e.name)) walk(p) }
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p)
    }
  }
  walk('.')
  let bad = []
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
    if (r.status !== 0) bad.push(path.relative(ROOT, f))
  }
  bad.length ? fail('语法', bad.join(', ')) : pass('语法', files.length + ' 个文件')
}

// ── ② 素材闸 ──
{
  const r = spawnSync(process.execPath, ['tools/guard-media.mjs'], { encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status === 0) pass('素材闸', out.trim().split('\n')[0] || 'ok')
  else fail('素材闸', out.trim().split('\n').slice(0, 3).join(' / '))
}

// ── ③ 脱敏扫描（逐目录）──
{
  const dirs = ['core', 'heartbeat', 'shared', 'adapters', 'tools', 'docs', 'patches', 'persona-template']
  const bad = []
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    const r = spawnSync(process.execPath, ['scan-privacy.mjs', d, '--quiet'], { encoding: 'utf8' })
    if (r.status !== 0) bad.push(d)
  }
  // 根目录的文件
  for (const f of ['README.md', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'AUTHORS.md', 'CREDITS.md', 'NOTICE']) {
    if (!fs.existsSync(f)) continue
    const r = spawnSync(process.execPath, ['scan-privacy.mjs', f, '--quiet'], { encoding: 'utf8' })
    if (r.status !== 0) bad.push(f)
  }
  bad.length ? fail('脱敏', '有命中的位置：' + bad.join(', ')) : pass('脱敏', dirs.length + ' 个目录 + 根文件')
}

// ── ④ 人设 / 私域词 ──
{
  const hits = []
  // 只扫被 git 跟踪的文件：内部脚本（.gitignore 里的）不进仓库，扫它们只会误报
  let tracked = []
  try {
    tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch { tracked = [] }
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!/^(dist|ref|node_modules|\.git)$/.test(e.name)) walk(p) }
      else if (/\.(mjs|js|md|html|json|yml|yaml)$/.test(e.name)) {
        const rel = path.relative(ROOT, p).replace(/\\/g, '/')
        if (/^(tools\/preflight|tools\/guard-media)\.mjs$/.test(rel)) continue   // 规则文件本身含这些词
        if (tracked.length && !tracked.includes(rel)) continue
        const text = fs.readFileSync(p, 'utf8')
        for (const re of FORBIDDEN) {
          if (re.test(text)) {
            const line = text.split('\n').findIndex((l) => re.test(l)) + 1
            hits.push(path.relative(ROOT, p) + ':' + line + '  ' + re.source)
          }
        }
      }
    }
  }
  walk('.')
  hits.length ? fail('人设词', hits.slice(0, 5).join(' | ')) : pass('人设词', FORBIDDEN.length + ' 条规则')
}

// ── 汇总 ──
console.log('\npreflight:')
for (const r of results) console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.name.padEnd(8) + r.detail)

const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error('\n✗ ' + failed.length + ' 道没过，不许推。')
  process.exit(1)
}
console.log('\n✓ 全过。')
