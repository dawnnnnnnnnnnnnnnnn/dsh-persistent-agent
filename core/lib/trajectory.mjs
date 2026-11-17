/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：设计取向借鉴自 Hermes（memory provider + 全文检索、skills 索引只注入摘要、
 * 定时任务作为一等公民、会话导出为训练样本）。无代码复制。
 * 详见 THIRD-PARTY-NOTICES.md §4.1 / docs/ATTRIBUTION.md
 */
/**
 * 轨迹导出 —— 对标 Hermes 的 trajectories（把会话转成训练用的对话样本）。
 *
 * 只读：从 DSH 的 session.v4.jsonl.zstd 里取出 user / assistant 文本，
 * 输出 ShareGPT 风格 JSONL：{ "conversations": [{from:"human",value},{from:"gpt",value}] }
 *
 * 用途：以后要微调、要做评测集、要复盘她怎么答的，不用再手写解析。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export function readSession(file) {
  const b = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const idx = []
  let i = 0
  while ((i = b.indexOf(magic, i)) !== -1) { idx.push(i); i += 4 }
  const parts = []
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1] : b.length
    try { parts.push(zlib.zstdDecompressSync(b.subarray(idx[k], end))) } catch {}
  }
  return Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

export function toTrajectory(events) {
  const conv = []
  for (const e of events) {
    if (e.type === 'user/message') {
      const text = (e.data?.content ?? []).map((c) => c.text ?? '').join('').trim()
      if (text) conv.push({ from: 'human', value: text })
    } else if (e.type === 'assistant/message') {
      const text = (e.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim()
      if (text && text !== '[SILENT]') conv.push({ from: 'gpt', value: text })
    }
  }
  return conv
}

/** 导出某个会话到 ~/.dsh/agent-core/trajectories/<name>.jsonl */
export function exportSession(sessionDir, name) {
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(file)) return { ok: false, error: 'no session file' }
  const conv = toTrajectory(readSession(file))
  if (!conv.length) return { ok: false, error: 'empty conversation' }
  const outDir = path.join(process.env.USERPROFILE || '', '.dsh', 'agent-core', 'trajectories')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `${name || 'session'}-${Date.now()}.jsonl`)
  fs.writeFileSync(out, JSON.stringify({ conversations: conv }) + '\n', 'utf8')
  return { ok: true, turns: conv.length, file: out }
}
