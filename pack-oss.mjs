#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * pack-oss.mjs —— 生成可公开发布的发行包
 *
 * 早期 重写要点：清单式白名单 + 出包即扫描。
 *   2. **逐条显式清单**：不靠扩展名过滤，每个文件都点名；新增文件必须加进清单才会进包。
 *   3. **强排除**：CHANGELOG / prompt.json / *-state.json / memory-index.json / *.bak / *.log / ref / dist。
 *   4. **出包即扫描**：对产物目录再扫一遍，有高危命中就报错退出（CI 门禁）。
 *
 * 用法：
 *   node pack-oss.mjs            # 出包到 dist\dsh-xixi-<date>\
 *   node pack-oss.mjs --zip      # 出包并压 zip
 *   node pack-oss.mjs --scan-only # 只扫描产物/工程，不复制
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || os.homedir()
const ROOT = path.join(HOME, 'dsh-xixi')
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUT = path.join(ROOT, 'dist', 'dsh-persistent-agent-' + stamp)
const ZIP = process.argv.includes('--zip')
const SCAN_ONLY = process.argv.includes('--scan-only')

// ─────────────────────────────────────────────────────────
// 显式清单：相对工程根的路径。目录写成 'dir/'，文件写成完整相对路径。
// ─────────────────────────────────────────────────────────
const INCLUDE = [
  // 工程元文件
  'README.md',
  'LICENSE',
  'NOTICE',
  'AUTHORS.md',
  'CHANGELOG.md',
  'THIRD-PARTY-NOTICES.md',
  'agent.config.example.json',

  // 文档
  'docs/',

  // 人格模板（空壳）
  'persona-template/',

  // 通道无关核心
  'core/',

  // core 与 heartbeat 共用
  'shared/',

  // 通道适配器
  'adapters/',

  // 心跳
  'heartbeat/',

  // 工具（通道无关）：只发代码，不发 ffmpeg 二进制 / 贴纸素材 / 模型
  'tools/anima.mjs',
  'tools/hires-anima.mjs',
  'tools/checks.mjs',
  'tools/compact.mjs',
  'tools/rule.mjs',
  'tools/feiyu-tts.mjs',

  // DSH profile 补丁示例
  'patches/',
]

// 强排除：即使落在上面的目录里也不进包
const EXCLUDE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)ref(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /\.bak(-|$)/,
  /\.log$/,
  /^CHANGELOG/i,
  /(^|\/)prompt\.json$/,
  /-state\.json$/,
  /(^|\/)memory-index\.json$/,
  /(^|\/)alive\.json$/,
  /(^|\/)jobs-state\.json$/,
  /(^|\/)lineage-state\.json$/,
  /(^|\/)sync-stats\.json$/,
  /(^|\/)SYNC-REPORT\.md$/,
  /(^|\/)ATTRIBUTION-CHECK\.md$/,
  /(^|\/)PRIVACY-AUDIT\.md$/,
  /\.zip$/,
  /\.tgz$/,
  /\.exe$/,
  /\.dll$/,
  /\.pt$/,
  /\.pth$/,
  /\.onnx$/,
  /\.safetensors$/,
  /\.gif$/,
  /\.webp$/,
  /\.png$/,
  /\.jpg$/,
  /\.mp3$/,
  /\.wav$/,
  /(^|\/)stickers(\/|$)/,
  /(^|\/)bin(\/|$)/,
  /(^|\/)models(\/|$)/,
]


