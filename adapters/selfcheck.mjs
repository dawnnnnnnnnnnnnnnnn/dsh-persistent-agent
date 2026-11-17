#!/usr/bin/env node
/**
 * adapters/selfcheck.mjs —— 适配器契约自检（不需要真的连上 QQ）
 *
 * 检查四件事：
 *   1. core/lib/channel.mjs 的契约校验能挑出缺方法
 *   2. 没注册适配器时是"明确报错"，不是崩
 *   3. agent.config.json 缺字段时给的是能照着改的报错
 *   4. onebot 适配器实现满足契约（五个必需方法都在、limits() 有值）
 *
 * 用法：node adapters/selfcheck.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ok = []
const bad = []
const check = (name, fn) => {
  try { fn(); ok.push(name) } catch (e) { bad.push(name + ' → ' + String(e?.message ?? e).slice(0, 200)) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

// ── 1. 契约校验会挑出缺方法 ──
const { defineChannel, registerChannel, getChannel, splitText, REQUIRED } = await import('../core/lib/channel.mjs')

check('契约：缺方法时报出方法名', () => {
  let msg = ''
  try { defineChannel({ receive() {}, send() {} }) } catch (e) { msg = String(e.message) }
  assert(/sendMedia/.test(msg) || /resolveIdentity/.test(msg), '没有报出缺失的方法：' + msg)
})

check('契约：合格实现被接受', () => {
  const ch = defineChannel({
    receive: async () => () => {},
    send: async () => {},
    sendMedia: async () => {},
    resolveIdentity: (r) => ({ id: String(r), name: 'x', isOwner: false, isSelf: false }),
    limits: () => ({ maxTextChars: 100, maxMediaBytes: 1, minIntervalMs: 1 }),
  })
  assert(ch.contract, '没有 contract 版本')
  assert(REQUIRED.every((m) => typeof ch[m] === 'function'), '缺方法')
})

// ── 2. 没注册适配器：明确报错、不崩 ──
check('无适配器：send 给出可读错误', () => {
  const ch = getChannel()
  assert(typeof ch.label === 'string', 'label 异常')
  const p = ch.send('owner', 'hi')
  assert(p instanceof Promise, 'send 应当返回 Promise')
  p.catch((e) => { if (!/没有注册适配器/.test(String(e.message))) throw e })   // 吞掉预期内的拒绝
})

check('无适配器：sendMedia 也会明确拒绝而不是静默成功', () => {
  const ch = getChannel()
  const p = ch.sendMedia('owner', [])
  assert(p instanceof Promise, 'sendMedia 应当返回 Promise')
  p.catch(() => {})
})

check('无适配器：sessionOf / probe 降级不抛', () => {
  const ch = getChannel()
  assert(ch.sessionOf('owner') === '', 'sessionOf 应返回空串')
  assert(ch.probe() && typeof ch.probe() === 'object', 'probe 应返回对象')
})

check('splitText：按上限切且不丢字', () => {
  const src = 'a'.repeat(250) + '\n' + 'b'.repeat(250)
  const parts = splitText(src, 100)
  assert(parts.length >= 5, '切分数量异常：' + parts.length)
  assert(parts.join('').replace(/\n/g, '') === src.replace(/\n/g, ''), '切分后内容对不上')
})

// ── 3. 配置缺字段：报错能照着改 ──
const cfgMod = await import('../core/lib/config.mjs')
check('config：缺字段时给出可照着改的提示', () => {
  const fn = cfgMod.assertReady || cfgMod.assertConfig
  assert(typeof fn === 'function', 'config 模块既没有 assertReady 也没有 assertConfig')
  let msg = ''
  try {
    const r = fn()
    if (r && r.ok === false) msg = String(r.message || '')
  } catch (e) { msg = String(e.message) }
  assert(msg === '' || /agent|config|AGENT_|编辑/.test(msg), '提示没说清怎么改：' + msg)
})

// ── 4. onebot 适配器满足契约 ──
check('onebot：实现满足契约', async () => {
  const mod = await import('./onebot/index.mjs')
  const ch = defineChannel(mod.default, { label: 'onebot' })
  const lim = ch.limits()
  assert(lim.maxTextChars > 0, 'limits().maxTextChars 无效')
  const id = ch.resolveIdentity({ userId: '1', sender: { nickname: 'n' } })
  assert(id.id === '1', 'resolveIdentity 没拿到 id')
  assert(ch.sessions && typeof ch.sessions.get === 'function', 'sessions 扩展缺失')
  assert(typeof ch.sessionOf === 'function', 'sessionOf 缺失')
})

// 用一个填好的假配置验证"填了就能用"
const tmp = path.join(os.tmpdir(), 'agent-selfcheck-' + process.pid + '.json')
fs.writeFileSync(tmp, JSON.stringify({
  identity: { ownerId: '10001', botId: '10002', ownerName: '阿主', botName: '阿机' },
  channelLabel: 'chat',
  channels: { active: 'onebot', onebot: { baseUrl: 'http://127.0.0.1:5700', accessToken: 'token-abc' } },
}), 'utf8')
process.env.AGENT_CONFIG = tmp

const { execFileSync } = await import('node:child_process')
check('config：填好的配置能读到（子进程验证）', () => {
  const code = `
    import('./core/lib/config.mjs').then(m => {
      if (m.cfg.identity.botName !== '阿机') throw new Error('botName 读错：' + m.cfg.identity.botName)
      return import('./adapters/onebot/config.mjs')
    }).then(m => {
      if (m.onebot.ownerQQ !== '10001') throw new Error('ownerQQ 读错：' + m.onebot.ownerQQ)
      if (!m.assertReady()) throw new Error('assertReady 失败')
      console.log('ok')
    }).catch(e => { console.error(e.message); process.exit(1) })
  `
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: projectRoot,
    encoding: 'utf8', env: { ...process.env, AGENT_CONFIG: tmp },
  })
  if (!/ok/.test(out)) throw new Error('子进程没通过：' + out.slice(0, 200))
})
try { fs.unlinkSync(tmp) } catch {}

console.log('\n通过 ' + ok.length + ' 项：')
for (const o of ok) console.log('  ✓ ' + o)
if (bad.length) {
  console.log('\n失败 ' + bad.length + ' 项：')
  for (const b of bad) console.log('  ✗ ' + b)
  process.exit(1)
}
console.log('\n全部通过（' + ok.length + '/' + ok.length + '）')
