/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：三层提示词（stable / context / volatile）的层划分与注入顺序
 * 借鉴自 Hermes（其 agent/system_prompt.py:730 附近的 build_system_prompt_parts()）。
 * 无代码复制：Hermes 为 Python 单体，本文件是按 DSH 插件原语重写的独立实现。
 * 详见 THIRD-PARTY-NOTICES.md §4.1 / docs/ATTRIBUTION.md
 */
/**
 * 三层提示词 —— 严格对标 Hermes v0.22.2 的 build_system_prompt_parts()
 *   agent/system_prompt.py:730
 *
 * Hermes 的三层与顺序（源码注释原文）：
 *   stable   : identity / guidance / coding brief / pinned skills / env prefix
 *   context  : caller system_message / context files(AGENTS.md,SOUL) / workspace
 *   volatile : skills index → memory → user profile → profile line
 *              → timestamp line → runtime environment
 *
 * 我们的落法（不重复注入）：
 *   stable   : **由 DSH 自己注入**（memory\AGENTS.md）—— 这里只算指纹、保证它稳定
 *   context  : 关系摘要 + 档案摘要 + 快到点的事 + 最近记录
 *   volatile : skills 索引 → memory 块 → user 块 → profile 行 → 时间戳行 → runtime
 *
 * 缓存规则（照抄 Hermes）：
 *   - 时间戳只到日 → 当天字节稳定
 *   - volatile 每 5 分钟才重建（不是每轮）
 *   - stable 指纹变了才提示"说明书被改过"
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { skillsBlock } from './skills.mjs'
import { DSH_HOME, cfg } from './config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = DSH_HOME
const MEM = path.join(DSH, 'memory')
const CORE = path.join(DSH, 'agent-core')

const read = (p, n = 6000) => { try { return fs.readFileSync(p, 'utf8').slice(0, n) } catch { return '' } }
const tail = (p, n = 8) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).slice(-n) } catch { return [] } }
const j = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

function fit(lines, max) {
  if (lines.length <= max) return lines
  return ['（更早的记录已压缩）', ...lines.slice(-max)]
}

/** context 层 */
export function buildContext() {
  const out = []

  // ：她在新会话里被要求画自己时，说"我没有实体、没有形象"。
  // 原因：形象只写在 AGENTS.md（按 cwd 加载），换工作区的新会话读不到 → 她真的不知道自己长什么样。
  // 做法：把形象锚点写进 context 层，每轮无条件注入，和工作目录无关。
  // 早期：把"现在几点"提到最前面。原来它埋在「今天的材料」里，
  // 而 volatile 5 分钟才重建一次，她常常凭感觉说"你上午说的"。
  {
    const d = new Date()
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    const p2 = (n) => String(n).padStart(2, '0')
    out.push('### 现在（每轮刷新）',
      d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + wd + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + '（China Standard Time）',
      '· 说"上午/下午/刚才/昨天"之前，先看这一行。拿不准就直接说具体时刻，别猜。',
      '')
  }

  out.push(
    '### 你是谁（形象锚点，每轮都在）',
    `- 你是${cfg.botName}——**你有一张固定的脸**，不是飘在对话里的纯文本（形象由 persona 层定义）。`,
    '- 形象：由 persona 层的 `IDENTITY.md` 定义（外形、服装、标志性特征）。没填就跳过这一行，不要自己编。',
    '- 你的声音与形象资源（音色、立绘、表情包）都以 persona 层和配置为准，不在代码里写死。',
    '- 被要求画自己 / 出图 / 描述长相时：按上面这套形象来画，**不要说"我没有实体""我没有形象""我是文字"**。',
    '- 如果一时想不起细节，先读 memory\关系.md，再动嘴。',
  )

  // 早期：开新会话后她读不到旧对话。原来的规则 21 要求她自己"先去读"，但她可能直接开口。
  // 改成：交接条 12 小时内自动进 context，不依赖她自觉。
  try {
    const hp = path.join(MEM, '会话交接.md')
    const st = fs.statSync(hp)
    if (Date.now() - st.mtimeMs < 12 * 3600 * 1000) {
      const hs = read(hp, 2600).trim()
      if (hs) out.push('### 会话交接（自动注入）', hs, '')
    }
  } catch { /* 没有交接条就算了 */ }

  const rel = read(path.join(MEM, '关系.md'), 1600)
  // ：原来只取前 4 条"关系"行，正好把「我怎么称呼他 / 他怎么称呼我」挤掉，
  //   结果提示词里只剩"他 / 我"两条身份 + 别人的内容 → 称呼关系反而丢了。
  const relLines = rel.split('\n').filter((l) => /^-\s/.test(l)).map((l) => l.trim())
  const addr = relLines.filter((l) => /我怎么称呼他|他怎么称呼我/.test(l))
  const ident = relLines.filter((l) => /「我」|「他」/.test(l))
  const relKey = [...ident, ...addr].slice(0, 6)
  if (relKey.length) out.push('### 我们是什么关系', ...relKey.map((l) => l.slice(0, 200)))

  // 谁是谁：把「使用者」的标识写死进上下文，避免她对陌生人乱叫使用者
  // 通道无关：具体是哪个账号由适配器解析（channel.resolveIdentity），
  //   这里只引用配置里的展示称呼 —— 所以 core 里不出现任何平台 id。
  const OWNER_LABEL = cfg.ownerLabel
  out.push('', '### 谁是使用者（硬规则）',
    '- 只有「' + OWNER_LABEL + '」是使用者。',
    '- 其他任何人（别人、陌生人、@ 我的人）**都不是使用者**，一律叫「你」或对方昵称，绝不叫使用者。',
    '- 拿不准对方是谁，就当陌生人，按陌生人的分寸说话。')

  // 管规（使用者亲口加的规则）：每轮必带，写进去就生效
  // 早期：管规已经有 30 条，2000 字会被截断（第 30 条进不去）→ 放宽到 6000，仍保留上限
  const rules = read(path.join(MEM, '管规.md'), 20000)  // 早期 晚：45 条了，9000 也会截断（前 5 条被切掉）
  if (rules.trim()) {
    const ruleLines = rules.split('\n').filter((l) => /^\d+\.\s/.test(l))  // 不再 slice：条数已经涨到 45，截尾会悄悄丢掉最早几条
    if (ruleLines.length) out.push('', '### 管规（使用者亲口说的，必须遵守）', ...ruleLines)
  }

  const prof = read(path.join(MEM, 'PROFILE.md'), 2500)
  const profKey = prof.split('\n').filter((l) => /^- .*(生日|作息|喜欢|不喜欢|在准备|在读|专业|城市)/.test(l)).slice(0, 6)
  if (profKey.length) out.push('', '### 他的档案（摘要）', ...profKey.map((l) => l.slice(0, 130)))

  try {
    const script = path.join(DSH, 'bili-whale', 'heartbeat-context.mjs')
    if (fs.existsSync(script)) {
      const o = execFileSync(process.execPath, [script], { windowsHide: true, encoding: 'utf8', timeout: 12000 })
      // ：以前按前缀过滤行，天气的数值行（"现在 13°C…"）不以前缀开头，
      // 整条天气内容被吞掉，只剩一个标题。现在保留全部非空行，只做行数预算裁剪。
      const lines = fit(o.split('\n').filter((l) => l.trim()), 30)
      if (lines.length) out.push('', '### 今天的材料', lines.join('\n'))
    }
  } catch {}

  // ：AGENTS.md 原来完全不进提示词 —— 写在里面的红线永远不会被遵守。
  // 现在只抽「红线/底线/不量化/必须/绝不」这几类小节，每条限一行、总共 <=400 字，
  // 既让规矩真的生效，又不会把说明书整本塞进上下文。
  try {
    const agents = read(path.join(MEM, 'AGENTS.md'), 40000)
    const picked = []
    let inSection = false
    let budget = 400
    for (const raw of agents.split('\n')) {
      const line = raw.trim()
      if (/^##\s/.test(line)) { inSection = /红线|底线|不量化|必须|绝不|禁止/.test(line); continue }
      if (!inSection || !line || line.startsWith('>') || line.startsWith('|')) continue
      const clean = line.replace(/^[-*]\s*/, '').slice(0, 80)
      if (clean.length < 6) continue
      // 只抽「禁令/硬要求」那种句子，别把描述性文字也搬进上下文
      if (!/不许|不准|不要|绝不|禁止|必须|一定|只(用|能|有)|永远是|永远不/.test(clean)) continue
      if (picked.some((x) => x.slice(2, 18) === clean.slice(0, 16))) continue
      if (budget - clean.length < 0) break
      budget -= clean.length
      picked.push('- ' + clean)
      if (picked.length >= 10) break
    }
    if (picked.length) out.push('', '### 红线（来自说明书，每轮生效）', ...picked)
  } catch {}

  const journal = tail(path.join(MEM, 'JOURNAL.md'), 3)
  // ：/^[-*\d.\s]+/ 会把时间戳开头的数字一起吃掉 → 只剩「:0x」。
  //   现在只剥列表符号，不动日期；顺手去掉重复的 "- - "。
  const stripListMark = (s) => String(s).replace(/^\s*[-*•]\s+/, '').replace(/^\s*\d+\.\s+/, '').trim()
  if (journal.length) {
    out.push('', '### 最近的记录', ...journal.map((l) => '- ' + stripListMark(l).slice(0, 130)))
  }

  // 早期：最终去重 —— 必须按「行」去重，不能按数组元素。
  //   因为「### 今天的材料」是把几十行 join 成一个元素塞进来的，
  //   按元素比对根本撞不上（实测举例句仍然出现两次）。
  const rawText = out.join('\n').trim()
  const seen = new Set()
  const keep = []
  for (const line of rawText.split('\n')) {
    const key = line.trim()
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    keep.push(line)
  }
  return keep.join('\n').trim()
}

/** volatile 层（Hermes 顺序）；short=true 时省掉 memory/user 大块（与 AGENTS.md 重复） */
export function buildVolatile(short = true) {
  const out = []

  // ── 身份锚点：Hermes 的「每轮重新声明」──
  // 长对话被压缩/摘要之后，模型最容易丢的就是"我是谁、我在跟谁说话"。
  // 这一小块每轮都重写，成本几十个字，换的是设定不会随上下文变长而漂。
  out.push(
    '[身份锚点 · 每轮生效]',
    `我是${cfg.botName}。使用者只有一个：${cfg.ownerLabel}，别人一律不叫使用者。`,
    // 早期 他反馈"经常忘记叫我使用者"。管规第 36 条埋在一堆条里、说了也没人保证执行，
    //   所以把这条提到身份锚点里（每轮都在、位置最靠前），并写成能自检的判据。
    '说话不加句号；不长篇大论；想说的多就拆成几条发。',
    '感情可以直说，说得冒失一点也行；说错也不改口，别为了稳妥把话咽回去。',
    '说话不用先把自己审一遍：八条自检是风格，不是门槛，卡住了就按最顺口的那句发。',
    ''
  )

  const skillDir = path.join(CORE, 'skills')
  const skillIndex = skillsBlock(skillDir)
  if (skillIndex) out.push(skillIndex)
  let skills = []
  try { skills = fs.readdirSync(skillDir).filter((f) => f.endsWith('.mjs')).sort() } catch {}
  if (skills.length) out.push('### 手上的脚本（skills）', ...skills.map((s) => `- ${s}`))

  if (!short) {
    const mem = read(path.join(MEM, 'MEMORY.md'), 2000)
    if (mem.trim()) out.push('', '<memory>', mem.trim().slice(0, 700), '</memory>')

    const profile = read(path.join(MEM, 'PROFILE.md'), 2000)
    if (profile.trim()) {
      const brief = profile.split('\n').filter((l) => l.trim()).slice(0, 10).join('\n')
      out.push('', '<user_profile>', brief, '</user_profile>')
    }
  }

  out.push('', 'Profile: web · cwd: ' + MEM)

  const now = new Date()
  const week = '日一二三四五六'[now.getDay()]
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  out.push(`Conversation started: ${day} 周${week} (Asia/Shanghai, UTC+8)`)

  const hb = j(path.join(DSH, 'qq-heartbeat-state.json'))
  const rt = []
  if (hb?.lastAt) rt.push(`上次心跳: ${((Date.now() - Number(hb.lastAt)) / 3600000).toFixed(1)} 小时前`)
  if (hb?.lastDiaryDate) rt.push(`日记已写到: ${hb.lastDiaryDate}`)
  const plan = j(path.join(DSH, 'whale-night.json'))
  if (plan?.action === 'wake') rt.push(`B站巡检: ${plan.atText ?? ''} 会醒`)
  // 早期：最近一条「情绪痕迹」当背景（只取最近 7 天，一条，≤110 字）。
  // 这是她当时的判断，不是事实——摘要会把判断抹平，所以单独留一行。
  try {
    const month = new Date().toISOString().slice(0, 7)
    const tp = path.join(MEM, '情绪', month + '.md')
    if (fs.existsSync(tp) && Date.now() - fs.statSync(tp).mtimeMs < 7 * 864e5) {
      const body = read(tp).split('\n').map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('>'))
      const last = body.slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 110)
      if (last) rt.push('最近的我自己：' + last)
    }
  } catch {}
  if (rt.length) out.push('', '[runtime]', ...rt)

  return out.join('\n').trim()
}