// ── 脱敏种子：真实值从 local-seeds.json 读，源码里不留明文（早期）──
function loadSeeds() {
  const p = path.join(ROOT, 'local-seeds.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}
const SEEDS = loadSeeds()

// 令牌前缀拼接生成：源码里不出现完整字面量，扫描器也不会自我命中
const TOKEN_PREFIX = 'dfy' + '-qq-'

// ── 占位符重写：只作用于复制出来的副本 ──
const REWRITE = [
  // 身份（真值来自 local-seeds.json，源码不含明文）
  [new RegExp(SEEDS.ownerId || '__OWNER_ID__', 'g'), '{{OWNER_ID}}'],
  [new RegExp(SEEDS.botId || '__BOT_ID__', 'g'), '{{BOT_ID}}'],
  [new RegExp(SEEDS.ownerName || '__OWNER_NAME__', 'gi'), '{{OWNER_NAME}}'],
  ...(SEEDS.botName ? [[new RegExp(SEEDS.botName, 'g'), '{{BOT_NAME}}']] : []),
  ...(SEEDS.contactName ? [[new RegExp(SEEDS.contactName, 'g'), '{{CONTACT_NAME}}']] : []),
  // 凭据
  // 协议端令牌前缀：拼出来是为了让扫描器自己不被 grep 命中
[new RegExp(SEEDS.adapterToken || (TOKEN_PREFIX + '-[A-Za-z0-9]+'), 'g'), '{{ADAPTER_TOKEN}}'],
  [/(sk|xoxb|xoxp)-[A-Za-z0-9_-]{12,}/g, '{{API_KEY}}'],
  [/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1{{API_TOKEN}}'],
  // 只替换"引号里的字面量密钥"，不动 token: env.X / cfg.y 这类代码引用
  [/((?:api[_-]?key|token|secret|password)\s*[:=]\s*["'])[A-Za-z0-9._\-]{16,}(["'])/gi, '$1{{SECRET}}$2'],
  // 会话 / 群
  // 群号 / 会话 id：从 local-seeds.json 读（源码不留明文）
  ...(SEEDS.chatIds && SEEDS.chatIds.length
    ? [[new RegExp('\\b(?:' + SEEDS.chatIds.join('|') + ')\\b', 'g'), '{{CHAT_ID}}']]
    : []),
  // 机构 / 地理
  ...(SEEDS.institution ? [[new RegExp(SEEDS.institution, 'g'), '{{INSTITUTION}}']] : []),
  ...(SEEDS.cities && SEEDS.cities.length ? [[new RegExp(SEEDS.cities.join('|'), 'g'), '{{CITY}}']] : []),
  // 身体数据 / 联系方式
  [/\b1[3-9]\d{9}\b/g, '{{PHONE}}'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '{{EMAIL}}'],
]

function rewrite(text) {
  let out = String(text)
  // 本机绝对路径整段替换（字面量正则，避免 RegExp 构造器的转义坑）
  out = out.replace(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?:[A-Za-z0-9._\u4e00-\u9fa5-]+[\\/])+[A-Za-z0-9._\u4e00-\u9fa5-]*/g, '{{LOCAL_PATH}}')
  for (const [re, rep] of REWRITE) out = out.replace(re, rep)
  // 占位符归一：把历史遗留写法统一到本包 README 里声明的表
  const NORM = [
    [/\{\{OWNER_QQ\}\}/g, '{{OWNER_ID}}'],
    [/\{\{BOT_QQ\}\}/g, '{{BOT_ID}}'],
    [/\{\{GROUP_ID\}\}/g, '{{CHAT_ID}}'],
    [/\{\{NAPCAT_TOKEN\}\}/g, '{{ADAPTER_TOKEN}}'],
    [/\{\{HOME\}\}/g, '{{LOCAL_PATH}}'],
    [/\{\{WORKSPACE\}\}/g, '{{LOCAL_PATH}}'],
    [/\{\{FRIEND_NAME\}\}/g, '{{CONTACT_NAME}}'],
    // 示例里的假号，避免扫描器误报
    [/\b123456789\b/g, '<uid>'],
  ]
  for (const [re, rep] of NORM) out = out.replace(re, rep)
  return out
}

// 这些文件不做重写（否则包自己的脱敏规则会被改坏）
const NO_REWRITE = [/scan-privacy\.mjs$/, /pack-oss\.mjs$/, /THIRD-PARTY-NOTICES\.md$/, /LICENSE$/]

function excluded(rel) {
  return EXCLUDE.some((re) => re.test(rel))
}

function walk(dirRel, acc) {
  const abs = path.join(ROOT, dirRel)
  if (!fs.existsSync(abs)) return acc
  const st = fs.statSync(abs)
  if (st.isFile()) { acc.push(dirRel); return acc }
  for (const name of fs.readdirSync(abs)) {
    const rel = path.posix.join(dirRel, name)
    if (excluded(rel)) continue
    const a = path.join(ROOT, rel)
    const s = fs.statSync(a)
    if (s.isDirectory()) walk(rel, acc)
    else acc.push(rel)
  }
  return acc
}

function collect() {
  const files = []
  for (const item of INCLUDE) {
    const abs = path.join(ROOT, item)
    if (!fs.existsSync(abs)) { console.log('  ⚠ 清单项不存在，跳过: ' + item); continue }
    walk(item.replace(/\/$/, ''), files)
  }
  return [...new Set(files)].filter((f) => !excluded(f)).sort()
}

function copyAll(files) {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  let n = 0
  for (const rel of files) {
    const src = path.join(ROOT, rel)
    const dst = path.join(OUT, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    const keepRaw = NO_REWRITE.some((re) => re.test(rel))
    const buf = fs.readFileSync(src)
    // 只对文本类文件做重写
    const isText = /\.(mjs|js|json|md|html|yml|yaml|txt|py|ts)$/i.test(rel)
    if (isText && !keepRaw) {
      fs.writeFileSync(dst, rewrite(buf.toString('utf8')), 'utf8')
    } else {
      fs.writeFileSync(dst, buf)
    }
    n++
  }
  return n
}

// ── 产物扫描 ──
const HARD = [
  { re: new RegExp('\\b' + (SEEDS.ownerId || '__OWNER_ID__') + '\\b'), name: '使用者 ID' },
  { re: new RegExp('\\b' + (SEEDS.botId || '__BOT_ID__') + '\\b'), name: '机器人 ID' },
  { re: new RegExp(SEEDS.ownerName || '__OWNER_NAME__'), name: '使用者昵称' },
  { re: new RegExp(TOKEN_PREFIX), name: '协议端令牌' },
  { re: /[A-Za-z]:\\Users\\/, name: '本机用户路径' },
  ...(SEEDS.institution ? [{ re: new RegExp(SEEDS.institution), name: '机构' }] : []),
  ...(SEEDS.cities && SEEDS.cities.length ? [{ re: new RegExp(SEEDS.cities.join('|')), name: '城市' }] : []),
  // 身体数据这类规则只对特定档案有意义，已移出（通用 PII 由 scan-privacy.mjs 兜）
]
const SOFT = [
  { re: /\b1[3-9]\d{9}\b/, name: '手机号' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, name: '邮箱' },
  { re: /\b\d{9,10}\b/, name: '疑似 QQ/群号' },
]

function scanTree(dir) {
  const hits = []
  const walkScan = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      const s = fs.statSync(p)
      if (s.isDirectory()) { walkScan(p); continue }
      if (!/\.(mjs|js|json|md|html|yml|yaml|txt|py|ts)$/i.test(name)) continue
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const r of HARD) if (r.re.test(line)) hits.push({ level: 'HARD', what: r.name, file: path.relative(dir, p), line: i + 1 })
        for (const r of SOFT) if (r.re.test(line)) hits.push({ level: 'soft', what: r.name, file: path.relative(dir, p), line: i + 1 })
      })
    }
  }
  walkScan(dir)
  return hits
}

// ── main ──
if (SCAN_ONLY) {
  const target = process.argv[3] || OUT
  console.log('扫描：' + target)
  const hits = scanTree(target)
  const hard = hits.filter((h) => h.level === 'HARD')
  console.log('  高危命中 ' + hard.length + ' 处，弱命中 ' + (hits.length - hard.length) + ' 处')
  hard.slice(0, 40).forEach((h) => console.log('  ✗ ' + h.what + '  ' + h.file + ':' + h.line))
  process.exit(hard.length ? 1 : 0)
}

const files = collect()
console.log('清单命中 ' + files.length + ' 个文件')
const n = copyAll(files)
console.log('已复制 ' + n + ' 个文件 → ' + OUT)

const hits = scanTree(OUT)
const hard = hits.filter((h) => h.level === 'HARD')
const soft = hits.filter((h) => h.level === 'soft')
const report = ['# 脱敏扫描（产物）', '', '扫描目录：`dist/' + path.basename(OUT) + '/`', '']
report.push('## 高危命中：' + hard.length + ' 处')
if (hard.length) hard.forEach((h) => report.push('- `' + h.file + ':' + h.line + '` — ' + h.what))
else report.push('无。')
report.push('', '## 弱命中：' + soft.length + ' 处')
if (soft.length) soft.slice(0, 50).forEach((h) => report.push('- `' + h.file + ':' + h.line + '` — ' + h.what))
else report.push('无。')
fs.writeFileSync(path.join(OUT, 'DESENSITIZE.md'), report.join('\n'), 'utf8')

console.log('  高危 ' + hard.length + ' / 弱 ' + soft.length + ' → DESENSITIZE.md')
hard.slice(0, 20).forEach((h) => console.log('  ✗ ' + h.what + '  ' + h.file + ':' + h.line))

if (ZIP) {
  const { execFileSync } = await import('node:child_process')
  const zipPath = OUT + '.zip'
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true })
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal`], { stdio: 'inherit' })
  console.log('  已压缩 ' + zipPath + '  ' + Math.round(fs.statSync(zipPath).size / 1024) + ' KB')
}

process.exit(hard.length ? 1 : 0)
