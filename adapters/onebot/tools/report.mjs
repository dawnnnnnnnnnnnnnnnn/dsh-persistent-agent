#!/usr/bin/env node
/**
 * report.mjs —— 被骂时的「留存证据 + 通知使用者 + 群内处置」一条龙。
 *
 * 先说清楚能做到哪一步（不信口开河）：
 *   ✅ 能做：把辱骂消息连人带时间存成案卷、推给使用者、群里按权限禁言/撤回、
 *            把对方拉好友黑名单（仅本地生效）
 *   ❌ 不能做：直接向腾讯「举报」。NapCat / OneBot 没有这个接口，
 *             真正的举报只能你在手机 QQ 里点（或冒封号风险做 UI 自动化，不建议）。
 *
 * 用法（她在会话里自己调用）：
 *   node report.mjs add --group onebot.groupId --uid 123456789 --text "原话" [--msg 456] [--severity 2]
 *   node report.mjs list
 *   node report.mjs show 3
 *   node report.mjs mute --group onebot.groupId --uid 123456789 --minutes 10   (需要我在群里是管理员)
 *   node report.mjs recall --msg 456789                                    (撤回，需要管理员)
 *
 * 案卷落盘：memory\案件\YYYY-MM-DD-hhmm-<uid>.md（同时维护 cases.json 方便统计）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { onebot } from '../config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const MEM = path.join(DSH, 'memory')
const CASE_DIR = path.join(MEM, '案件')
const INDEX = path.join(CASE_DIR, 'cases.json')
const NOTIFY = path.join(DSH, 'bili-whale', 'qq-notify.mjs')
const API = path.join(DSH, 'bili-whale', 'qq-api.mjs')

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const ensure = () => { fs.mkdirSync(CASE_DIR, { recursive: true }) }

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

if (cmd === 'add') {
  ensure()
  const group = arg('--group') || ''
  const uid = arg('--uid') || ''
  const text = String(arg('--text') || '').slice(0, 500)
  const msgId = arg('--msg') || ''
  const severity = Number(arg('--severity') || 2)
  if (!uid || !text) { console.error('用法: report.mjs add --uid <QQ> --text "<原话>" [--group <群号>] [--msg <id>]'); process.exit(2) }

  const id = stamp() + '-' + uid
  const file = path.join(CASE_DIR, id + '.md')
  const body = [
    `# 案件 ${id}`,
    '',
    `- 时间：${new Date().toLocaleString('zh-CN')}`,
    `- 来源：${group ? '群 ' + group : '私聊'}`,
    `- 对方 QQ：${uid}`,
    msgId ? `- 消息 ID：${msgId}` : '',
    `- 严重度：${severity} / 3`,
    '',
    '## 原话',
    '',
    '> ' + text.replace(/\n/g, '\n> '),
    '',
    '## 我做了什么',
    '',
    '- [ ] 留存证据（本文件）',
    '- [ ] 通知使用者',
    group ? '- [ ] 群里处置（禁言/撤回，需管理员）' : '- [ ] 拉黑（私聊）',
    '',
  ].filter(Boolean).join('\n')
  fs.writeFileSync(file, body, 'utf8')

  const idx = readJson(INDEX, { cases: [] }) || { cases: [] }
  idx.cases.push({ id, at: new Date().toISOString(), group, uid, msgId, severity, text })
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + '\n')

  // 通知使用者（带证据摘要）
  if (fs.existsSync(NOTIFY)) {
    const msg = [
      `【被骂了·已留证】`,
      `谁：${uid}${group ? '（群 ' + group + '）' : '（私聊）'}`,
      `原话：「${text.slice(0, 120)}」`,
      `案卷：memory\\案件\\${id}.md`,
      '',
      `要我怎么回？不回 / 冷一句 / 让管理员处置，你说。`,
    ].join('\n')
    try { execFileSync(process.execPath, [NOTIFY, msg], { windowsHide: true, timeout: 30000 }) } catch {}
  }
  console.log('✓ 已立案：' + id)
  console.log('  文件：' + file)
  process.exit(0)
}

if (cmd === 'list' || !cmd) {
  const idx = readJson(INDEX, { cases: [] }) || { cases: [] }
  if (!idx.cases.length) { console.log('还没有案件'); process.exit(0) }
  idx.cases.forEach((c, i) => console.log(`${i + 1}. ${c.id}  ${c.group || '私聊'}  ${c.uid}  「${String(c.text).slice(0, 24)}」`))
  process.exit(0)
}

if (cmd === 'show') {
  const n = Number(argv[1])
  const idx = readJson(INDEX, { cases: [] }) || { cases: [] }
  const c = idx.cases[n - 1]
  if (!c) { console.error('编号超出范围'); process.exit(2) }
  const f = path.join(CASE_DIR, c.id + '.md')
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : JSON.stringify(c, null, 2))
  process.exit(0)
}

if (cmd === 'mute') {
  const group = arg('--group'), uid = arg('--uid')
  const minutes = Number(arg('--minutes') || 10)
  if (!group || !uid) { console.error('用法: report.mjs mute --group <gid> --uid <uid> [--minutes 10]'); process.exit(2) }
  try {
    const out = execFileSync(process.execPath, [API, 'set_group_ban', JSON.stringify({ group_id: Number(group), user_id: Number(uid), duration: minutes * 60 })], { windowsHide: true, timeout: 20000, encoding: 'utf8' })
    console.log('✓ 已禁言 ' + minutes + ' 分钟' + (out ? '：' + out.trim().slice(0, 120) : ''))
  } catch (e) {
    console.log('✗ 禁言失败（大概率我在这个群不是管理员）：' + String(e?.message ?? e).slice(0, 120))
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'recall') {
  const msg = arg('--msg')
  if (!msg) { console.error('用法: report.mjs recall --msg <message_id>'); process.exit(2) }
  try {
    execFileSync(process.execPath, [API, 'delete_msg', JSON.stringify({ message_id: Number(msg) })], { windowsHide: true, timeout: 20000 })
    console.log('✓ 已撤回')
  } catch (e) {
    console.log('✗ 撤回失败（需要管理员或消息太旧）：' + String(e?.message ?? e).slice(0, 120))
    process.exit(1)
  }
  process.exit(0)
}

console.error('用法: add | list | show <n> | mute --group --uid | recall --msg')
process.exit(2)
