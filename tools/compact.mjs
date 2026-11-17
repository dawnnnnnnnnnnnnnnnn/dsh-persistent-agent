#!/usr/bin/env node
/**
 * compact.mjs —— JOURNAL 的「小步压缩」（对标 Hermes 的 micro-compaction）。
 *
 * Hermes 的做法：上下文快满时，把中间轮次滚动摘要，而不是一刀切。
 * 我们没有 LLM 可以随叫随用，所以做**文件层**的同构版：
 *
 *   - JOURNAL.md 超过 N 行 → 把最老的 M 行搬进 JOURNAL-archive.md（只搬不删）
 *   - 在 JOURNAL.md 顶部留一行「已归档 N 行，摘要见 archive」
 *   - 摘要用规则生成：按日期分组，取每组第一条（可判定、可复现，不编）
 *
 * 规律：只搬、不丢、可追溯。跑的时候先备份。
 *
 * 用法：
 *   node compact.mjs            # 默认：超过 800 行才动，老 300 行归档
 *   node compact.mjs --dry
 *   node compact.mjs --max 400 --keep 200
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || os.homedir()
const MEM = path.join(HOME, '.dsh', 'memory')
const JOURNAL = path.join(MEM, 'JOURNAL.md')
const ARCHIVE = path.join(MEM, 'JOURNAL-archive.md')

const argv = process.argv.slice(2)
const num = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) || d : d }
const MAX = num('--max', 800)
const KEEP = num('--keep', 300)
const DRY = argv.includes('--dry')

if (!fs.existsSync(JOURNAL)) { console.log('没有 JOURNAL.md'); process.exit(0) }

const lines = fs.readFileSync(JOURNAL, 'utf8').split('\n')
if (lines.length <= MAX) { console.log(`JOURNAL ${lines.length} 行 ≤ ${MAX}，不用压`); process.exit(0) }

// 只吃「带日期」的行，避免把标题/空行搬走
const dated = lines.map((l, i) => ({ l, i })).filter((x) => /^\s*[-*]?\s*\d{4}-\d{2}-\d{2}/.test(x.l))
if (dated.length <= KEEP) { console.log('带日期的行不足，跳过'); process.exit(0) }

const moveCount = dated.length - KEEP
const moveSet = new Set(dated.slice(0, moveCount).map((x) => x.i))
const moved = dated.slice(0, moveCount).map((x) => x.l)
const remain = lines.filter((_, i) => !moveSet.has(i))

// 规则摘要：按日期分组取第一条
const byDay = new Map()
for (const l of moved) {
  const d = (l.match(/\d{4}-\d{2}-\d{2}/) ?? [])[0]
  if (d && !byDay.has(d)) byDay.set(d, l.trim().slice(0, 100))
}
const summary = [...byDay.entries()].map(([d, first]) => `- ${d}：${first.replace(/^[-*]?\s*/, '')}`)

const banner = `> 已归档 ${moved.length} 行到 JOURNAL-archive.md（${new Date().toLocaleDateString('zh-CN')} 自动压缩）。\n`
const nextJournal = banner + remain.join('\n')
const archiveHeader = fs.existsSync(ARCHIVE)
  ? ''
  : '# JOURNAL 归档（只搬不删）\n\n> 由 compact.mjs 自动追加。\n\n'
const archiveAppend = archiveHeader + `\n## 归档批次 ${new Date().toLocaleString('zh-CN', { hour12: false })}（${moved.length} 行）\n` + moved.join('\n') + '\n\n### 该批次摘要（按日取首条）\n' + summary.join('\n') + '\n'

if (DRY) {
  console.log(`[dry] 将归档 ${moved.length} 行，保留 ${remain.length} 行`)
  console.log('摘要前 5 行：\n' + summary.slice(0, 5).join('\n'))
  process.exit(0)
}

// 备份再动
const bak = JOURNAL + '.bak-' + Date.now()
fs.copyFileSync(JOURNAL, bak)
fs.appendFileSync(ARCHIVE, archiveAppend, 'utf8')
fs.writeFileSync(JOURNAL, nextJournal, 'utf8')
console.log(`✓ 归档 ${moved.length} 行 → ${ARCHIVE}`)
console.log(`✓ JOURNAL 现在 ${nextJournal.split('\n').length} 行（备份 ${path.basename(bak)}）`)
