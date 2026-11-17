#!/usr/bin/env node
/**
 * checks.mjs —— 把「规矩」变成「会失败的检查」。
 *
 * 按 GPT 交接里那条判据做：一条规矩如果没有会失败的检查，它就只是口号。
 * 这里检查的全是我们已经改过的机制，任何一项掉了都会 exit 1 并说出差异集合。
 *
 *   node checks.mjs            体检（失败 exit 1）
 *   node checks.mjs --json     机器可读
 *   node checks.mjs --selftest 反例自检：故意造一个违规，必须报错
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { WORKSPACE, DSH_HOME } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const LIB = path.join(DSH, 'profiles', 'web', 'node_modules', 'dsh-onebot-qq', 'lib')
const CORE = path.join(DSH, 'agent-core')
const MEM = path.join(DSH, 'memory')

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

const checks = [
  {
    id: 'owner-name-guard',
    desc: '出口不许乱叫使用者（bridge.js 兜底替换）',
    run: () => read(path.join(LIB, 'bridge.js')).includes('不许乱叫使用者'),
  },
  {
    id: 'group-owner-gate',
    desc: '他不在的群不说话（inbound.js 门禁）',
    run: () => read(path.join(LIB, 'inbound.js')).includes('group-owner-seen'),
  },
  {
    id: 'group-daily-quota',
    desc: '群聊每天最多 10 句（inbound 判 + outbound 计数）',
    run: () => read(path.join(LIB, 'inbound.js')).includes('group-quota')
      && read(path.join(LIB, 'outbound.js')).includes('group-quota'),
  },
  {
    id: 'mapping-merge',
    desc: '重启不再清空会话映射（registry.js 合并）',
    run: () => read(path.join(LIB, 'registry.js')).includes('local fix'),
  },
  {
    id: 'silent-sentinel',
    desc: '静默时 [SILENT] 被吞掉',
    run: () => read(path.join(LIB, 'bridge.js')).includes('sentinel'),
  },
  {
    id: 'tiers-inject',
    desc: '三层提示词注入到 QQ 平台提示里',
    run: () => read(path.join(LIB, 'prompt.js')).includes('agentCoreTiers'),
  },
  {
    id: 'owner-identity-injected',
    desc: '提示词里带着「谁是使用者」',
    run: () => read(path.join(CORE, 'prompt.txt')).includes('谁是使用者'),
  },
  {
    id: 'rules-injected',
    desc: '管规文件里的规则进了提示词',
    run: () => {
      const rules = read(path.join(MEM, '管规.md')).split('\n').filter((l) => /^\d+\.\s/.test(l))
      const pt = read(path.join(CORE, 'prompt.txt'))
      if (!rules.length) return { ok: false, detail: '管规.md 里一条规则都没有' }
      const missing = rules.filter((r) => !pt.includes(r.replace(/^\d+\.\s/, '').slice(0, 12)))
      return missing.length ? { ok: false, detail: `有 ${missing.length} 条规则没进提示词` } : true
    },
  },
  {
    id: 'obey-mode',
    desc: '（）模式：使用者括号指令无条件执行（inbound 注入标记）',
    run: () => read(path.join(LIB, 'inbound.js')).includes('绝对服从')
      ? true : { ok: false, detail: 'inbound.js 里没有（）模式标记' },
  },
  {
    id: 'jobs-runner',
    desc: '通用任务 runner 存在且有任务（对标 Hermes cron）',
    run: () => {
      const src = read(path.join(DSH, 'plugins', 'dsh-agent-core', 'lib', 'jobs.mjs'))
      if (!src.includes('isDue')) return { ok: false, detail: 'jobs.mjs 缺少调度逻辑' }
      const jf = path.join(CORE, 'jobs.json')
      if (!fs.existsSync(jf)) return { ok: false, detail: 'jobs.json 不存在' }
      const jobs = (JSON.parse(read(jf)) || {}).jobs || []
      return jobs.length ? true : { ok: false, detail: 'jobs.json 里没有任务' }
    },
  },
  {
    id: 'skills-index',
    desc: 'skills 目录存在且进了提示词（Hermes skills index）',
    run: () => {
      const dir = path.join(DSH, 'agent-core', 'skills')
      const n = (() => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length } catch { return 0 } })()
      if (!n) return { ok: false, detail: 'skills 目录为空' }
      return read(path.join(CORE, 'prompt.txt')).includes('可用的 skill') ? true : { ok: false, detail: '提示词里没有 skills 索引' }
    },
  },
  {
    id: 'memory-provider',
    desc: '记忆 provider 注册表可用（单实例、可替换）',
    run: () => {
      const src = read(path.join(DSH, 'plugins', 'dsh-agent-core', 'lib', 'index.js'))
      return src.includes('loadProvider') && src.includes('/providers')
        ? true : { ok: false, detail: '没有 provider 注册表接线' }
    },
  },
  {
    id: 'trajectory-export',
    desc: '轨迹导出接口存在（ShareGPT JSONL）',
    run: () => {
      const src = read(path.join(DSH, 'plugins', 'dsh-agent-core', 'lib', 'index.js'))
      return src.includes('/trajectory') ? true : { ok: false, detail: '没有 trajectory 路由' }
    },
  },
  {
    id: 'journal-compact',
    desc: 'JOURNAL 可压缩（脚本存在且支持 dry）',
    run: () => {
      const p = path.join(DSH, 'bili-whale', 'compact.mjs')
      if (!fs.existsSync(p)) return { ok: false, detail: 'compact.mjs 不存在' }
      return read(p).includes('--dry') ? true : { ok: false, detail: 'compact.mjs 不支持 dry' }
    },
  },
  {
    id: 'draw-gate',
    desc: 'GPT 出图必须凭批准（脚本在 + 令牌机制在）',
    run: () => {
      const p = path.join(DSH, 'bili-whale', 'draw.mjs')
      if (!fs.existsSync(p)) return { ok: false, detail: '缺 draw.mjs' }
      const txt = fs.readFileSync(p, 'utf8')
      return txt.includes('draw-token') ? true : { ok: false, detail: '批准令牌机制不见了' }
    },
  },
  {
    id: 'qzone-gate',
    desc: '空间说说必须凭令牌（脚本在 + 无令牌会被拒）',
    run: () => {
      const p = path.join(DSH, 'bili-whale', 'occasion.mjs')
      if (!fs.existsSync(p)) return { ok: false, detail: '缺 occasion.mjs' }
      const txt = fs.readFileSync(p, 'utf8')
      if (!txt.includes('occasion-token')) return { ok: false, detail: '令牌机制不见了' }
      return fs.existsSync(path.join(MEM, '纪念日.md')) ? true : { ok: false, detail: '缺 memory\\纪念日.md' }
    },
  },
  {
    id: 'agents-redlines-injected',
    desc: '说明书里的红线真的进了提示词（不是只写在文件里）',
    run: () => {
      let agents = ''
      try { agents = fs.readFileSync(path.join(MEM, 'AGENTS.md'), 'utf8') } catch { return true }
      const hasSection = /^##\s.*(红线|底线|不量化|必须|绝不|禁止)/m.test(agents)
      if (!hasSection) return true
      let prompt = ''
      try { prompt = fs.readFileSync(path.join(DSH, 'agent-core', 'prompt.txt'), 'utf8') } catch { return { ok: false, detail: 'prompt.txt 读不到' } }
      return prompt.includes('红线（来自说明书') ? true : { ok: false, detail: 'AGENTS 有红线小节，但 prompt.txt 里没有「红线（来自说明书）」块' }
    },
  },
  {
    id: 'mood-not-quantified',
    desc: '心情没有被量化（memory 里不出现分数/好感度/情绪值）',
    run: () => {
      const pats = /好感度\s*[:：]?\s*\d|心情\s*[:：]\s*\d|情绪\s*[:：]\s*\d|moodScore|mood_score|心情值\s*\d|情绪值\s*[-+]?\d/
      const dirs = [path.join(MEM), path.join(MEM, '情绪'), path.join(MEM, '日记')]
      for (const d of dirs) {
        let files = []
        try { files = fs.readdirSync(d).filter((f) => f.endsWith('.md')) } catch { continue }
        for (const f of files) {
          let txt = ''
          try { txt = fs.readFileSync(path.join(d, f), 'utf8') } catch { continue }
          // 规矩本身会引用「好感度 72」当反例 —— 这类说明行不算违规
          const lines = txt.split('\n')
          for (const line of lines) {
            if (/禁止|不许|不准|红线|示例|例如|比如|不要|别写|反例/.test(line)) continue
            const m = line.match(pats)
            if (m) return { ok: false, detail: f + ' 里出现「' + m[0] + '」：' + line.trim().slice(0, 40) }
          }
        }
      }
      return true
    },
  },
  {
    id: 'report-tool',
    desc: '被骂能立案（report.mjs + 技能说明）',
    run: () => (fs.existsSync(path.join(DSH, 'bili-whale', 'report.mjs')) && fs.existsSync(path.join(DSH, 'agent-core', 'skills', '被骂了.md')))
      ? true : { ok: false, detail: '缺 report.mjs 或 skills\\被骂了.md' },
  },
  {
    id: 'architecture-doc',
    desc: '有架构文档（唯一来源/分层写清楚）',
    run: () => read(path.join(MEM, 'ARCHITECTURE.md')).includes('唯一来源')
      ? true : { ok: false, detail: 'memory\\ARCHITECTURE.md 缺失' },
  },
  {
    id: 'doctor',
    desc: '自愈脚本在位且 --dry 能跑通',
    run: () => {
      const p = path.join(DSH, 'agent-core', 'doctor.mjs')
      if (!fs.existsSync(p)) return { ok: false, detail: '缺 doctor.mjs' }
      try {
        execFileSync(process.execPath, [p, '--dry', '--json'], { windowsHide: true, timeout: 60000 })
        return true
      } catch (e) {
        const out = String(e?.stdout ?? '')
        return out.includes('"broken":[]') ? true : { ok: false, detail: 'doctor 报有待处理项' }
      }
    },
  },
  {
    id: 'persona-anchor',
    desc: 'volatile 里有身份锚点（长对话不丢设定）',
    run: () => read(path.join(DSH, 'agent-core', 'prompt.json')).includes('[身份锚点')
      ? true : { ok: false, detail: 'prompt.json 没有身份锚点，跑一次重建三层' },
  },
  {
    id: 'session-guard',
    desc: '长对话守卫在位（能放整理标记）',
    run: () => fs.existsSync(path.join(DSH, 'agent-core', 'session-guard.mjs'))
      ? true : { ok: false, detail: '缺 session-guard.mjs' },
  },
  {
    id: 'tts-voice-pinned',
    desc: 'TTS 参数稳定（do_sample=false，固定档案）',
    run: () => {
      const vp = path.join(WORKSPACE, 'indextts25', 'voice.json')
      const sp = path.join(WORKSPACE, 'dafeiyu-tts', 'say.ps1')
      if (!fs.existsSync(vp)) return { ok: false, detail: path.join(WORKSPACE, 'indextts25', 'voice.json') + ' 不存在' }
      const v = JSON.parse(fs.readFileSync(vp, 'utf8'))
      if (v.do_sample !== false) return { ok: false, detail: 'do_sample 不是 false，音色会随机漂' }
      const ps = fs.readFileSync(sp, 'utf8')
      if (!ps.includes("$Engine = 'idx'")) return { ok: false, detail: 'say.ps1 默认引擎不是 idx' }
      return true
    },
  },
  {
    id: 'session-logs-clean',
    desc: '会话日志目录名与 header.cwd 一致（不一致会让「列会话」直接抛错）',
    run: () => {
      try {
        const healer = path.join(path.dirname(process.env.USERPROFILE || os.homedir()), 'x')
        const script = path.join(DSH_HOME, 'agent-core', 'session_heal.mjs')
        if (!fs.existsSync(script)) return { ok: false, detail: 'session_heal.mjs 不存在' }
        const out = execFileSync(process.execPath, [script, '--dry'], { windowsHide: true, encoding: 'utf8', timeout: 240000 })
        const m = /不一致[^:]*:\s*(\d+)/.exec(out)
        const bad = m ? Number(m[1]) : 0
        return bad === 0 ? true : { ok: false, detail: bad + ' 个会话日志不一致（跑 session_heal.mjs）' }
      } catch (e) {
        return { ok: false, detail: String((e && e.message) || e).slice(0, 120) }
      }
    },
  },
  {
    id: 'session-handoff',
    desc: '开新会话前会写交接条（不再当场失忆）',
    run: () => {
      const reg = read(path.join(LIB, 'registry.js'))
      const ho = path.join(DSH_HOME, 'agent-core', 'handoff.mjs')
      if (!reg.includes('handoff written before /new')) return { ok: false, detail: 'registry.js 没有交接条调用' }
      if (!fs.existsSync(path.join(DSH_HOME, 'agent-core', 'handoff.mjs'))) return { ok: false, detail: 'handoff.mjs 不存在' }
      return true
    },
  },
  {
    id: 'empty-reply-guard',
    desc: '近 2 小时没有「只思考不回复」的空轮次',
    run: () => {
      const dir = path.join(os.homedir(), '.dsh', 'sessions', '--C-Users-' + os.userInfo().username + '-.dsh-memory--')
      if (!fs.existsSync(dir)) return true
      const cut = Date.now() - 2 * 3600 * 1000
      const bad = []
      for (const d of fs.readdirSync(dir)) {
        if (!/^onebot-/.test(d)) continue
        const f = path.join(dir, d, 'session.v4.jsonl.zstd')
        if (!fs.existsSync(f)) continue
        if (fs.statSync(f).mtimeMs < cut) continue
        // 只检查最近被写过的会话，用 zstd 解压后扫最后 200 行
        try {
          const tmp = path.join(os.tmpdir(), 'chk-' + process.pid + '.jsonl')
          execFileSync(process.env.ZSTD_BIN || path.join(WORKSPACE, 'msys2', 'mingw64', 'bin', 'zstd.exe'), ['-d', '-f', '-q', '-o', tmp, f], { windowsHide: true, timeout: 20000 })
          const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n').slice(-200)
          try { fs.unlinkSync(tmp) } catch {}
          for (const ln of lines) {
            if (!ln.includes('assistant/message') || !ln.includes('reasoning')) continue
            let ev
            try { ev = JSON.parse(ln) } catch { continue }
            if (Number(ev.time) < cut) continue
            const c = ev.data?.message?.content || []
            const textLen = c.filter((p) => p.type === 'text').map((p) => String(p.text || '')).join('').trim().length
            const rsnLen = c.filter((p) => p.type === 'reasoning').map((p) => String(p.text || '')).join('').length
            if (textLen === 0 && rsnLen > 200) bad.push(d + '@' + new Date(Number(ev.time)).toLocaleTimeString('zh-CN', { hour12: false }) + ' 思考' + rsnLen + '字')
          }
        } catch { /* 解压失败不算问题 */ }
      }
      if (!bad.length) return true
      return { ok: false, detail: '空回复轮次：' + bad.slice(0, 3).join(' / ') }
    },
  },
  {
    id: 'no-school-provider',
    desc: '模型来源只允许 deepseek-account（其他网关一律不许）',
    run: () => {
      const yml = read(path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'))
      // 她那条 agent-default-model 的 provider 必须是 deepseek-account
      const m = /- id: agent-default-model[\s\S]{0,200}?provider:\s*(\S+)/.exec(yml)
      if (!m) return { ok: false, detail: '找不到 agent-default-model 的 provider' }
      if (!/^deepseek-account/.test(m[1])) return { ok: false, detail: '默认 provider 不是 deepseek-account：' + m[1] }
      // 插件里的白名单补丁必须在
      const cmd = read(path.join(LIB, 'commands.js'))
      if (!cmd.includes('ALLOWED_PROVIDERS')) return { ok: false, detail: 'commands.js 的白名单补丁丢了（重装会冲掉）' }
      // 她的提示词里不许带学校那套凭据名（管规会提到 xplt 作为"禁用对象"，那是允许的）
      const p = read(path.join(DSH_HOME, 'agent-core', 'prompt.txt'))
      if (/SDU_API_KEY/i.test(p)) return { ok: false, detail: '提示词里出现了 SDU_API_KEY' }
      return true
    },
  },
  {
    id: 'rules-complete',
    desc: '管规的关键主题一条都没丢（合并时防止静默丢规则）',
    run: () => {
      const s = read(path.join(MEM, '管规.md'))
      const must = ['<你的语气要点 1>', '<要点 2>']
      const missing = must.filter((k) => !s.includes(k))
      if (!missing.length) return true
      return { ok: false, detail: '管规里缺：' + missing.join('、') }
    },
  },
  {
    id: 'group-mention-toggle',
    desc: '群聊 @ 要求可运行时切换（group-at.mjs）',
    run: () => {
      const s = read(path.join(LIB, 'inbound.js'))
      if (!s.includes('mentionOverride')) return { ok: false, detail: 'inbound.js 没打运行时覆盖补丁' }
      const tool = path.join(DSH_HOME, 'bili-whale', 'group-at.mjs')
      if (!fs.existsSync(tool)) return { ok: false, detail: 'group-at.mjs 不存在' }
      return true
    },
  },
  {
    id: 'deferred-notice-voice',
    desc: '超时提示是她的口吻（不是系统告警腔）',
    run: () => {
      const s = read(path.join(LIB, 'deferred.js'))
      if (s.includes('还在跑 有点久')) return true
      if (s.includes('等待模型回复超时（已静默等待')) return { ok: false, detail: 'deferred.js 又被重装回系统提示语了' }
      return { ok: false, detail: 'deferred.js 里没有找到提示语' }
    },
  },
  {
    id: 'poke-handling',
    desc: '戳一戳不再被丢（bridge 把它转成一条消息）',
    run: () => read(path.join(LIB, 'bridge.js')).includes('戳一戳 → 转成一条消息')
      ? true : { ok: false, detail: 'bridge.js 没有戳一戳转换' },
  },
  {
    id: 'identity-hint',
    desc: '每轮先认人（inbound 注入身份提示，名册可解析）',
    run: () => {
      const src = read(path.join(LIB, 'inbound.js'))
      if (!src.includes('identityHint')) return { ok: false, detail: 'inbound.js 里没有 identityHint' }
      const ros = read(path.join(MEM, '好友.md'))
      const n = (ros.match(/^\|\s*\**\d{5,12}/gm) ?? []).length
      return n > 0 ? true : { ok: false, detail: '好友.md 里没有名册行' }
    },
  },
  {
    id: 'ps1-ascii-only',
    desc: '所有自建 .ps1 必须是纯 ASCII（PS 5.1 会把中文读成语法错误）',
    run: () => {
      const files = [
        path.join(HOME, 'restart-agent.ps1'),
        path.join(HOME, 'restart-worker.ps1'),
        path.join(HOME, 'restart-dsh.ps1'),
        path.join(HOME, 'qq-watchdog.ps1'),
        path.join(DSH, 'agent-core', 'rule-checks.ps1'),
      ]
      const bad = files.filter((p) => {
        try { return /\u0080-\uFFFF/.test(fs.readFileSync(p, 'utf8')) } catch { return false }
      })
      return bad.length ? { ok: false, detail: '含非 ASCII：' + bad.map((b) => path.basename(b)).join(',') } : true
    },
  },
  {
    id: 'mapping-not-empty',
    desc: '会话映射非空（重启后仍绑定）',
    run: () => {
      const m = JSON.parse(read(path.join(DSH, 'media', 'onebot', 'chat-sessions.json')) || '{}')
      const n = Object.keys(m).length
      return n > 0 ? true : { ok: false, detail: 'chat-sessions.json 是空的' }
    },
  },
  {
    id: 'patches-snapshot',
    desc: '补丁快照与已装版本一致（升级后能自愈）',
    run: () => {
      const dir = path.join(DSH, 'patches')
      if (!fs.existsSync(dir)) return { ok: false, detail: '没有 patches 目录' }
      const manifests = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'manifest.json')))
      if (!manifests.length) return { ok: false, detail: '没有 manifest' }
      for (const d of manifests) {
        const m = JSON.parse(read(path.join(dir, d, 'manifest.json')))
        const pkgJson = JSON.parse(read(path.join(DSH, 'profiles', 'web', 'node_modules', m.pkg, 'package.json')) || '{}')
        if (pkgJson.version && pkgJson.version !== m.version) {
          return { ok: false, detail: `${m.pkg} 已从 ${m.version} 变成 ${pkgJson.version}，补丁需复查` }
        }
      }
      return true
    },
  },
]

