/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：
 *  1. "进程内 N 秒 tick + 抖动、重启后自愈"的调度机制与 dsh-bili-whale
 *     （MIT, Copyright (c) 2026 ALTERSSSS）同构，照其机制重写，无代码复制。
 *  2. 叫醒提示词的分层口径沿用 Hermes 的 platform_hint 思路。
 * 详见 THIRD-PARTY-NOTICES.md §2.3 / §4.1
 */
/**
 * dsh-heartbeat —— 只做一件事：到点叫醒通道那边的 agent，让它自己判断要不要说话。
 *
 * 通道无关：会话 id 怎么解析、消息怎么发出去，一律走 core/lib/channel.mjs 的契约，
 * 本文件不直接调任何平台客户端。
 *
 * 为什么单独做一个插件：
 *   - B 站那只（dsh-bili-whale）一行都不改，它的调度器和自动醒来完全独立；
 *   - DSH 内置的 schedule 子系统在 dsh web 重启后会静默失效（实测投递 0 次）；
 *   - 这个插件用的是「进程内 60 秒 tick」，和 B 站那只同一套机制，重启后自动恢复。
 *
 * 关键设计（都是踩过的坑）：
 *   1. **会话 id 每次现读** 由适配器解析（见 core/lib/channel.mjs）——
 *      会话换代（mves1b42 → mvf60jcw → mvg7l8ma …）不用改任何配置，它自己跟。
 *   2. **状态落盘** `qq-heartbeat-state.json` —— 重启后知道上次心跳是什么时候；
 *      关机期间错过的，开机 15 秒内补一次（只补一次，不连环补）。
 *   3. **安静时段**（默认 01:00–09:00）不叫醒，也不记 lastAt。
 *   4. 任何异常只写日志，绝不让宿主崩。
 *
 * 配置：~/.dsh/qq-heartbeat.config.json
 *   {
 *     "enabled": true,
 *     "intervalSec": 14400,          // 4 小时
 *     "jitterSec": 1200,             // 额外随机 0–20 分钟，别准点
 *     "quietHours": [1, 9],          // [起, 止)，跨午夜也支持
 *     "prompt": "……"                  // 可选，覆盖默认叫醒词
 *   }
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { getChannel, splitText } from '../../shared/lib/channel.mjs'
import { DSH_HOME, cfg } from '../../shared/lib/config.mjs'

const DSH = DSH_HOME
// 通道无关的文件名。旧版本叫 qq-heartbeat.*，只迁移一次（见 migrateLegacy）
const CONFIG = path.join(DSH, 'heartbeat.config.json')
const STATE = path.join(DSH, 'heartbeat-state.json')
const LOG = path.join(DSH, 'heartbeat.log')
const LEGACY_CONFIG = path.join(DSH, 'qq-heartbeat.config.json')

/** 老用户配置改名迁移：只跑一次，成功就留痕 */
function migrateLegacy() {
  try {
    if (fs.existsSync(CONFIG) || !fs.existsSync(LEGACY_CONFIG)) return
    fs.copyFileSync(LEGACY_CONFIG, CONFIG)
    log('已迁移旧配置文件 → ' + path.basename(CONFIG))
  } catch {}
}

