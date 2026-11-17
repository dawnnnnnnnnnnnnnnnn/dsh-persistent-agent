#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: 2026 dsh-xixi contributors
 * SPDX-License-Identifier: MIT
 *
 * scan-privacy.mjs —— 严格脱敏扫描器（纯 Node，零第三方依赖）
 *
 * 用途：发布前最后一道闸。比 pack-oss.mjs 里那个「只查 QQ/路径/令牌/名字」的
 * 简陋扫描严格得多：10 类规则、带严重度、可出 JSON 报告、可在 CI 里当门禁。
 *
 * 用法：
 *   node scan-privacy.mjs <目录或文件>            # 人肉看的报告
 *   node scan-privacy.mjs <目录或文件> --json     # 机器可读（stdout 只有 JSON）
 *   node scan-privacy.mjs <目录或文件> --fix      # 只打印「将要改什么」，不写盘
 *   node scan-privacy.mjs <目录或文件> --fix --yes  # 真写（每改一个文件留 .bak-privacy 备份）
 *
 * 退出码：0 = 干净；1 = 有命中（可当 CI 门禁）；2 = 用法错误
 *
 * 几条刻意的设计：
 *   1. **不跟随符号链接 / junction**（默认）。本工程的 core、heartbeat、patches、tools
 *      是指向 ~/.dsh 的 junction；跟进去就等于把运行时的记忆/会话也纳入扫描，
 *      更糟的是 --fix 会穿透链接改到 ~/.dsh。要看那边请显式加 --follow-links（只读）。
 *   2. **已知昵称不写在本文件里**。种子从同目录 pack-oss.mjs 的 REWRITE 数组里读出来，
 *      本机用户名从 os.userInfo() 取 —— 扫描器自身的源码不含隐私值，
 *      否则它自己就成了新的泄露点。
 *   3. **片段一律截断到 60 字**，报告里不出现整段原文。
 *   4. dist 默认跳过；显式把 dist 目录（或它里面的路径）当作扫描目标时照扫。
 */
import fs from 'node:fs'
import os from 'node:os'

// 协议端令牌前缀：拼接生成，本文件不留完整字面量
const TOKEN_PREFIX = 'dfy' + '-qq-'
import path from 'node:path'

const VERSION = '1.0.0'
const MAX_SNIPPET = 60
const MAX_FILE_BYTES = 8 * 1024 * 1024
const LOCAL_USER = (() => {
  try { return os.userInfo().username } catch { return '' }
})()

// ───────────────────────── CLI ─────────────────────────
const argv = process.argv.slice(2)
const opt = {
  target: '',
  json: false,
  fix: false,
  yes: false,
  followLinks: false,
  noSeeds: false,
  quiet: false,
  maxSeverity: 'all',
  ignore: [],
}
for (const a of argv) {
  if (a === '--json') opt.json = true
  else if (a === '--fix') opt.fix = true
  else if (a === '--yes' || a === '-y') opt.yes = true
  else if (a === '--follow-links') opt.followLinks = true
  else if (a === '--no-seeds') opt.noSeeds = true
  else if (a === '--quiet' || a === '-q') opt.quiet = true
  else if (a.startsWith('--ignore=')) opt.ignore.push(a.slice(9))
  else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
  else if (a === '--version') { console.log(VERSION); process.exit(0) }
  else if (a.startsWith('-')) { console.error(`未知参数：${a}`); usage(); process.exit(2) }
  else if (!opt.target) opt.target = a
  else { console.error(`多余的参数：${a}`); process.exit(2) }
}
if (!opt.target) { usage(); process.exit(2) }

function usage() {
  console.log(`scan-privacy.mjs ${VERSION} —— 严格脱敏扫描器

用法：
  node scan-privacy.mjs <目录或文件> [--json] [--fix [--yes]] [--follow-links]

参数：
  --json          输出机器可读报告（stdout 只有 JSON）
  --fix           打印将要替换的清单（不写盘）
  --yes           配合 --fix 才真写；每个被改的文件留 .bak-privacy 备份
  --follow-links  跟随符号链接 / junction（只读；--fix 永不穿透链接）
  --ignore=<片段> 跳过路径里含该片段的文件（可重复），例如 --ignore=PRIVACY-AUDIT.md
  --no-seeds      不读 pack-oss.mjs 的 REWRITE 种子
  --quiet         只输出统计，不逐条列命中

退出码：0 干净 / 1 有命中 / 2 用法错误`)
}

// ───────────────────── 扩展名与跳过 ─────────────────────
const EXT = new Set([
  '.mjs', '.js', '.cjs', '.json', '.md', '.markdown', '.html', '.htm',
  '.yml', '.yaml', '.txt', '.ts', '.tsx', '.jsx', '.ps1', '.cmd', '.bat', '.py', '.sh',
])
const SKIP_DIR = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', '__pycache__', '.next', '.cache'])

const ROOT = path.resolve(opt.target)
if (!fs.existsSync(ROOT)) { console.error(`路径不存在：${ROOT}`); process.exit(2) }
const ROOT_IS_DIST = /(?:^|[\\/])dist(?:[\\/]|$)/i.test(ROOT)
const ROOT_IS_FILE = fs.statSync(ROOT).isFile()

