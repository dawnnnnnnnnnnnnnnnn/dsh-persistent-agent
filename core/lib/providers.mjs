/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：设计取向借鉴自 Hermes（memory provider + 全文检索、skills 索引只注入摘要、
 * 定时任务作为一等公民、会话导出为训练样本）。无代码复制。
 * 详见 THIRD-PARTY-NOTICES.md §4.1 / docs/ATTRIBUTION.md
 */
/**
 * 记忆 provider 注册表 —— 对标 Hermes 的 memory_provider（单实例、可替换）。
 *
 * 约定：provider 是一个模块，导出
 *   { name, index(memoryDir), search(built, query, k) }
 *
 * 选择顺序：~/.dsh/agent-core/config.json 里的 memoryProvider（默认 'builtin'），
 * 自定义 provider 放在 ~/.dsh/agent-core/providers/<name>.mjs。
 *
 * 现在只有一个 builtin（倒排索引），但接口是开的：以后接向量库、SQLite FTS、
 * 或别的检索后端，只要丢一个文件进 providers/ 并改配置，不用动插件主逻辑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH = path.join(process.env.USERPROFILE || '', '.dsh')
const CORE = path.join(DSH, 'agent-core')
const PROVIDERS = path.join(CORE, 'providers')

export async function loadProvider(name, builtin) {
  if (!name || name === 'builtin') return { ...builtin, name: 'builtin' }
  const file = path.join(PROVIDERS, name + '.mjs')
  if (!fs.existsSync(file)) return { ...builtin, name: 'builtin', fallback: `provider ${name} 不存在` }
  try {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.index !== 'function' || typeof mod.search !== 'function') {
      return { ...builtin, name: 'builtin', fallback: `provider ${name} 接口不全` }
    }
    return { name, index: mod.index, search: mod.search }
  } catch (e) {
    return { ...builtin, name: 'builtin', fallback: `provider ${name} 加载失败：${e.message}` }
  }
}

export function listProviders() {
  const out = ['builtin']
  try {
    for (const f of fs.readdirSync(PROVIDERS)) if (f.endsWith('.mjs')) out.push(f.replace(/\.mjs$/, ''))
  } catch {}
  return out
}