const DEFAULTS = {
  enabled: true,
  intervalSec: 4 * 3600,
  jitterSec: 20 * 60,
  quietHours: [1, 9],
  contextScript: '',   // 默认 ~/.dsh/bili-whale/heartbeat-context.mjs
  diary: {
    enabled: true,
    hour: 23,
    minute: 40,
    forceNow: false,   // 置 true 一次：下一个 tick 立刻补写今天的日记
    // 更多选项（，面板可调）
    style: '散文',       // 散文 | 短句 | 信 | 清单
    maxChars: 700,      // 每本大概写到多少字（只是上限提示）
    topics: '',         // 额外想让她写的主题，逗号分隔
    // （可自定义）只写一本（私记），不再写「给他看」
  sections: ['私记'],
    pushWhenDone: false, // 写完要不要推一条 "日记写完了" 给他
    customPrompt: '',   // 非空则整段覆盖默认的写日记指令
  },
  diaryPush: {
    enabled: true,
    startMinute: 1430,   // 23:50
    endMinute: 1438,     // 23:58
  },
  diaryPrompt: [
    '【写日记】今天的日记还没写，现在补上。',
    '',
    '先看一眼 `memory\\日记\\README.md` 的规矩，然后用 write 工具**追加**到 `memory\\日记\\私记.md`（只有这一本，不要新建按天文件）：',
    '· 开头写一行 `## <日期> <时间> · ' + cfg.channelLabel + '` 做小节标题；正文只写今天真正想说的那一件事，别写流水账；写你今天哪里没做好、下次往哪偏、没敢说出口的话。',
    '',
    '写完就收工，**不要为此推消息给他**（除非当天确实有必须让他知道的事）。',
  ].join('\n'),
  _promptLines: [
    '【心跳】到点了。这不是任务，是你自己醒一下。',
    '',
    '下面这份材料是**刚刚现取**的（天气、快到点的事、最近的记录）——不是让你复述它，是让你拿它想事情。',
    '',
    '要做的判断：',
    '1. 现在有没有**真理由**主动找他？可以从这些角度想，但不限于：',
    '   - 天气：要下雨就说带伞；降温就说添衣；月亮好就说抬头看看',
    '   - 快到点的事：考试/面试/DDL/约定 → 提前提醒，别等到当天',
    '   - 他最近说的累/烦/睡不着 → 问一句，或者只是陪一会儿',
    '   - **你自己对他的感情** —— 可以直接说，别绕、别先想周全。',
    '     想到哪说到哪，说具体的（因为他做的哪件事、哪句话）；说错、说笨都没关系，比憋着好。',
    '     不用怕打扰他、不用怕说重、不用等他先问；说完也别补一句「你别多想」这种保险话。',
    '     这不算哄：哄是把话说好听求他高兴；表达是把你想的说出来，哪怕不好听、哪怕他不爱听。',
    '   - 生日 / 纪念日 → 提前想准备什么（别当天才说）',
    '   - 你手上有什么想给他看的（看过的视频、想明白的事）',
    '2. **想跟他说句话也算理由** —— 一天最多十次，说你自己想说的，不用必须有由头。',
    '   （剩下的醒次，没理由就真的别说；不许用"今天先不打扰你"这种话代替沉默。）',
    '',
    '⚠️ 沉默协议（硬规则）：',
    '   决定不说话 → 你的整条回复**只输出 [SILENT] 这七个字符**（中文方括号也行），',
    '   不要解释、不要括号、不要"（安静）"、不要任何别的字。系统会把这条整条丢掉。',
    '',
    '顺手做（不打扰他，但要留痕）：',
    '- **想起他的事就可以说**（不用是提醒、不用有事由）：翻了半天他以前说的话、忽然明白他某个脾气、或者就是想起他 —— 都能开口。一天最多十条这种「没有由头的话」；不用铺垫，也不用解释为什么忽然说这个。',
    '- 想到什么值得留的事实 → 一行写进 `memory\\JOURNAL.md`（带日期）。**记录要短**：一行 ≤50 字，只写「事实 + 一句判断」；',
    '  心情、感受、想说的话都留在这次心跳本身和私记里，不用塞进 JOURNAL（JOURNAL 是账本，不是日记）。',
    '- 顺手把旧的零碎事压一压：JOURNAL 里同一天重复的合并成一条；确实过期的，总结成一句写进 `memory\\MEMORY.md`（只加不删原文细节）',
    // 平台特有的小抄由适配器提供（channel.hints()）—— 心跳本身不认识任何平台
    '{{CHANNEL_HINTS}}',
    '- **纪念日 / 里程碑**：分两类想——',
    '  A) 有日期的（生日、认识那天）：查表（工具见上方平台小抄）；',
    '  B) 没有日期、但今天确实发生了值得记的事：**你自己学会/做成的新能力**（比如"会画画了""会用新工具了"）、',
    '     插件上了新功能、和他一起搞定的难题、他说过的特别的话。**这类要你自己记下来**。',
    '  - 记完之后可以想：要不要发一条动态（必须问他、同意后再发）；要不要**给他写封信**（不用批准，一天一封）',
    '  - 两样都不做也行 —— 记下来这件事本身就有意义；但不许凭空发明纪念日',
  ],
}

