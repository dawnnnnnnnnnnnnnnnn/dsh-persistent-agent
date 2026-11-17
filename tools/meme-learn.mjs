#!/usr/bin/env node
/**
 * meme-learn.mjs —— 梗与语言习惯的「先待审、后采纳」流水线。
 *
 * 背景（可自定义））：
 *   她在 B 站读弹幕/评论时，可以顺手学一点网络梗和人的说话方式，
 *   但**不许自作主张改自己的语言**：先记进「待审」，等使用者审计通过才生效。
 *
 * 规矩：
 *   - 每次写入前都备份；只保留最近 3 份 + 最新（备份 ≥3 份，旧的定期清）
 *   - 「待审」里的条目只是素材，不是规则
 *   - 采纳后写进「已采纳」，她下一轮读说明书时能看到
 *
 * 用法：
 *   node meme-learn.mjs add "梗：绝绝子 = 非常好/无语，看语境" --from BV1xx --tag 弹幕
 *   node meme-learn.mjs list
 *   node meme-learn.mjs approve 2
 *   node meme-learn.mjs drop 3
 *   node meme-learn.mjs backups            # 看现有备份
 *   node meme-learn.mjs prune --keep 3     # 手动清理，只留最近 3 份
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || os.homedir()
const MEM = path.join(HOME, '.dsh', 'memory')
const FILE = path.join(MEM, '梗库.md')
const BAK_DIR = path.join(MEM, '_archive', '梗库')
const KEEP = 3

const HEADER = `# 梗库（弹幕 / 评论里学到的，**先待审后用**）

> 规矩（使用者）：读到梗先记「待审」，**审计通过才进「已采纳」**。
> 每次改动前自动备份，只留最近 3 份 + 最新。
> 已采纳的条目才会影响我说话的方式。

## 待审

## 已采纳
`

const read = () => { try { return fs.readFileSync(FILE, 'utf8') } catch { return HEADER } }

function backup() {
  try {
    if (!fs.existsSync(FILE)) return
    fs.mkdirSync(BAK_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    fs.copyFileSync(FILE, path.join(BAK_DIR, stamp + '.md'))
    prune()
  } catch {}
}

function prune(keep = KEEP) {
  try {
    const list = fs.readdirSync(BAK_DIR).filter((f) => f.endsWith('.md')).sort()
    const drop = list.slice(0, Math.max(0, list.length - keep - 1))
    for (const f of drop) { try { fs.unlinkSync(path.join(BAK_DIR, f)) } catch {} }
  } catch {}
}

function parse(text) {
  const lines = text.split('\n')
  const idxWait = lines.findIndex((l) => /^##\s*待审/.test(l))
  const idxDone = lines.findIndex((l) => /^##\s*已采纳/.test(l))
  const head = lines.slice(0, idxWait >= 0 ? idxWait + 1 : 2).join('\n')
  const wait = idxWait >= 0 ? lines.slice(idxWait + 1, idxDone >= 0 ? idxDone : lines.length) : []
  const done = idxDone >= 0 ? lines.slice(idxDone + 1) : []
  return { head, wait, done }
}

function render(p) {
  const w = p.wait.filter((l) => l.trim())
  const d = p.done.filter((l) => l.trim())
  return p.head + '\n' + w.join('\n') + '\n\n## 已采纳\n' + d.join('\n') + '\n'
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }

function save(p) { backup(); fs.writeFileSync(FILE, render(p), 'utf8') }

if (cmd === 'add') {
  const text = argv[1]
  if (!text) { console.error('用法: node meme-learn.mjs add "内容" [--from BV..] [--tag 弹幕]'); process.exit(2) }
  const p = parse(read())
  const from = arg('--from'), tag = arg('--tag')
  const day = new Date().toLocaleDateString('zh-CN')
  const meta = [tag ? '#' + tag : '', from ? '来源 ' + from : '', day].filter(Boolean).join(' · ')
  p.wait.push(`- ${text}（${meta}）`)
  save(p)
  console.log('✓ 已记入「待审」：' + text)
  console.log('  文件：' + FILE)
  process.exit(0)
}

if (cmd === 'list' || !cmd) {
  const p = parse(read())
  const w = p.wait.filter((l) => l.trim())
  const d = p.done.filter((l) => l.trim())
  console.log(`待审 ${w.length} 条：`)
  w.forEach((l, i) => console.log(`  ${i + 1}. ${l.replace(/^-\s*/, '')}`))
  console.log(`\n已采纳 ${d.length} 条：`)
  d.forEach((l) => console.log('  ' + l.replace(/^-\s*/, '')))
  process.exit(0)
}

if (cmd === 'approve' || cmd === 'drop') {
  const n = Number(argv[1])
  const p = parse(read())
  const w = p.wait.filter((l) => l.trim())
  if (!Number.isFinite(n) || n < 1 || n > w.length) { console.error('编号超出范围，先 list'); process.exit(2) }
  const target = w[n - 1]
  const idx = p.wait.indexOf(target)
  if (idx >= 0) p.wait.splice(idx, 1)
  if (cmd === 'approve') p.done.push('- ' + target.replace(/^-\s*/, '').replace('（', '（已采纳 · '))
  save(p)
  console.log(`✓ 已${cmd === 'approve' ? '采纳' : '丢弃'}：` + target.replace(/^-\s*/, ''))
  process.exit(0)
}

if (cmd === 'backups') {
  const list = (() => { try { return fs.readdirSync(BAK_DIR) } catch { return [] } })()
  console.log(`备份 ${list.length} 份（保留最近 ${KEEP} 份 + 最新）：`)
  list.sort().forEach((f) => console.log('  ' + f))
  process.exit(0)
}

if (cmd === 'prune') {
  prune(Number(arg('--keep')) || KEEP)
  console.log('✓ 已清理旧备份')
  process.exit(0)
}

console.error('用法: add "…" | list | approve <n> | drop <n> | backups | prune')
process.exit(2)
