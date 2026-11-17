/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：设计取向借鉴自 Hermes（memory provider + 全文检索、skills 索引只注入摘要、
 * 定时任务作为一等公民、会话导出为训练样本）。无代码复制。
 * 详见 THIRD-PARTY-NOTICES.md §4.1 / docs/ATTRIBUTION.md
 */
/**
 * 记忆索引 —— 对标 Hermes 的 memory provider + FTS 检索。
 *
 * 我们的记忆是 4~6 个 md 文件，以前每轮全量塞进提示词（几十 KB）。
 * 这里改成：切成 chunk → 建倒排 → 按关键词/文件名打分取前 k 段。
 *
 * 只读 memory/*.md，不改内容。
 */
import fs from 'node:fs'
import path from 'node:path'

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '和', '就', '都', '也', '不', '有', '这', '那', '一个', '什么', '怎么'])

/** 把一段文本切成 chunk：优先按 "## " 标题，其次按空行段落 */
export function chunkText(file, text) {
  const chunks = []
  const parts = text.split(/\n(?=##\s)/)
  for (const part of parts) {
    const head = (part.match(/^##\s+(.+)$/m) ?? [])[1] ?? path.basename(file)
    const body = part.trim()
    if (body.length < 20) continue
    // 太长的再按空行拆
    if (body.length > 1200) {
      for (const seg of body.split(/\n\s*\n/)) {
        if (seg.trim().length >= 20) chunks.push({ file, heading: head, text: seg.trim() })
      }
    } else {
      chunks.push({ file, heading: head, text: body })
    }
  }
  return chunks
}

/** 简单分词：中文取 2-gram，英文/数字取整词 */
export function tokens(s) {
  const out = new Set()
  const text = String(s ?? '')
  for (const w of text.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? []) out.add(w.toLowerCase())
  const cn = text.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const seg of cn.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i += 1) {
      const g = seg.slice(i, i + 2)
      if (!STOP.has(g)) out.add(g)
    }
  }
  return [...out]
}

export function buildIndex(memoryDir) {
  // 早期：除了顶层 md，也把「情绪/」和「给他/」收进来 —— 这两个子目录
  // 里放的是她要能想起来的判断与信，不进索引就等于永远想不起来。
  const files = []
  const top = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
  for (const f of top) files.push(f)
  for (const sub of ['情绪', '给他']) {
    try {
      for (const f of fs.readdirSync(path.join(memoryDir, sub)).filter((x) => x.endsWith('.md'))) {
        files.push(path.join(sub, f))
      }
    } catch {}
  }
  const chunks = []
  for (const f of files) {
    const full = path.join(memoryDir, f)
    let text = ''
    try { text = fs.readFileSync(full, 'utf8') } catch { continue }
    for (const c of chunkText(f, text)) {
      chunks.push({ ...c, id: chunks.length, tokens: tokens(c.heading + '\n' + c.text) })
    }
  }
  const postings = new Map()
  for (const c of chunks) {
    for (const t of c.tokens) {
      if (!postings.has(t)) postings.set(t, [])
      postings.get(t).push(c.id)
    }
  }
  return {
    builtAt: new Date().toISOString(),
    files: files.length,
    chunks: chunks.length,
    // 落盘时把 tokens 干掉（索引靠 postings），省空间
    index: { postings: Object.fromEntries([...postings].map(([k, v]) => [k, [...new Set(v)]])), chunks: chunks.map(({ id, file, heading }) => ({ id, file, heading })) },
    _chunks: chunks,
  }
}

/** 检索：返回 top-k chunk（带原文） */
export function search(built, query, k = 5) {
  const qs = tokens(query)
  if (!qs.length) return []
  const score = new Map()
  for (const t of qs) {
    const ids = built.index.postings[t]
    if (!ids) continue
    for (const id of ids) score.set(id, (score.get(id) ?? 0) + (t.length > 2 ? 2 : 1))
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, s]) => ({ score: s, ...built._chunks[id] }))
}