// ───────────────────── 占位符词表 ─────────────────────
// 与 pack-oss.mjs 的 REWRITE / apply-config.mjs 的 MAP 保持同一套名字。
const P = {
  // 与本工程 pack-oss.mjs 的 REWRITE / README 占位符表同名，改完能直接对得上
  HOME: '{{LOCAL_PATH}}',
  WORKSPACE: '{{LOCAL_PATH}}',
  FILE_URI: '{{LOCAL_PATH}}',
  OWNER_QQ: '{{OWNER_ID}}',
  BOT_QQ: '{{BOT_ID}}',
  GROUP_ID: '{{CHAT_ID}}',
  NAPCAT_TOKEN: '{{ADAPTER_TOKEN}}',
  API_KEY: '{{API_KEY}}',
  API_TOKEN: '{{API_TOKEN}}',
  SECRET: '{{SECRET}}',
  OWNER_NAME: '{{OWNER_NAME}}',
  BOT_NAME: '{{BOT_NAME}}',
  FRIEND_NAME: '{{CONTACT_NAME}}',
  PERSON: '{{PERSON}}',
  INSTITUTION: '{{INSTITUTION}}',
  CITY: '{{CITY}}',
  BODY_DATA: '{{BODY_DATA}}',
  NARRATIVE: '{{NARRATIVE_CONTENT}}',
  EMAIL: '{{EMAIL}}',
  PHONE: '{{PHONE}}',
  WECHAT: '{{WECHAT_ID}}',
  BILI: '{{BILI_UID}}',
  WEIBO: '{{WEIBO_ID}}',
  USER: '{{LOCAL_USER}}',
}

