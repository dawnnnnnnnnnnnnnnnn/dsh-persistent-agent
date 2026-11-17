/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：设计取向借鉴自 Hermes（memory provider + 全文检索、skills 索引只注入摘要、
 * 定时任务作为一等公民、会话导出为训练样本）。无代码复制。
 * 详见 THIRD-PARTY-NOTICES.md §4.1 / docs/ATTRIBUTION.md
 */
/**
 * skills 索引 —— 对标 Hermes 的 skills/ 目录 + 提示词里的 skills index。
 *
 * 一个 skill 就是一个 md 文件，格式：
 *   # 名字
 *   > 一句话说明（什么时候用它）
 *   ...正文...
 *
 * 这里只负责扫描 + 提取「名字 + 一句话」，塞进 volatile 层；正文不注入（要用的自己去读）。
 */
import fs from 'node:fs'
import path from 'node:path'

export function listSkills(dir) {
  const out = []
  try {
    if (!fs.existsSync(dir)) return out
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      let text = ''
      try { text = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
      const name = (text.match(/^#\s+(.+)$/m) ?? [])[1] ?? f.replace(/\.md$/, '')
      const desc = (text.match(/^>\s*(.+)$/m) ?? [])[1] ?? ''
      out.push({ file: f, name: name.trim(), desc: desc.trim().slice(0, 80) })
    }
  } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function skillsBlock(dir) {
  const list = listSkills(dir)
  if (!list.length) return ''
  return ['### 可用的 skill（要看正文再读文件）', ...list.map((s) => `- ${s.name}：${s.desc}`)].join('\n')
}