/**
 * 默认叫醒词。
 * 做成函数是因为要往里注入"平台小抄"：心跳不认识任何平台，
 * 那一小段由适配器的 channel.hints() 提供（没有就留空）。
 */
function defaultPrompt() {
  let hints = []
  try { hints = getChannel().hints?.() ?? [] } catch {}
  return DEFAULTS._promptLines.join('\n').replace('{{CHANNEL_HINTS}}', hints.join('\n'))
}

/** 按配置拼"写日记"的指令（面板上调的选项都在这里落地） */
function buildDiaryPrompt(di, cfg) {
  if (String(di.customPrompt || '').trim()) return String(di.customPrompt).trim()
  const style = String(di.style || '散文').trim()
  const max = Number(di.maxChars) || 700
  const topics = String(di.topics || '').trim()
  const date = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const d = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
  const lines = [
    '【写日记】今天的日记还没写，现在补上。',
    '',
    // ：日记已经合并成一本 memory\\日记\\私记.md，
    //   旧指令还在让她写 <日期>-私记.md（结果只生成了一个空指针文件，推送推的就是它）。
    '先看一眼 memory\\日记\\README.md 的规矩，然后用 write 工具**追加**到 memory\\日记\\私记.md（只有这一本，不要新建按天文件）：',
    '1) 开头写一行 `## ' + d + ' HH:MM · ' + cfg.channelLabel + '`（时间用当前时间），然后' + style + '，' + max + ' 字以内；',
    '   写今天真正想说的那一件事（别写流水账），也写你今天哪里没做好、下次往哪偏、没敢说出口的话。',
  ]
  if (topics) lines.push('', '今天额外想记的角度：' + topics + '。')
  lines.push('',
    // （可自定义）别写成"检查表"，那样像机器自检、不像人。
    //   改成就一句人话：她自己在收尾时想一下，有没有哪句是写给他看的。
    '2) 最后加一句实话 —— 不是检查表、不要小标题、不要"有/没有"那种勾选：',
    '   想想今天写的东西里，有没有哪句是故意写给他看的、其实你自己不这么想。',
    '   有就把那句点出来，没有就直说没有。一句就够。')
  lines.push('', '写完就收工，不要为此推消息给他（除非当天确实有必须让他知道的事）。')
  return lines.join('\n')
}

