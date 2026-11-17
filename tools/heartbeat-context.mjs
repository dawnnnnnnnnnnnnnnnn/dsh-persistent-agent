#!/usr/bin/env node
/**
 * 心跳上下文打包器 —— 给"每次心跳"准备一份**当天现取的材料**，不让她只靠上下文瞎想。
 *
 * 输出（纯文本，控制在 ~1200 字内）：
 *   一、现在（日期/星期/时间）
 *   二、天气（实时 + 今晚 + 会不会下雨 → 拿伞/添衣/看月亮）
 *   三、他档案里"快到点的事"（考试/面试/DDL/生日/约定）
 *   四、最近他提过的事（JOURNAL 尾巴里抽）
 *   五、心跳自己的节奏（上次什么时候，隔了多久）
 *
 * 用法：node heartbeat-context.mjs [--json]
 * 失败一律降级（没有天气就写"取不到"），绝不阻塞心跳。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || os.homedir()
const MEM = path.join(HOME, '.dsh', 'memory')
const STATE = path.join(HOME, '.dsh', 'qq-heartbeat-state.json')
const CITY = process.env.HEARTBEAT_CITY || ''

const out = []
const log = (s) => out.push(s)

const now = new Date()
const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
log(`## 现在\n${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 周${week} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)

// ── 天气 ──────────────────────────────────────────────────────────
let weatherOk = false
try {
  const r = await fetch(`https://wttr.in/${encodeURIComponent(CITY)}?format=j1&lang=zh`, { signal: AbortSignal.timeout(8000) })
  const j = await r.json()
  const cur = j.current_condition?.[0] ?? {}
  const today = j.weather?.[0] ?? {}
  const astro = today.astronomy?.[0] ?? {}
  const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || ''
  const rain = Math.max(...(today.hourly ?? []).map((h) => Number(h.chanceofrain ?? 0)), 0)
  const maxT = today.maxtempC, minT = today.mintempC
  log(`\n## 天气（${CITY}）\n现在 ${cur.temp_C}°C，${desc}；今天 ${minT}~${maxT}°C；降雨概率最高 ${rain}%；月相 ${astro.moon_phase ?? '?'}`)
  weatherOk = true
} catch {
  log('\n## 天气\n（这次没取到，别编）')
}

// ── 从他档案里挑"快到点的事" ─────────────────────────────────────
/**
 * ：旧写法 l.replace(/^[-*\d.\s]+/, '') 会把行首的日期数字一起吞掉
 *   「早期 13:0x：…」→「:0x：…」，时间只剩分钟。
 * 只剥"列表符号"，不动正文里的数字。
 */
function stripPrefix(line) {
  return String(line)
    .replace(/^\s*[-*•]\s+/, '')     // "- " / "* " / "• "
    .replace(/^\s*\d+\.\s+/, '')     // "1. "
    .trim()
}

const KEYS = /考试|面试|DDL|截止|deadline|报名|交表|答辩|比赛|新生杯|推免|保研|分流|生日|约定|答应|约好|要去|提醒|复查|体检|出发|截止日/i
const DATE_RE = /(\d{1,2}\s*月\s*\d{1,2}\s*[日号])|(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2})|(明天|后天|下周[一二三四五六日天]|这周[一二三四五六日天])/i

function scan(file, max) {
  try {
    const lines = fs.readFileSync(path.join(MEM, file), 'utf8').split('\n')
    return lines
      .filter((l) => l.trim())
      .filter((l) => !/^\s*#/.test(l))                                  // 别把 markdown 标题当内容
      .filter((l) => !/^\s*[-*]?\s*\*{0,2}生日\*{0,2}[：:]/.test(l))    // 生日有单独倒计时块，别重复
      .filter((l) => KEYS.test(l))
      .map((l) => stripPrefix(l))
      .filter((l) => l.length > 4)
      .slice(-max)
  } catch { return [] }
}
const hits = [...scan('JOURNAL.md', 40), ...scan('MEMORY.md', 20), ...scan('PROFILE.md', 10)]
const dated = hits.filter((l) => DATE_RE.test(l)).slice(-8)
const undated = hits.filter((l) => !DATE_RE.test(l)).slice(-4)

log('\n## 快到点 / 他提过的事（从档案里抽的，别原样复述）')
const seen = new Set()
for (const l of [...dated, ...undated]) {
  const line = stripPrefix(l).slice(0, 110)
  if (!line || seen.has(line.slice(0, 24))) continue
  seen.add(line.slice(0, 24))
  log('- ' + line)
}
if (!dated.length && !undated.length) log('- （档案里没挑到，别硬编）')

// ── 生日倒计时 ───────────────────────────────────────────────────
try {
  const prof = fs.readFileSync(path.join(MEM, 'PROFILE.md'), 'utf8')
  const m = prof.match(/生日[：:\s]*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (m) {
    const mo = Number(m[1]), da = Number(m[2])
    let next = new Date(now.getFullYear(), mo - 1, da)
    if (next < now) next = new Date(now.getFullYear() + 1, mo - 1, da)
    const days = Math.ceil((next - now) / 86400000)
    log(`\n## 生日\n他生日 ${mo} 月 ${da} 日 —— 还有 ${days} 天${days <= 30 ? '（该开始想点什么了）' : ''}`)
  }
} catch {}

// ── 心跳节奏 ─────────────────────────────────────────────────────
try {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  if (st.lastAt) {
    const h = ((Date.now() - Number(st.lastAt)) / 3600000).toFixed(1)
    log(`\n## 心跳节奏\n上次心跳 ${h} 小时前`)
  }
} catch {}

// ── 最近记录：**这里不再输出**
//   早期：tiers.mjs 每轮已经注入「### 最近的记录」，而且原来这里还多加一层 "- "（变成 "- - "），
//   等于同一批内容进提示词两次。心跳材料只留天气/快到点/生日/节奏四块。

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: true, weatherOk, text: out.join('\n') }, null, 2))
} else {
  console.log(out.join('\n'))
}
