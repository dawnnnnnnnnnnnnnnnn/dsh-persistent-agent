/**
 * adapters/onebot/sessions.mjs —— 会话绑定映射（OneBot 侧的私活）
 *
 * OneBot 网关把「谁在哪个会话」写成 chat-sessions.json：
 *   { "private:<ownerQQ>": "onebot-private-<qq>-<rid>", "group:<群号>": "..." }
 * 这个文件的形态、键名、以及"绑定被清空后怎么找回来"都属于平台细节，
 * 所以整块从 core 搬到这里；core 只通过 channel.sessionOf() / channel.sessions.* 访问。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from '../../core/lib/config.mjs'
import { onebot } from './config.mjs'

export const MAP = onebot.sessionMap

function readJson(file, fallback = {}) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { return { ...fallback } }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** chatId 归一：'owner' → private:<ownerQQ>，纯数字 → private:<数字> */
export function keyOf(chatId) {
  const s = String(chatId ?? '').trim()
  if (!s || s === 'owner' || s === 'master') return 'private:' + onebot.ownerQQ
  if (s.startsWith('private:') || s.startsWith('group:')) return s
  return 'private:' + s
}

/** 读绑定。绑定值有两种形态：纯字符串 / { session, ... }，两种都要认 */
export function get(chatId) {
  const m = readJson(MAP)
  const raw = m[keyOf(chatId)]
  const sid = typeof raw === 'string' ? raw : String(raw?.session ?? raw?.sessionId ?? '')
  return sid || ''
}

export function set(chatId, sessionId) {
  const m = readJson(MAP)
  m[keyOf(chatId)] = String(sessionId)
  return writeJson(MAP, m)
}

/** 会话目录名编码：宿主把工作目录里的 : \ / 换成 '-' 当目录名 */
export function encodeDir(cwd) {
  return String(cwd).replace(/[:\\/]/g, '-')
}

/** 宿主里存某个工作目录会话的根目录 */
export function sessionRoot(cwd = path.join(DSH_HOME, 'memory')) {
  return path.join(DSH_HOME, 'sessions', '--' + encodeDir(cwd) + '--')
}

/** 绑定被网关整条清空时，去会话目录里捞最新的那条私聊会话 */
export function newest(chatId = 'owner') {
  const qq = keyOf(chatId).replace(/^private:/, '')
  const prefix = 'onebot-private-' + qq
  try {
    const base = sessionRoot()
    const dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => ({ name: d.name, t: fs.statSync(path.join(base, d.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    return dirs[0]?.name ?? ''
  } catch { return '' }
}

/**
 * 自愈：绑定空了就按 newest() 捞回来并写回映射。
 * 返回 true 表示这次真的补了一条。
 */
export function heal(chatId = 'owner', log = () => {}) {
  try {
    if (get(chatId)) return false
    const found = newest(chatId)
    if (!found) return false
    set(chatId, found)
    log('绑定自愈：写回 ' + found)
    return true
  } catch (e) {
    log('绑定自愈失败：' + String(e?.message ?? e))
    return false
  }
}

/** 最近一条真正有动静的会话（写日记前判断"使用者在不在说话"用） */
export function lastActivityMs() {
  let newestMs = 0
  try {
    const base = path.join(DSH_HOME, 'sessions')
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d)
      try { if (!fs.statSync(p).isDirectory()) continue } catch { continue }
      for (const sub of fs.readdirSync(p)) {
        for (const f of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
          const fp = path.join(p, sub, f)
          try { if (fs.existsSync(fp)) { const mt = fs.statSync(fp).mtimeMs; if (mt > newestMs) newestMs = mt; break } } catch {}
        }
      }
    }
  } catch {}
  return newestMs
}