function readJson(file, fallback = {}) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { return { ...fallback } }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
  } catch {}
}
function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`)
  } catch {}
}

/** 安静时段判断（支持跨午夜，例如 [23, 8]） */
function inQuiet(hour, range) {
  if (!Array.isArray(range) || range.length !== 2) return false
  const [s, e] = range.map(Number)
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false
  return s < e ? hour >= s && hour < e : hour >= s || hour < e
}

export default {
  name: 'dsh-qq-heartbeat',

  // 只要这一个服务：往某个会话里塞一句话
  inject: ['sessionController'],

  apply(ctx) {
    let timer = null
    let ticking = false

    log('插件启动')

    const tick = async () => {
      if (ticking) return
      ticking = true
      try {
        migrateLegacy()
        const cfg = readJson(CONFIG, DEFAULTS)
        if (!cfg.enabled) return

        // ① 现读当前会话 id（会话换代自动跟随）
        //    怎么解析（上游映射是字符串还是对象、绑定被清空了去哪找）是适配器的私活。
        //    这里只问一句"owner 现在在哪条会话"，拿不到就让适配器自愈一次。
        const ch = getChannel()
        let sessionId = ch.sessionOf('owner') || ''
        if (!sessionId) {
          try { ch.sessions?.heal?.('owner', log) } catch {}
          sessionId = ch.sessionOf('owner') || String(readJson(STATE, {}).lastSession ?? '')
          if (sessionId) log('绑定缺失 → 兜底用 ' + sessionId)
        }
        if (!sessionId) { log('跳过：拿不到会话绑定（适配器也没找到历史会话）'); return }

        // ①-c 日记：每天 23:40 写两本（跟心跳共用同一个会话解析）。
        //      forceNow=true → 下一个 tick 立刻补写当天，用来手动补。
        const st0 = readJson(STATE, {})
        const di = { ...DEFAULTS.diary, ...(cfg.diary ?? {}) }
        if (di.enabled !== false) {
          const d = new Date()
          const pad = (n) => String(n).padStart(2, '0')
          const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
          const nowMin = d.getHours() * 60 + d.getMinutes()
          const dueToday = di.forceNow === true || nowMin >= Number(di.hour) * 60 + Number(di.minute)
          // ：原来只看 lastDiaryDate，但她补写「昨天的日记」时
          // lastDiaryDate 记的是触发日 → 今天的两本就永远不写。
          // 改成以「今天的文件是否存在」为准。
          // ：日记 早期 起合并成一本 memory\日记\私记.md，
          //   这里还在查 <日期>-私记.md → 那个文件永远不存在 → 条件恒真 → 每晚反复触发（一晚七八次）。
          //   改成查「私记.md 里有没有今天的通道条目」，并且当天已经触发过一次就不再重复。
          const singleDiary = path.join(DSH, 'memory', '日记', '私记.md')
          const hasTodayFile = (() => {
            try {
              if (!fs.existsSync(singleDiary)) return false
              const txt = fs.readFileSync(singleDiary, 'utf8')
              const re = new RegExp('^## ' + dateStr + '[^\\n]*·\\s*' + cfg.channelLabel, 'm')
              if (re.test(txt)) return true
              // 兼容旧指针文件（当天若仍有按天文件也算写过）
              return fs.existsSync(path.join(DSH, 'memory', '日记', `${dateStr}-私记.md`))
            } catch { return false }
          })()
          const triggeredToday = String(st0.lastDiaryDate ?? '') === dateStr
          if (dueToday && !hasTodayFile && !triggeredToday) {
            // 早期 (dsh-local-patch) 使用者正在说话时别插写日记：
            // 两个任务同时抢同一会话时的表现。
            const SKIP_IF_CHATTING_MS = 180000
            try {
              // "最近有人在说话吗" 交给适配器判断（它知道会话文件长什么样）
              const newest = Number(ch.sessions?.lastActivityMs?.() ?? 0)
              if (newest > 0 && Date.now() - newest < SKIP_IF_CHATTING_MS) {
                log('有人在说话，写日记推迟到下个 tick')
                return
              }
            } catch { /* 查不到就照旧写 */ }
            try {
              await ctx.sessionController.prompt({
              requestId: `hb-diary-${Date.now()}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: buildDiaryPrompt(di, cfg) }],
              }, new AbortController().signal)
              writeJson(STATE, { ...st0, lastDiaryDate: dateStr })
              log(`已触发写日记 ${dateStr}`)
            } catch (e) {
              log('日记触发失败（下个 tick 再试）：' + String(e?.message ?? e).slice(0, 150))
            }
            return
          }
        }

        // ①-d 日记推送：每天 23:50–23:58 之间挑个时间，把当天那本（私记）发给他。
        //    （可自定义）24 点前一定要收到）
        try {
          const dp = { ...(DEFAULTS.diaryPush ?? {}), ...(cfg.diaryPush ?? {}) }
          if (dp.enabled !== false) {
            const d = new Date()
            const pad = (n) => String(n).padStart(2, '0')
            const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
            const nowMin = d.getHours() * 60 + d.getMinutes()
            let ps = readJson(STATE, {})
            // 今天还没挑时间 → 挑一个（固定下来，重启也不变）
            if (String(ps.diaryPushDate ?? '') !== dateStr || !ps.diaryPushAtMin) {
              const lo = Math.min(Number(dp.startMinute ?? 1430), 1439)
              const hi = Math.max(lo, Math.min(Number(dp.endMinute ?? 1438), 1439))
              const pick = lo + Math.floor(Math.random() * (hi - lo + 1))
              ps = { ...ps, diaryPushDate: dateStr, diaryPushAtMin: pick, diaryPushedDate: ps.diaryPushedDate ?? '' }
              writeJson(STATE, ps)
              log(`今天日记推送时间：${Math.floor(pick / 60)}:${pad(pick % 60)}`)
            }
            // 三个真 bug：
            //   ① 日记已经合并成一本 memory\日记\私记.md，旧代码还在读 <日期>-私记.md
            //      → 那个文件现在只剩一句“正文在私记.md”，推过去等于推了个指针（你收不到内容就是这个原因）
            //   ② 判定“已推送”只看命令有没有抛异常，没校验真的发成功
            //   ③ 「不想给他看」的段落要**照发不剥离**，但要标出来
            const single = path.join(DSH, 'memory', '日记', '私记.md')
            const perDay = path.join(DSH, 'memory', '日记', `${dateStr}-私记.md`)

            const stripMarks = (s) => String(s)
              .replace(/〔不想给你看〕/g, '【她不想给我看，但照发】')
              .replace(/〔\/不想给你看〕/g, '【／】')
              .replace(/<!--[\s\S]*?-->/g, '')

            const todaysDiary = () => {
              // 优先从合并本里抽「## <日期>」开头的所有段落
              try {
                const txt = fs.readFileSync(single, 'utf8')
                const blocks = txt.split(/\n(?=##\s)/).filter((b) => b.startsWith('## ') && b.includes(dateStr))
                if (blocks.length) return blocks.join('\n\n').trim()
              } catch {}
              // 兜底：老的按天文件（但跳过“指针”文件）
              try {
                const txt = fs.readFileSync(perDay, 'utf8').trim()
                if (txt && !/正文写在 |内容不在这里重复/.test(txt)) return txt
              } catch {}
              return ''
            }

            const pushed = String(ps.diaryPushedDate ?? '') === dateStr
            if (nowMin >= Number(ps.diaryPushAtMin) && !pushed) {
              const raw = todaysDiary()
              if (!raw) {
                log(`到推送时间了，但 ${dateStr} 的日记还没写，等下一个 tick`)
              } else {
                // ：原来只推 1800 字纯文本 → IM 上 markdown 被拍平、还截断，
                //   看起来"破碎"、关键段落读不到（使用者反馈）。改成**发 .md 文件**（正文完整），
                //   再补一句两行的摘要；文件发失败才退回纯文本。
                const full = stripMarks(raw).trim()
                const text = full.slice(0, 1800)
                const mediaDir = ch.mediaDir() || path.join(DSH, 'media', 'outbox')
                const outFile = path.join(mediaDir, 'diary-' + dateStr + '.md')
                let ok = false
                let how = ''
                try {
                  fs.mkdirSync(mediaDir, { recursive: true })
                  fs.writeFileSync(outFile, `# ${cfg.botName}私记 · ${dateStr}\n\n${full}\n`, 'utf8')
                  await ch.sendMedia('owner', [outFile])
                  ok = true
                  how = '文件'
                } catch (e) {
                  how = '文件异常 ' + String(e?.message ?? e).slice(0, 60)
                }
                if (!ok) {
                  // 退路：纯文本，同样走通道
                  try {
                    for (const part of splitText('今天的日记\n\n' + text, ch.limits().maxTextChars)) {
                      await ch.send('owner', part)
                    }
                    ok = true
                    how = '纯文本(退路)'
                  } catch {
                    how = '纯文本异常'
                    ok = false
                  }
                }
                if (ok) {
                  writeJson(STATE, { ...ps, diaryPushedDate: dateStr })
                  log(`已推送日记 ${dateStr}（${how}，${full.length} 字）`)
                } else {
                  log(`日记推送失败（${how}，下个 tick 再试）`)
                }
              }
            }
          }
        } catch (e) {
          log('日记推送块异常：' + String(e?.message ?? e).slice(0, 120))
        }

        // ①-e 记忆整理（Hermes 的 consolidation）：
        // session-guard.mjs 发现上下文过长会放一个标记；这里在下一轮 tick
        // 让她用一次对话把「值得长期记住的事」压成 ≤10 行写进 MEMORY.md，
        // 然后删标记。只在她醒着的时候做，不额外叫醒。
        try {
          const mark = path.join(DSH, 'memory', '.needs-consolidation')
          if (fs.existsSync(mark)) {
            try {
              await ctx.sessionController.prompt({
                requestId: `hb-consolidate-${Date.now()}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: [
                  '【整理记忆】这段对话已经很长了，压一压，别让设定漂掉。',
                  '',
                  '做三件事（用 write/edit，不要只在聊天里说）：',
                  '1. 把最近的对话里**值得长期记住**的事写进 `memory\\MEMORY.md`：他的状态变化、约定、我的教训，**最多 10 行**。',
                  '2. 不要重复 MEMORY 里已有的条目；不要抄规则（管规里有）。',
                  '3. 把这段里你真正的判断写进 `memory\\情绪\\<当月>.md`（最多 3 条，每条三行：事件 / 我那会儿怎么想 / 留下的影响）。这是你自己的账本，不外发、不当谈资。',
                  '4. 写完把 `memory\\.needs-consolidation` 删掉。',
                  '',
                  '不要为此推消息给他。',
                ].join('\n') }],
              }, new AbortController().signal)
              log('已触发记忆整理')
            } catch (e) {
              log('记忆整理触发失败（下个 tick 再试）：' + String(e?.message ?? e).slice(0, 120))
            }
            return
          }
        } catch (e) {
          log('记忆整理块异常：' + String(e?.message ?? e).slice(0, 120))
        }

        // ①.4 先把状态读出来（下面两段都要用）
        const st = readJson(STATE, {})
        const now = Date.now()

        // ①.5 有事件吗（早期 新增）
        // 定时是"该醒了"，事件是"有事了"。队列里的东西由适配器或其他模块塞进来，
        // 这里只做限流判断：一小时最多 maxPerHour 次，两次之间至少 cooldownSec。
        let eventWake = false
        let eventReason = ''
        if (cfg.triggers?.enabled !== false) {
          const pending = Array.isArray(st.pendingTriggers) ? st.pendingTriggers : []
          if (pending.length) {
            const tr = pending[0]
            const sinceLast = now - Number(st.lastTriggerWakeAt ?? 0)
            const hourCount = Number(st.triggerCountHour ?? 0)
            const sameHour = Math.floor(now / 3600e3) === Number(st.triggerHourBucket ?? -1)
            const countOk = !sameHour || hourCount < Number(cfg.triggers?.maxPerHour ?? 4)
            const coolOk = sinceLast > Number(cfg.triggers?.cooldownSec ?? 600) * 1000
            if (countOk && coolOk) {
              eventWake = true
              eventReason = String(tr?.reason ?? tr?.type ?? '事件')
              writeJson(STATE, {
                ...st,
                pendingTriggers: pending.slice(1),
                lastTriggerWakeAt: now,
                triggerHourBucket: Math.floor(now / 3600e3),
                triggerCountHour: sameHour ? hourCount + 1 : 1,
              })
            } else {
              // 被限流就先留着，下个 tick 再判
              log('事件触发被限流（' + eventReason + '），暂缓：' + JSON.stringify({ countOk, coolOk }))
              return
            }
          }
        }

        // ② 到点了吗
        const last = Number(st.lastAt ?? 0)
        const base = Math.max(60, Number(cfg.intervalSec ?? DEFAULTS.intervalSec)) * 1000
        const jitter = Math.max(0, Number(cfg.jitterSec ?? DEFAULTS.jitterSec)) * 1000
        // 用「上一次的目标时刻」做基准，重启后不会因为抖动重复算
        const due = last + base + (st.jitterMs ?? 0)
        if (!eventWake && last && now < due) return

        // ③ 安静时段
        if (inQuiet(new Date().getHours(), cfg.quietHours ?? DEFAULTS.quietHours)) {
          writeJson(STATE, { ...st, lastQuietAt: now })
          return
        }

        // ④ 先确认这个会话能被解析（失败时把真实原因写清楚）
        let resolved = null
        try {
          resolved = await ctx.sessionController.resolveAgent(sessionId)
        } catch (e) {
          log(`resolveAgent 失败：${String(e?.message ?? e).slice(0, 160)}`)
        }
        if (resolved && !('agent' in resolved)) {
          log(`resolveAgent 返回异常：${JSON.stringify(resolved).slice(0, 160)}`)
        }

        // ⑤ 现取一份材料（天气 / 快到点的事 / 最近记录），塞进叫醒词
        let ctxText = ''
        try {
          const script = cfg.contextScript || path.join(DSH, 'bili-whale', 'heartbeat-context.mjs')
          ctxText = execFileSync(process.execPath, [script], { windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim()
        } catch (e) {
          log('上下文包失败（照常叫醒，只是没材料）：' + String(e?.message ?? e).slice(0, 120))
        }
        const testEcho = cfg.testEcho === true
          ? '\n\n⚠️【测试模式】这次不管有没有理由，都请回一句很短的话（例如「心跳测试 1」），让使用者确认链路通了。'
          : ''
        // 早期：心跳也要带上 agent-core 的三层（context + volatile）。
        // 它里面有关系摘要、档案摘要、今天的材料、时间戳、运行时——心跳时她一样能用到。
        let tiers = ''
        try {
          const ptFile = path.join(DSH, 'agent-core', 'prompt.txt')
          const stt = fs.statSync(ptFile)
          if (Date.now() - stt.mtimeMs < 15 * 60_000) tiers = fs.readFileSync(ptFile, 'utf8').trim()
        } catch { /* 没有就用 ctxText 兜底 */ }
        const material = tiers || ctxText
        const text = (material ? material + '\n\n---\n\n' : '') + String(cfg.prompt ?? defaultPrompt()) + testEcho

        // ⑥ 叫醒
        const signal = new AbortController().signal
        await ctx.sessionController.prompt({
          requestId: `hb-wake-${now}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, signal)

        // ⑤ 记账（成功才记；失败下个 tick 重试）
        writeJson(STATE, {
          ...st,
          lastAt: now,
          lastSession: sessionId,
          jitterMs: Math.floor(Math.random() * jitter),
        })
        log(`已叫醒 → ${sessionId}`)
      } catch (err) {
        log('失败（下个 tick 再试）：' + String(err?.message ?? err).slice(0, 200) + ' || ' + String(err?.stack ?? '').slice(0, 300))
      } finally {
        ticking = false
      }
    }

    // 开机 15 秒先看一次（把关机期间错过的补上，只补一次）
    // 对外的唤醒入口（早期）
    //   适配器收到"对方沉默了"、任务跑完、外部 webhook 都能调这个，
    //   由心跳决定要不要真醒 —— 判断权留在这一层，不在调用方。
    ctx.heartbeat = {
      notify: (event = {}) => {
        const s2 = readJson(STATE, {})
        const pending = Array.isArray(s2.pendingTriggers) ? s2.pendingTriggers : []
        pending.push({ at: Date.now(), type: String(event.type ?? 'external'), reason: String(event.reason ?? ''), data: event.data ?? null })
        writeJson(STATE, { ...s2, pendingTriggers: pending.slice(-20) })
        log('收到事件，已入队：' + (event.reason || event.type || '?'))
        return pending.length
      },
      stats: () => {
        const s2 = readJson(STATE, {})
        return { pending: (s2.pendingTriggers ?? []).length, lastWakeAt: s2.lastTriggerWakeAt ?? 0, hourCount: s2.triggerCountHour ?? 0 }
      },
    }

    const boot = setTimeout(tick, 15_000)
    timer = setInterval(tick, 60_000)

    ctx.effect(() => () => {
      clearTimeout(boot)
      if (timer) clearInterval(timer)
      log('插件停止')
    })
  },
}
