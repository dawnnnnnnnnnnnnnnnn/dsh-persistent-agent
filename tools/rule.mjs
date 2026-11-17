#!/usr/bin/env node
/**
 * rule.mjs —— 「通过对话加规则」的落盘工具。
 *
 * 使用者说一句要求，
 * 她调这个脚本把规则写进 `memory\管规.md`。规则文件每轮都会被注入提示词
 * （agent-core 的 context 层），所以**写进去就立刻生效**，不需要重启。
 *
 * 用法：
 *   node rule.mjs add "<一条规则>" --tag 群聊
 *   node rule.mjs add '<另一条规则>' --tag 作息
 *   node rule.mjs list
 *   node rule.mjs del 3            # 删掉第 3 条（编号见 list）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || os.homedir()
const MEM = path.join(HOME, '.dsh', 'memory')
const FILE = path.join(MEM, '管规.md')

const HEADER = `# 管规（使用者亲口加的规则）

> 这个文件由 \`rule.mjs\` 维护，**使用者说什么就记什么**，不要自己往里加。
> 每轮对话都会把这些规则注入提示词，所以写进来就生效。
> 编号用于删除；删除请用 \`node rule.mjs del <编号>\`。

`

function readRules() {
  let t = ''
  try { t = fs.readFileSync(FILE, 'utf8') } catch { t = HEADER }
  const lines = t.split('\n')
  const rules = []
  lines.forEach((l, i) => {
    const m = l.match(/^(\d+)\.\s+(.*)$/)
    if (m) rules.push({ n: Number(m[1]), text: m[2], line: i })
  })
  return { text: t, rules }
}

function writeRules(rules) {
  const body = rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
  const t = HEADER + body + '\n'
  fs.mkdirSync(MEM, { recursive: true })
  fs.writeFileSync(FILE, t, 'utf8')
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }

if (cmd === 'add') {
  const text = argv[1]
  if (!text) { console.error('用法: node rule.mjs add "规则内容" [--tag 群聊]'); process.exit(2) }
  const tag = arg('--tag')
  const day = new Date().toLocaleDateString('zh-CN')
  const { rules } = readRules()
  const line = tag ? `${text}（${tag}｜${day}）` : `${text}（${day}）`
  if (rules.some((r) => r.text === line)) { console.log('已存在，未重复添加'); process.exit(0) }
  rules.push({ text: line })
  writeRules(rules)
  console.log(`✓ 已记下第 ${rules.length} 条：${line}`)
  console.log(`  文件：${FILE}`)
  process.exit(0)
}

if (cmd === 'list' || !cmd) {
  const { rules } = readRules()
  if (!rules.length) { console.log('（还没有规则）'); process.exit(0) }
  console.log(`共 ${rules.length} 条：`)
  for (const r of rules) console.log(`  ${r.n}. ${r.text}`)
  process.exit(0)
}

if (cmd === 'del') {
  const n = Number(argv[1])
  const { rules } = readRules()
  if (!Number.isFinite(n) || n < 1 || n > rules.length) { console.error('编号超出范围，先 list 看看'); process.exit(2) }
  const [removed] = rules.splice(n - 1, 1)
  writeRules(rules)
  console.log(`✓ 已删除：${removed.text}`)
  process.exit(0)
}

console.error('用法: node rule.mjs add "…" [--tag x] | list | del <n>')
process.exit(2)
