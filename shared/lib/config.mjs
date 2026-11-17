/**
 * core/lib/config.mjs —— 通道无关的统一配置解析
 *
 * SPDX-License-Identifier: MIT
 *
 * 设计：
 *   1. 只读一个文件：仓库根的 `agent.config.json`（模板见 `agent.config.example.json`）。
 *   2. 读不到就回落 `process.env`，再读不到用**中性默认值**（不含任何真实身份）。
 *   3. 通道（IM 平台）的字段一律不进这里，由 adapters/<name>/config.mjs 解释。
 *
 * 任何脚本都从这里取路径与身份，不要自己拼 `{{LOCAL_PATH}}`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')          // 仓库根
const CONFIG_PATH = process.env.AGENT_CONFIG || path.join(ROOT, 'agent.config.json')

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const raw = load()
const env = process.env

const identity = raw.identity ?? {}
const channels = raw.channels ?? {}
const hub = raw.memory ?? {}
const media = raw.media ?? {}
const model = raw.model ?? {}

/** DSH 数据目录（~/.dsh） */
export const DSH_HOME = env.AGENT_DSH_HOME || raw.dshHome || path.join(os.homedir(), '.dsh')

/** 工作区（记忆/产物所在） */
export const WORKSPACE = env.AGENT_WORKSPACE || raw.workspace || path.join(os.homedir(), 'agent-work')

/** 记忆目录 */
export const MEMORY_DIR = env.AGENT_MEMORY_DIR || hub.dir || path.join(WORKSPACE, 'memory')

/** ComfyUI 根目录（可选，只影响生图脚本） */
export const COMFY_ROOT = env.AGENT_COMFY_ROOT || media.comfyRoot || ''

/** ComfyUI 服务地址 */
export const COMFY_BASE_URL = env.AGENT_COMFY_URL || media.comfyBaseUrl || 'http://127.0.0.1:8188'

/**
 * 某个通道的原始配置段。字段含义由适配器自己解释 ——
 * core 只负责把那段 JSON 交出去，不认识里面的键（这是解耦的关键）。
 */
export function adapterConfig(name) {
  return channels?.[name] ?? {}
}

/**
 * 统一配置对象。
 * 字段命名保持平台中立：ownerId / botId / ownerName / botName。
 */
export const cfg = {
  // 新结构
  identity: {
    ownerId: identity.ownerId || '',
    botId: identity.botId || '',
    ownerName: identity.ownerName || '使用者',
    botName: identity.botName || '助手',
  },
  channels,
  channelActive: channels.active || 'cli',
  adapters: channels,
  model: {
    provider: model.provider || 'deepseek-account',
    model: model.model || 'deepseek-flash',
    reasoningEffort: model.reasoningEffort || 'high',
    visionModel: model.visionModel || '',
  },
  heartbeat: raw.heartbeat || { enabled: true },
  media,
  paths: { dshHome: DSH_HOME, workspace: WORKSPACE, memory: MEMORY_DIR, comfyRoot: COMFY_ROOT },

  // 兼容旧字段（老脚本直接读这些）
  get ownerId() { return this.identity.ownerId },
  get botId() { return this.identity.botId },
  get ownerName() { return this.identity.ownerName },
  get botName() { return this.identity.botName },
  get ownerLabel() { return this.identity.ownerName },
  get friendName() { return raw.contactName || '' },
  get groupId() { return raw.chatId || '' },
  get home() { return path.dirname(DSH_HOME) },
  get dshHome() { return DSH_HOME },
  get workspace() { return WORKSPACE },
}

/** 启动时自检：缺关键项就给出可读提示，而不是等到运行时爆炸。 */
export function assertConfig() {
  const missing = []
  if (!cfg.identity.ownerId) missing.push('identity.ownerId（谁是使用者）')
  if (!cfg.identity.botId) missing.push('identity.botId（机器人自己的身份）')
  if (missing.length === 0) return { ok: true }
  return {
    ok: false,
    message: '配置不完整，请编辑 ' + CONFIG_PATH + '：\n  - ' + missing.join('\n  - '),
  }
}

export const CONFIG_FILE = CONFIG_PATH
export default cfg

// ── 通道中性标签与路径展开（core / heartbeat 用；不引入任何平台名）──────────
/** 日记标题、提示词里用的通道名，例如 "chat"。可在配置里改。 */
Object.defineProperty(cfg, 'channelLabel', {
  get() { return raw.channelLabel || env.AGENT_CHANNEL_LABEL || 'chat' },
  enumerable: true,
})

/**
 * 把 {{DSH_HOME}} / {{WORKSPACE}} / {{HOME}} / {{COMFY_ROOT}} 展开成真路径。
 * 还有没填的占位符就抛一条能照着改的错，而不是拿 "{{WORKSPACE}}" 当目录名。
 */
export function resolvePath(tpl) {
  const s = String(tpl ?? '')
  const out = s
    .replace(/\{\{DSH_HOME\}\}/g, DSH_HOME)
    .replace(/\{\{WORKSPACE\}\}/g, WORKSPACE)
    .replace(/\{\{HOME\}\}/g, path.dirname(DSH_HOME))
    .replace(/\{\{COMFY_ROOT\}\}/g, COMFY_ROOT)
  const left = out.match(/\{\{[A-Z_]+\}\}/)
  if (left) throw new Error('agent 路径里有没填的占位符 ' + left[0] + '（' + s + '）：改 ' + CONFIG_PATH + ' 或设 AGENT_WORKSPACE / AGENT_DSH_HOME')
  return out
}