// ───────────────────── 种 子（从 pack-oss.mjs 读）─────────────────────
// 返回 [{ value, placeholder, severity }]，让扫描器认识「这个工程已知的真实值」，
// 同时又不把这些值写进扫描器源码。
function loadSeeds() {
  const seeds = []
  const seen = new Set()
  const push = (value, placeholder, severity) => {
    const v = String(value).trim()
    if (!v || seen.has(v.toLowerCase())) return
    seen.add(v.toLowerCase())
    seeds.push({ value: v, placeholder, severity })
  }
  const file = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'pack-oss.mjs')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return seeds }
  // 只认 [ /pattern/flags , '{{PLACEHOLDER}}' ] 这种配对
  const pairRe = /\[\s*\/((?:\\.|[^/\n])+)\/[a-z]*\s*,\s*'(\{\{[A-Z_]+\}\})'\s*\]/g
  let m
  while ((m = pairRe.exec(text)) !== null) {
    const [, src, ph] = m
    // 去掉前瞻/后顾，避免把 (?!探索) 里的「探索」当成种子
    const cleaned = src.replace(/\(\?[!=<][^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    for (const tok of cleaned.split(/[|()\\\s]+/)) {
      const t = tok.replace(/[+*?{}^$]/g, '')
      if (!t) continue
      const isDigits = /^\d{9,12}$/.test(t)
      const cjkCount = (t.match(/[\u4e00-\u9fa5]/g) ?? []).length
      const isCjk = cjkCount >= 2 && /^[\u4e00-\u9fa5]{2,8}$/.test(t)
      const isNick = /^[A-Za-z][A-Za-z .'-]{5,40}$/.test(t) && /\s/.test(t)
      if (!isDigits && !isCjk && !isNick) continue
      let sev = 'high'
      if (ph === P.BOT_NAME) sev = 'medium'
      push(t, ph, sev)
    }
  }
  return seeds
}
const SEEDS = opt.noSeeds ? [] : loadSeeds()

// ───────────────────── 辅助 ─────────────────────
const REJECT_CHARS = /[+[\]{}|*?<>=]/
const PLACEHOLDER_HINT = /你的?|用户名|用户|某人|\{\{|…|xxx|XXX|示例|TODO/i
// 文档里的示例路径（/path/to、<你的用户名>、actual path 之类）不该算泄露
const DOC_PATH_HINT = /[\\\\/](?:path|to|some|your|foo|bar|example|test)(?:[\\\\/]|$)|实际路径|文件路径/i
// 代码里常见的哨兵/占位数字，不该当成真实 QQ/群号
const QQ_SENTINEL = new Set([
  '2147483647', '2147483000', '1234567890', '123456789', '999999999', '999999003',
  '111111111', '100000000', '888888888', '10001', '12345678', '2026102201',
])

function clip(s, n = MAX_SNIPPET) {
  const flat = String(s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  if (flat.length <= n) return { text: flat, truncated: false }
  const head = Math.ceil((n - 1) * 0.6)
  const tail = n - 1 - head
  return { text: flat.slice(0, head) + '…' + flat.slice(flat.length - tail), truncated: true }
}

// 机构名里不该算作机构前缀的起始词
const INST_STOP_PREFIX = /^(?:这|那|本|某|该|各|每|一所|哪|两|三|四|五|六|七|八|九|十|几|所|所有|全部|重点|普通|一本|二本)/
// 「个人语境」：城市/学校只有在跟本人相关时才值得报。命中点前后 24 字里得有这些词之一
const PEOPLE_CONTEXT = /(?:我在|我在|住在|住|来自|回到|回家|老家|父母|家里|我们|我俩|同校|毕业|就读|考|志愿|专业|校区|校园|天气|出差|搬|上学|母校|他|她|我)/

// ───────────────────────── 规 则 ─────────────────────────
// severity: high = 高危（必须改） / medium = 需人工确认 / low = 疑似或示例
const RULES = [
  // ── 1. Windows 绝对路径 ──
  {
    id: 'win-path-user',
    category: 'Windows绝对路径',
    label: '含本机用户名的绝对路径',
    severity: 'high',
    placeholder: P.HOME,
    re: /[A-Za-z]:[\\/]{1,2}(?:Users|Documents and Settings)[\\/][^\\/\s"'`<>|*?;,，。；：（）()【】[\]]+(?:[\\/][^\\/\s"'`<>|*?;,，。；：（）()【】[\]]+)*/g,
    accept: (m) => !PLACEHOLDER_HINT.test(m) && !REJECT_CHARS.test(m),
  },
  {
    id: 'win-path-generic',
    category: 'Windows绝对路径',
    label: '其他盘符绝对路径',
    severity: 'medium',
    placeholder: P.WORKSPACE,
    re: /(?<![A-Za-z0-9+._/-])[A-Za-z]:[\\/]{1,2}[^\\/\s"'`<>|*?;,，。；：（）()【】[\]]{2,}(?:[\\/]{1,2}[^\\/\s"'`<>|*?;,，。；：（）()【】[\]]{1,})+/g,
    accept: (m) => !/[\\/](?:Users|Documents and Settings)[\\/]/i.test(m)
      && !PLACEHOLDER_HINT.test(m) && !DOC_PATH_HINT.test(m) && !REJECT_CHARS.test(m) && m.length >= 8,
  },
  {
    id: 'file-uri',
    category: 'Windows绝对路径',
    label: 'file:/// 形式的本机路径',
    severity: 'medium',
    placeholder: P.FILE_URI,
    re: /file:\/\/\/[^\s"'`<>）)]{3,}/gi,
    accept: (m) => !PLACEHOLDER_HINT.test(m) && !/^\s*$/.test(m),
  },

  // ── 2. QQ 号 / 群号 ──
  {
    id: 'qq-field',
    category: 'QQ号',
    label: 'JSON/代码字段里的 QQ 或群号',
    severity: 'high',
    placeholder: P.OWNER_QQ,
    re: /\b(?:user[_-]?id|group[_-]?id|self[_-]?id|owner[_-]?qq|ownerQQ|bot[_-]?qq|botQQ|target[_-]?qq|targetQQ|uin|qq)\b["']?\s*[:=]\s*["']?(\d{5,12})(?!\d)/gi,
    useGroup: 1,
    accept: (m) => !QQ_SENTINEL.has(m),
    placeholderFor: (hit) => (/group|群/i.test(hit.full) ? P.GROUP_ID : P.OWNER_QQ),
  },
  {
    id: 'qq-label',
    category: 'QQ号',
    label: '带显式标签的 QQ / 群号',
    severity: 'high',
    placeholder: P.OWNER_QQ,
    re: /(?:QQ\s*号?|群号|机器人号|账号|owner)\s*[:：=]\s*["']?(\d{9,10})(?!\d)/gi,
    useGroup: 1,
    accept: (m) => !QQ_SENTINEL.has(m),
    placeholderFor: (hit) => (/群/i.test(hit.full) ? P.GROUP_ID : P.OWNER_QQ),
  },
  {
    id: 'qq-line-context',
    category: 'QQ号',
    label: '所在行提到 QQ/群，9-10 位裸数字',
    severity: 'high',
    placeholder: P.OWNER_QQ,
    re: /(?<![\w.])\d{9,10}(?![\d.])/g,
    accept: (m, ctx) => !QQ_SENTINEL.has(m)
      && /qq|群|owner|robot|机器人|uin|user|bot/i.test(ctx.line)
      && !/(?:19|20)\d{2}[\-\/年]/.test(ctx.line)
      // uid / roomid / dyn_id 这类字段里的数字是接口示例，不是 QQ
      && !/(?:uid|mid|room_?id|dmid|rpid|dyn_?id|tmid|bvid|color|offset)["']?\s*[:=]\s*["']?$/i.test(ctx.before ?? ''),
  },

  // ── 3. 令牌 / 密钥 ──
  {
    id: 'token-napcat',
    category: '令牌密钥',
    label: 'NapCat 风格令牌明文',
    severity: 'high',
    placeholder: P.NAPCAT_TOKEN,
    re: new RegExp(TOKEN_PREFIX + '[A-Za-z0-9]{4,}', 'gi'),
    accept: (m) => !/\[A-Za-z0-9\]/.test(m) && !new RegExp('^' + TOKEN_PREFIX + 'x+$', 'i').test(m),
  },
  {
    id: 'token-sk',
    category: '令牌密钥',
    label: 'sk-/xoxb- 风格 API Key',
    severity: 'high',
    placeholder: P.API_KEY,
    re: /\b(?:sk|xoxb|xoxp)-[A-Za-z0-9_-]{12,}/g,
    accept: (m) => !/\[A-Za-z0-9/.test(m),
  },
  {
    id: 'token-bearer',
    category: '令牌密钥',
    label: 'Bearer 明文令牌',
    severity: 'high',
    placeholder: P.API_TOKEN,
    re: /\bBearer\s+[A-Za-z0-9._-]{12,}/g,
    accept: (m) => !/\[A-Za-z0-9/.test(m) && !/\{\{/.test(m),
  },
  {
    id: 'secret-assign',
    category: '令牌密钥',
    label: 'token/apiKey/secret/password 赋值',
    severity: 'high',
    placeholder: P.SECRET,
    re: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']([^"'\n]{8,80})["']/gi,
    useGroup: 1,
    accept: (v) => {
      if (PLACEHOLDER_HINT.test(v)) return false
      if (/^(?:\*{3,}|x{3,}|\.{3,})$/.test(v)) return false
      if (/^(?:string|number|boolean|null|undefined|true|false)$/i.test(v)) return false
      if (/^(?:\.?\/|[A-Za-z]:\\|https?:)/.test(v)) return false
      if (/[\s+()=\u4e00-\u9fa5]/.test(v)) return false // 代码表达式/中文说明，不是真令牌
      return /[A-Za-z0-9]/.test(v) && v.length >= 12
    },
  },

  // ── 4. 真实人名 / 昵称 ──
  {
    id: 'seed-known',
    category: '真实人名',
    label: '工程已知真实值（种子来自 pack-oss.mjs REWRITE）',
    severity: 'high',
    placeholder: P.PERSON,
    seeds: true,
  },
  {
    id: 'name-context',
    category: '真实人名',
    label: '称呼/姓名后跟中文名',
    severity: 'medium',
    placeholder: P.PERSON,
    re: /(?:姓名|真名|名字|昵称|称呼|署名)\s*(?:叫|是|为|[:：])\s*[「"'（(]?([\u4e00-\u9fa5]{2,4})[」"'）)]?(?=[\s，。；、,;!?！？\n]|$)/g,
    useGroup: 1,
    accept: (m) => !/^(?:使用者|用户|朋友|对方|自己|什么|名字|昵称|我|你|他|她|这|那|一|不)/.test(m)
      && !/^(?:醒|起|来|做|出|上|下|停|等|去|回|改|写|说)/.test(m)
      && !/测试|示例|占位|别人|某/.test(m),
  },

  // ── 5. 机构 / 地点 ──
  {
    id: 'inst-shape',
    category: '机构地点',
    label: '形似学校/机构名（需在个人语境里）',
    severity: 'low',
    placeholder: P.INSTITUTION,
    proseOnly: true,
    re: /[\u4e00-\u9fa5]{2,6}(?:大学|学院|中学|小学|校区|附中)/g,
    accept: (m, ctx) => !INST_STOP_PREFIX.test(m)
      && !/^(?:大学|学院|中学|小学|校区|上学|上大学|这所)/.test(m)
      && !/^(?:各|每|本|该)/.test(m)
      && PEOPLE_CONTEXT.test(ctx.window),
  },
  {
    id: 'city',
    category: '机构地点',
    label: '具体城市名（需在个人语境里）',
    severity: 'medium',
    placeholder: P.CITY,
    proseOnly: true,
    re: /(?:北京|上海|天津|重庆|济南|青岛|烟台|威海|潍坊|淄博|济宁|泰安|日照|临沂|德州|聊城|滨州|菏泽|枣庄|东营|南京|杭州|苏州|无锡|武汉|成都|西安|广州|深圳|珠海|东莞|郑州|长沙|合肥|福州|厦门|南昌|昆明|贵阳|南宁|海口|兰州|西宁|银川|乌鲁木齐|拉萨|呼和浩特|大连|沈阳|长春|哈尔滨|石家庄|太原)(?!时间)/g,
    accept: (m, ctx) => PEOPLE_CONTEXT.test(ctx.window),
  },

  // ── 6. 身体 / 医疗数据 ──
  {
    id: 'body-bmi',
    category: '身体医疗',
    label: 'BMI 数值',
    severity: 'high',
    placeholder: P.BODY_DATA,
    re: /BMI\s*(?:[:：=]|是|为|约)?\s*\d{1,3}(?:\.\d+)?/gi,
  },
  {
    id: 'body-metric',
    category: '身体医疗',
    proseOnly: true,
    label: '身高/体重/围度数值',
    severity: 'high',
    placeholder: P.BODY_DATA,
    re: /(?:身高|体重|腰围|胸围|臀围|大腿围|臂围|三围|肩宽|脚长)\s*(?:[:：=]|是|为|有|约)?\s*[\d.]{2,5}\s*(?:cm|CM|厘米|mm|kg|KG|公斤|斤|米)?/g,
  },
  {
    id: 'body-unit',
    category: '身体医疗',
    proseOnly: true,
    label: '带单位的体重/长度数值',
    severity: 'medium',
    placeholder: P.BODY_DATA,
    re: /(?<![\d.])\d{2,3}(?:\.\d)?\s*(?:cm|厘米|kg|公斤|斤)(?![\u4e00-\u9fa5])/g,
  },
  {
    id: 'body-bp',
    category: '身体医疗',
    label: '血压读数',
    severity: 'high',
    placeholder: P.BODY_DATA,
    re: /血压\s*[:：]?\s*\d{2,3}\s*[/／]\s*\d{2,3}/g,
  },
  {
    id: 'body-profile',
    category: '身体医疗',
    proseOnly: true,
    label: '体检/病历/诊断类资料',
    severity: 'high',
    placeholder: P.BODY_DATA,
    re: /体检报告|体检单|体检结果|病历|诊断书|就诊记录|处方|心理诊断|精神科|心理咨询|双相|焦虑症|进食障碍|睡眠障碍|ADHD/gi,
  },
  {
    id: 'body-mood',
    category: '身体医疗',
    proseOnly: true,
    label: '情绪/心理状态词（弱）',
    severity: 'low',
    placeholder: P.BODY_DATA,
    re: /抑郁症?|焦虑|自伤|躯体化/g,
  },

  // ── 7. 聊天 / 日记叙事特征 ──
  {
    id: 'narrative-quote',
    category: '聊天日记',
    label: '「他说/使用者说」+ 引号内容',
    severity: 'medium',
    placeholder: P.NARRATIVE,
    re: /(?:他|她|使用者)(?:说|说过|问我|讲过|跟我讲|告诉我)\s*[:：]?\s*[「“"]([^」”"\n]{2,60})[」”"]/g,
    useGroup: 1,
  },
  {
    id: 'narrative-relation',
    category: '聊天日记',
    label: '关系叙事用语',
    severity: 'medium',
    placeholder: P.NARRATIVE,
    re: /我们之间|我和他之间|给他的信|她写给我的|她说的话|我对她说过/g,
  },
  {
    id: 'narrative-diary',
    category: '聊天日记',
    label: '日记日期标题',
    severity: 'high',
    placeholder: P.NARRATIVE,
    re: /^#{1,4}\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*[·・|｜]/gm,
  },

  // ── 8. 联系 / 账号 ──
  {
    id: 'email',
    category: '联系账号',
    label: '邮箱地址',
    severity: 'high',
    placeholder: P.EMAIL,
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}\b/g,
    accept: (m) => !/^(?:[^@]*\@(?:example|test|localhost|domain)\b)/i.test(m)
      && !/\{\{/.test(m) && !/^<.*>$/.test(m) && !/\.(?:png|jpg|gif|svg|webp)$/i.test(m),
  },
  {
    id: 'phone',
    category: '联系账号',
    label: '手机号',
    severity: 'high',
    placeholder: P.PHONE,
    re: /(?<![\d.])1[3-9]\d{9}(?![\d.])/g,
    accept: (m) => !/^1(?:2345|0000)/.test(m),
  },
  {
    id: 'wechat',
    category: '联系账号',
    label: '微信号',
    severity: 'high',
    placeholder: P.WECHAT,
    re: /(?:微信号|微信|wechat|weixin)\s*[:：=]\s*([A-Za-z][A-Za-z0-9_-]{5,19})/gi,
    useGroup: 1,
  },
  {
    id: 'bili-uid',
    category: '联系账号',
    label: 'B站 UID / mid',
    severity: 'medium',
    placeholder: P.BILI,
    re: /\b(?:mid|uid|up_mid|receiver_uid)\s*[=:：]\s*["']?(\d{3,12})(?!\d)/gi,
    useGroup: 1,
    accept: (m) => !/^(?:0+|[1-9]|1\d|2\d|11|22|111|222|999|000|123|1234|12345|10086|10001)$/.test(m),
  },
  {
    id: 'bili-space',
    category: '联系账号',
    label: 'B站空间链接',
    severity: 'low',
    placeholder: P.BILI,
    re: /space\.bilibili\.com\/(\d{3,12})/g,
    useGroup: 1,
  },
  {
    id: 'weibo',
    category: '联系账号',
    label: '微博 ID / 链接',
    severity: 'medium',
    placeholder: P.WEIBO,
    re: /weibo\.com\/(?:u\/)?(\d{5,12})/g,
    useGroup: 1,
  },

  // ── 9. 本地用户名 ──
  {
    id: 'local-user',
    category: '本地用户名',
    label: '用户名出现在路径段里',
    severity: 'high',
    placeholder: P.USER,
    re: new RegExp(`[\\\\/](?:${escapeRe(LOCAL_USER || 'NOBODY')}|Administrator)(?=[\\\\/]|$)`, 'gi'),
    accept: (m) => LOCAL_USER.length >= 2 && !PLACEHOLDER_HINT.test(m),
  },
  {
    id: 'git-identity',
    category: '本地用户名',
    label: 'git 配置里的身份',
    severity: 'high',
    placeholder: P.USER,
    re: /^\s*\[?user\]?\s*\n?\s*(?:name|email)\s*=\s*([^\n]{2,60})/gim,
    useGroup: 1,
  },
]

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// 把种子规则展开成普通正则规则。
// 占位符名字会随工程演进（OWNER_QQ → OWNER_ID 之类），所以按「值长什么样 + 名字里含什么词」路由，
// 不写死某几个占位符名。
// 单位/格式词经常混在 REWRITE 的字符类里（公斤、cm…），它们不是人也不是机构
const SEED_UNIT_STOP = /^(?:公斤|千克|斤|克|厘米|毫米|米|kg|cm|mm|km|ml|岁|元|块|次|个|条|张|页|行|字|号|级|度|档|分|秒|点|天|月|年|小时|分钟|以及|或者|之内|左右|上下|之间|以上|以下)$/i
function routeSeed(value, ph) {
  if (SEED_UNIT_STOP.test(value)) return null
  const p = ph.toUpperCase()
  const isNum = /^\d+$/.test(value)
  const isCjk = /[\u4e00-\u9fa5]/.test(value)
  if (isNum) {
    if (value.length >= 9) return { category: 'QQ号', label: `工程已知号码（${ph}）`, severity: 'high' }
    return null // 2-3 位数字当种子会把全工程都扫成命中，直接不要
  }
  if (/TOKEN|KEY|SECRET|PASS/.test(p)) return { category: '令牌密钥', label: `工程已知凭据（${ph}）`, severity: 'high' }
  if (isCjk && /INSTITUTION|UNIVERSITY|COLLEGE|SCHOOL/.test(p)) return { category: '机构地点', label: `工程已知机构名（${ph}）`, severity: 'high' }
  if (isCjk && /CITY|CAMPUS|PLACE|LOCATION|ADDRESS/.test(p)) return { category: '机构地点', label: `工程已知地点（${ph}）`, severity: 'medium' }
  if (isCjk) {
    const sev = /BOT/.test(p) ? 'medium' : 'high'
    return { category: '真实人名', label: `工程已知人名（${ph}）`, severity: sev }
  }
  if (/^[A-Za-z][A-Za-z .'-]{5,40}$/.test(value)) return { category: '真实人名', label: `工程已知昵称（${ph}）`, severity: 'high' }
  return null
}

function expandSeeds() {
  const out = []
  const seedRule = RULES.find((r) => r.seeds)
  for (const r of RULES) if (!r.seeds) out.push(r)
  for (const s of SEEDS) {
    const route = routeSeed(s.value, s.placeholder)
    if (!route) continue
    out.push({
      ...seedRule,
      id: `seed:${route.category}`,
      category: route.category,
      label: route.label,
      severity: route.severity,
      proseOnly: true,
      placeholder: s.placeholder,
      re: new RegExp(escapeRe(s.value).replace(/\s+/g, '\\s+'), 'gi'),
      seedValue: s.value,
      accept: (m, ctx) => {
        // 两个汉字以内的简称（如「山大」）必须独立成词，否则「压力山大」也会被算进来
        if (/^[\u4e00-\u9fa5]{1,2}$/.test(s.value)) {
          const at = ctx.window.indexOf(m)
          if (at >= 0) {
            const before = ctx.window[at - 1] ?? ''
            const after = ctx.window[at + m.length] ?? ''
            if (/[\u4e00-\u9fa5]/.test(before) || /[\u4e00-\u9fa5]/.test(after)) return false
          }
        }
        return true
      },
    })
  }
  return out
}const ACTIVE_RULES = expandSeeds()

// ───────────────────── 遍历 ─────────────────────
const stats = { scanned: 0, skippedDir: 0, skippedExt: 0, skippedLink: 0, skippedSize: 0, skippedBinary: 0, skippedSelf: 0, skippedIgnore: 0, wordLists: 0, links: [] }
const SELF_PATH = (() => {
  try { return fs.realpathSync(process.argv[1]) } catch { return '' }
})()
const files = []
const seenReal = new Set()

function walk(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return }
  if (st.isSymbolicLink()) {
    const target = (() => { try { return fs.realpathSync(p) } catch { return '?' } })()
    stats.skippedLink += 1
    stats.links.push({ path: path.relative(ROOT, p) || p, target })
    if (!opt.followLinks) return
    let st2
    try { st2 = fs.statSync(p) } catch { return }
    if (st2.isDirectory()) { if (!seenReal.has(target)) { seenReal.add(target); walkDir(p) } }
    return
  }
  if (st.isDirectory()) walkDir(p)
  else if (st.isFile()) considerFile(p, st)
}

function walkDir(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) && !(e.name === 'dist' && ROOT_IS_DIST)) { stats.skippedDir += 1; continue }
      if (e.name === '.dsh' ) { stats.skippedDir += 1; continue }
      if (e.isSymbolicLink()) { walk(p); continue }
      walkDir(p)
    } else if (e.isSymbolicLink()) walk(p)
    else if (e.isFile()) {
      let st
      try { st = fs.statSync(p) } catch { continue }
      considerFile(p, st)
    }
  }
}

function considerFile(p, st) {
  const ext = path.extname(p).toLowerCase()
  if (!EXT.has(ext)) { stats.skippedExt += 1; return }
  if (/\.bak-privacy$/i.test(p)) { stats.skippedExt += 1; return }
  if (SELF_PATH && path.resolve(p).toLowerCase() === SELF_PATH.toLowerCase()) { stats.skippedSelf += 1; return }
  if (opt.ignore.length) {
    const norm = p.replace(/\\/g, '/').toLowerCase()
    if (opt.ignore.some((s) => norm.includes(s.replace(/\\/g, '/').toLowerCase()))) { stats.skippedIgnore += 1; return }
  }
  if (st.size > MAX_FILE_BYTES) { stats.skippedSize += 1; return }
  files.push({ path: p, size: st.size })
}

// 词表/词频文件（一行一个词）不是散文：散文类规则在上面只会产生噪音
function isWordList(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 50) return false
  let plain = 0
  for (const l of lines.slice(0, 400)) {
    const t = l.trim()
    if (t.length <= 10 && !/[，。；：！？、,.!?;:"'「」（）()]/.test(t)) plain += 1
  }
  return plain / Math.min(lines.length, 400) > 0.6
}

if (ROOT_IS_FILE) {
  const st = fs.statSync(ROOT)
  considerFile(ROOT, st)
} else {
  walk(ROOT)
}

// ───────────────────── 扫描 ─────────────────────
const hits = []

function lineIndex(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}
function lineOf(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1
  }
  return lo
}

for (const f of files) {
  let text
  try { text = fs.readFileSync(f.path, 'utf8') } catch { continue }
  if (text.includes('\u0000')) { stats.skippedBinary += 1; continue }
  stats.scanned += 1
  const wordList = isWordList(text)
  if (wordList) stats.wordLists += 1
  const rel = path.relative(ROOT, f.path) || path.basename(f.path)
  const starts = lineIndex(text)
  const lines = text.split('\n')

  for (const rule of ACTIVE_RULES) {
    if (rule.proseOnly && wordList) continue
    let re
    try { re = new RegExp(rule.re.source, rule.re.flags) } catch { continue }
    let m
    let guard = 0
    while ((m = re.exec(text)) !== null) {
      guard += 1
      if (guard > 5000) break
      if (m[0] === '') { re.lastIndex += 1; continue }
      const raw = rule.useGroup ? m[rule.useGroup] : m[0]
      if (raw === undefined || raw === '') continue
      const offset = rule.useGroup ? m.index + m[0].indexOf(raw) : m.index
      const ln = lineOf(starts, offset)
      const col = offset - starts[ln]
      const lineText = lines[ln] ?? ''
      const ctx = {
        line: lineText,
        file: rel,
        full: m[0],
        window: lineText.slice(Math.max(0, col - 24), col + raw.length + 24),
        before: lineText.slice(Math.max(0, col - 28), col),
        wordList,
      }
      if (rule.accept && !rule.accept(raw, ctx)) continue
      const placeholder = rule.placeholderFor ? rule.placeholderFor({ ...ctx, match: raw }) : rule.placeholder
      const c = clip(raw)
      hits.push({
        file: rel,
        line: ln + 1,
        column: offset - starts[ln] + 1,
        category: rule.category,
        rule: rule.id,
        label: rule.label,
        severity: rule.severity,
        match: c.text,
        truncated: c.truncated,
        placeholder,
        _offset: offset,
        _len: raw.length,
        _abs: f.path,
      })
    }
  }
}

// 去重（同一文件同一行同一类别同一切片只留一条）
const uniq = []
const seenKey = new Set()
for (const h of hits) {
  const k = `${h.file}|${h.line}|${h.category}|${h.match}`
  if (seenKey.has(k)) continue
  seenKey.add(k)
  uniq.push(h)
}
uniq.sort((a, b) => {
  const rank = { high: 0, medium: 1, low: 2 }
  return (rank[a.severity] - rank[b.severity]) || a.file.localeCompare(b.file) || (a.line - b.line)
})

// ───────────────────── 汇总 ─────────────────────
const byCategory = {}
const bySeverity = { high: 0, medium: 0, low: 0 }
const filesByCategory = {}
for (const h of uniq) {
  byCategory[h.category] = (byCategory[h.category] || 0) + 1
  bySeverity[h.severity] += 1
  ;(filesByCategory[h.category] ||= new Set()).add(h.file || '(root)')
}
const affectedFiles = new Set(uniq.map((h) => h.file || '(root)'))

// ───────────────────── --fix ─────────────────────
if (opt.fix) {
  // 只处理有具体 match 的高/中危项；每条替换都必须落在扫描根内（防穿透 junction）
  const fixable = uniq.filter((h) => h.severity !== 'low' && h.match)
  const byFile = new Map()
  for (const h of fixable) {
    if (!byFile.has(h._abs)) byFile.set(h._abs, [])
    byFile.get(h._abs).push(h)
  }
  const realRoot = (() => { try { return fs.realpathSync(ROOT_IS_FILE ? path.dirname(ROOT) : ROOT) } catch { return ROOT } })()
  const plan = []
  for (const [abs, list] of byFile) {
    let real = abs
    try { real = fs.realpathSync(abs) } catch { /* keep */ }
    const inside = real.toLowerCase().startsWith(realRoot.toLowerCase())
    plan.push({ abs, rel: path.relative(ROOT, abs), inside, list })
  }
  if (!opt.json) {
    console.log(`\n── --fix 计划（${plan.reduce((n, p) => n + p.list.length, 0)} 处，${plan.length} 个文件）──`)
    for (const p of plan) {
      if (!p.inside) {
        console.log(`  [跳过] ${p.rel} —— 链接目标不在扫描根内，绝不改`)
        continue
      }
      console.log(`  ${p.rel}`)
      for (const h of p.list) {
        console.log(`      L${h.line}:${h.column} [${h.category}/${h.severity}] '${h.match}' → ${h.placeholder}`)
      }
    }
  }
  if (!opt.yes) {
    if (!opt.json) console.log('\n以上只是清单。确认后加 --yes 真写（每个文件会留 .bak-privacy 备份）。')
    process.exit(uniq.length ? 1 : 0)
  }
  // 真写：按偏移从大到小替换，避免位置漂移
  let written = 0
  let replaced = 0
  for (const p of plan) {
    if (!p.inside) continue
    let text
    try { text = fs.readFileSync(p.abs, 'utf8') } catch { continue }
    const list = [...p.list].sort((a, b) => b._offset - a._offset)
    let changed = 0
    for (const h of list) {
      const seg = text.slice(h._offset, h._offset + h._len)
      if (seg !== h.match && clip(seg).text !== h.match) {
        // 片段被截断过，用原始行内容兜底
        continue
      }
      text = text.slice(0, h._offset) + h.placeholder + text.slice(h._offset + h._len)
      changed += 1
    }
    if (!changed) continue
    try {
      fs.copyFileSync(p.abs, p.abs + '.bak-privacy')
      fs.writeFileSync(p.abs, text, 'utf8')
      written += 1
      replaced += changed
    } catch (e) {
      console.error(`  [写失败] ${p.rel}: ${e?.message ?? e}`)
    }
  }
  console.log(`\n已改 ${written} 个文件 / ${replaced} 处；备份后缀 .bak-privacy`)
}

// ───────────────────── 输出 ─────────────────────
if (opt.json) {
  const report = {
    scanner: `scan-privacy.mjs ${VERSION}`,
    target: ROOT,
    scannedAt: new Date().toISOString(),
    seeds: SEEDS.map((s) => ({ placeholder: s.placeholder, length: s.value.length })),
    files: {
      scanned: stats.scanned,
      matched: affectedFiles.size,
      skippedDir: stats.skippedDir,
      skippedExt: stats.skippedExt,
      skippedLink: stats.skippedLink,
      skippedSize: stats.skippedSize,
      skippedBinary: stats.skippedBinary,
    },
    links: stats.links,
    totals: { hits: uniq.length, byCategory, bySeverity },
    filesByCategory: Object.fromEntries(Object.entries(filesByCategory).map(([k, v]) => [k, v.size])),
    hits: uniq.map((h) => ({
      file: h.file, line: h.line, column: h.column,
      category: h.category, rule: h.rule, label: h.label,
      severity: h.severity, match: h.match, truncated: h.truncated,
      placeholder: h.placeholder,
    })),
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(uniq.length ? 1 : 0)
}

const sevMark = { high: '🔴', medium: '🟠', low: '⚪' }
console.log(`scan-privacy.mjs ${VERSION}`)
console.log(`目标：${ROOT}${ROOT_IS_FILE ? '（单文件）' : ''}`)
console.log(`扫描 ${stats.scanned} 个文件（扩展名跳过 ${stats.skippedExt}，目录跳过 ${stats.skippedDir}，超限 ${stats.skippedSize}，二进制 ${stats.skippedBinary}）`)
if (stats.skippedLink) {
  console.log(`跳过 ${stats.skippedLink} 个链接（不跟随；要看加 --follow-links，--fix 永不穿透）：`)
  for (const l of stats.links.slice(0, 8)) console.log(`  · ${l.path} → ${l.target}`)
}
console.log(`种子 ${SEEDS.length} 条（来自 pack-oss.mjs REWRITE）+ 内置规则 ${RULES.length} 条`)

if (!uniq.length) {
  console.log('\n✓ 干净：0 命中')
  process.exit(0)
}

console.log(`\n命中 ${uniq.length} 处，涉及 ${affectedFiles.size} 个文件`)
console.log(`  高危 ${bySeverity.high} / 中危 ${bySeverity.medium} / 低危 ${bySeverity.low}\n`)
console.log('类别            次数  文件数')
for (const [c, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(14, '　')} ${String(n).padStart(4)}  ${String(filesByCategory[c].size).padStart(4)}`)
}

if (!opt.quiet) {
  let lastFile = ''
  console.log('')
  for (const h of uniq) {
    if (h.file !== lastFile) { console.log(`\n▌ ${h.file}`); lastFile = h.file }
    console.log(`  ${sevMark[h.severity]} L${h.line}:${h.column} [${h.category}] ${h.label}`)
    console.log(`     命中：'${h.match}'${h.truncated ? '（已截断）' : ''}`)
    console.log(`     改成：${h.placeholder}`)
  }
}
console.log(`\n退出码 1（有命中）。CI 里可直接当门禁。`)
process.exit(1)