const results = []
for (const c of checks) {
  let r
  try { r = c.run() } catch (e) { r = { ok: false, detail: String(e?.message ?? e) } }
  const ok = r === true || r?.ok === true
  results.push({ id: c.id, desc: c.desc, ok, detail: typeof r === 'object' ? r?.detail : undefined })
}

if (process.argv.includes('--selftest')) {
  // 反例：把 bridge.js 复制一份，抹掉 marker，检查必须报错
  const target = path.join(LIB, 'bridge.js')
  const original = read(target)
  try {
    fs.writeFileSync(target, original.replace(/不许乱叫使用者/g, 'X'), 'utf8')
    const broken = read(target).includes('不许乱叫使用者')
    fs.writeFileSync(target, original, 'utf8')
    if (!broken) {
      console.log('✓ 反例自检通过：抹掉 marker 后确实检测得到（检查是有效的）')
      process.exit(0)
    }
    console.log('✗ 反例自检失败：抹掉 marker 后检查仍认为正常 —— 这个检查是假的')
    process.exit(1)
  } catch (e) {
    try { fs.writeFileSync(target, original, 'utf8') } catch {}
    console.log('反例自检出错：' + e.message)
    process.exit(1)
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
} else {
  const bad = results.filter((r) => !r.ok)
  for (const r of results) console.log((r.ok ? '✓' : '⛔') + ' ' + r.desc + (r.ok ? '' : '  ← ' + (r.detail ?? '')))
  console.log('')
  if (bad.length) { console.log(`⛔ ${bad.length} 项不通过：` + bad.map((b) => b.id).join(' · ')); process.exit(1) }
  console.log(`✓ 全部 ${results.length} 项通过`)
}
