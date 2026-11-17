/**
 * adapters/onebot/config.mjs —— 唯一允许出现 QQ 号 / 群号 / 令牌的地方
 *
 * 数据来源（优先级从高到低）：
 *   1. 环境变量：OWNER_QQ / BOT_QQ / GROUP_ID / NAPCAT_TOKEN / NAPCAT_HOST / NAPCAT_PORT
 *   2. 仓库根的 agent.config.json 里的 channels.onebot 段：
 *        { "channels": { "active": "onebot",
 *                        "onebot": { "baseUrl": "http://127.0.0.1:5700",
 *                                    "accessToken": "{{NAPCAT_TOKEN}}" } },
 *          "identity": { "ownerId": "{{OWNER_QQ}}", "botId": "{{BOT_QQ}}" } }
 *   3. 占位符默认值（{{OWNER_QQ}} 之类）—— 启动期 assertReady() 会明确报错让你去填
 *
 * 注意：core 的 config.mjs 只认 identity/channels 这类中性字段；
 * 平台号段只在本文件里被解释成 ownerQQ / botQQ / token。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DSH_HOME, CONFIG_FILE, cfg as coreCfg,
} from '../../core/lib/config.mjs'

export const PLACEHOLDER = {
  ownerQQ: '{{OWNER_QQ}}',
  botQQ: '{{BOT_QQ}}',
  groupId: '{{GROUP_ID}}',
  token: '{{NAPCAT_TOKEN}}',
}

function unset(v) {
  const s = String(v ?? '').trim()
  if (!s) return true
  if (s.startsWith('填') || s.startsWith('你的')) return true
  return /^\{\{[A-Z_]+\}\}$/.test(s)
}

/** 原始配置文件（读坏了当空对象，不炸） */
function fileConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

function section() {
  const raw = fileConfig()
  return raw?.channels?.onebot ?? {}
}

function pick(key, envKeys, fallback) {
  for (const e of envKeys) if (!unset(process.env[e])) return process.env[e]
  const v = section()[key]
  if (!unset(v)) return v
  return fallback
}

function parseBase() {
  const u = process.env.NAPCAT_URL || section().baseUrl || 'http://127.0.0.1:5700'
  try { return new URL(u) } catch { return new URL('http://127.0.0.1:5700') }
}

export const onebot = {
  /** OneBot 网关地址：默认 127.0.0.1:5700，可在 agent.config.json 的 channels.onebot.baseUrl 改 */
  get host() { return pick('host', ['NAPCAT_HOST', 'ONEBOT_HOST'], parseBase().hostname) },
  get port() { return Number(pick('port', ['NAPCAT_PORT', 'ONEBOT_PORT'], parseBase().port || 5700)) },
  get token() { return pick('accessToken', ['NAPCAT_TOKEN', 'QQ_API_TOKEN', 'ONEBOT_TOKEN'], PLACEHOLDER.token) },
  get ownerQQ() { return pick('ownerId', ['OWNER_QQ', 'AGENT_OWNER_QQ'], coreCfg.identity.ownerId || PLACEHOLDER.ownerQQ) },
  get botQQ() { return pick('botId', ['BOT_QQ', 'SELF_QQ', 'AGENT_BOT_QQ'], coreCfg.identity.botId || PLACEHOLDER.botQQ) },
  get groupId() { return pick('groupId', ['GROUP_ID', 'AGENT_GROUP_ID'], coreCfg.groupId || PLACEHOLDER.groupId) },
  get groups() {
    const list = Array.isArray(section().groups) ? section().groups.map(String) : []
    const g = String(this.groupId || '')
    if (g && !unset(g)) list.push(g)
    return [...new Set(list.filter((x) => x && !unset(x)))]
  },
  get apiBase() { return 'http://' + this.host + ':' + this.port },
  get wsBase() { return 'ws://' + this.host + ':' + this.port },
  get mediaDir() { return path.join(DSH_HOME, 'media', 'onebot') },
  get sessionMap() { return path.join(DSH_HOME, 'media', 'onebot', 'chat-sessions.json') },
}

/** 启动期校验：缺号就抛一条照得着改的错 */
export function assertReady() {
  const bad = []
  if (unset(onebot.ownerQQ)) bad.push('identity.ownerId（或环境变量 OWNER_QQ）')
  if (unset(onebot.token)) bad.push('channels.onebot.accessToken（或环境变量 NAPCAT_TOKEN）')
  if (bad.length) {
    throw new Error(
      'onebot 适配器配置未就绪，缺：' + bad.join('、') +
      '\n  改 ' + CONFIG_FILE +
      '\n  参考 adapters/onebot/agent.config.example.json',
    )
  }
  return true
}

/** 软校验：只提醒一次，不阻断（核心层调用适配器时不希望炸） */
export function warnIfIncomplete() {
  if (unset(onebot.ownerQQ)) {
    console.error('[onebot] 还没配使用者号：改 ' + CONFIG_FILE + ' 的 identity.ownerId，或设 OWNER_QQ')
  }
  if (unset(onebot.token)) {
    console.error('[onebot] 还没配令牌：改 ' + CONFIG_FILE + ' 的 channels.onebot.accessToken，或设 NAPCAT_TOKEN')
  }
}

/** 端口说明：5700 是 OneBot/NapCat 的常见默认值，配置里可改，不是写死的 */
export const DEFAULT_PORT = 5700