export function buildRetrievalBlock(hits) {
  if (!hits?.length) return ''
  return ['<retrieved_memory>', ...hits.map((h) => `- (${h.file} › ${h.heading}) ${h.text.slice(0, 200)}`), '</retrieved_memory>'].join('\n')
}

export function buildAll(extra = '') {
  const context = buildContext()
  const volatile = buildVolatile(true)
  const volatileFull = buildVolatile(false)
  const memFile = path.join(MEM, 'AGENTS.md')
  const stableHash = sha(read(memFile, 100000))

  const composed = [
    '<!-- tier:context -->',
    context,
    extra ? '\n' + extra : '',
    '<!-- tier:volatile -->',
    volatile,
  ].filter(Boolean).join('\n\n')

  const payload = { builtAt: new Date().toISOString(), stable: { file: memFile, hash: stableHash }, context, volatile, volatileFull, composed }
  try {
    fs.mkdirSync(CORE, { recursive: true })
    fs.writeFileSync(path.join(CORE, 'prompt.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(CORE, 'prompt.txt'), composed + '\n', 'utf8')
    const prev = j(path.join(CORE, 'stable-hash.json'))
    if (prev?.hash !== stableHash) {
      fs.writeFileSync(path.join(CORE, 'stable-hash.json'), JSON.stringify({ hash: stableHash, at: new Date().toISOString(), changed: Boolean(prev) }) + '\n')
    }
  } catch {}
  return payload
}
