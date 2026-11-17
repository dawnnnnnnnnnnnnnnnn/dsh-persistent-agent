#!/usr/bin/env node
/**
 * 心跳刷空间：按概率去空间转一圈 —— 看最近 N 条、全点赞、看自己说说下面的评论（有人找就回）。
 *
 * 规矩：
 *   1. 只碰使用者/自己的空间
 *   2. 最新一条和上次一样、且没人找她 → NO_NEW（什么都不做）
 *   3. 概率默认 50%，掷不到 → SKIP_ROLL（但评论照旧列出来）
 *   4. **看过的都点赞**（同一条只赞一次；--like-max 可限）
 *   5. **自己说说下的评论要回**：列成 REPLY_CAND 给她自己写话
 *   6. 评论一天上限 10 条；回复按"同一条评论只回一次"记账
 *
 * 用法：
 *   node qzone-heartbeat.mjs                       # 心跳
 *   node qzone-heartbeat.mjs --n 15 --p 0.7        # 看更多 / 更勤
 *   node qzone-heartbeat.mjs --dry                 # 只看判定
 *   node qzone-heartbeat.mjs --record-comment <tid>
 *   node qzone-heartbeat.mjs --record-reply <postTid>:<cid>
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { onebot } from '../config.mjs'

const API = process.env.NAPCAT_API || 'http://127.0.0.1:5700'
const TOKEN = process.env.NAPCAT_TOKEN || onebot.token
const OWNER = process.env.QZONE_OWNER || onebot.ownerQQ
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const COMMENT_CAP = 10

const HOME = process.env.USERPROFILE || os.homedir()
const STATE = path.join(HOME, '.bili-ai', 'qzone-heartbeat.json')

const argv = process.argv.slice(2)
const pick = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }
const has = (n) => argv.includes('--' + n)

const P = Number(pick('p') ?? 0.5)
const N = Math.max(1, Number(pick('n') ?? 10))
const LIKE_MAX = Math.max(0, Number(pick('like-max') ?? 999))
const COMMENT_MAX = Math.max(0, Number(pick('comment-max') ?? 2))
const DRY = has('dry')
const FORCE = has('force')

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
const writeState = (o) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2) + '\n') }
const today = () => new Date().toLocaleDateString('sv-SE')

// 记账
const recComment = pick('record-comment')
if (recComment) {
  const st0 = readState()
  const count = ((st0.commentDate === today() ? st0.commentCount : 0) ?? 0) + 1
  writeState({ ...st0, commentedTids: [...new Set([...(st0.commentedTids ?? []), recComment])].slice(-300), commentDate: today(), commentCount: count })
  console.log('OK 已记录评论 ' + recComment + '（今天第 ' + count + ' 条）')
  process.exit(0)
}
const recReply = pick('record-reply')
if (recReply) {
  const st0 = readState()
  writeState({ ...st0, repliedCids: [...new Set([...(st0.repliedCids ?? []), recReply])].slice(-300) })
  console.log('OK 已记录回复 ' + recReply)
  process.exit(0)
}

function parseJsonp(txt) {
  const s = String(txt)
  const m = s.match(/callback\(\s*(\{[\s\S]*?\})\s*\)/)
  if (m) { try { return JSON.parse(m[1]) } catch {} }
  try { return JSON.parse(s) } catch {}
  const m2 = s.match(/\{[\s\S]*\}/)
  if (m2) { try { return JSON.parse(m2[0]) } catch {} }
  return null
}

async function session() {
  const r = await fetch(`${API}/get_cookies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ domain: 'user.qzone.qq.com' }),
  })
  const j = await r.json()
  const cookie = String(j?.data?.cookies ?? '')
  const bkn = String(j?.data?.bkn ?? '')
  if (!cookie || !bkn) throw new Error('NapCat 没给 cookie/bkn')
  return { cookie, bkn, uin: (cookie.match(/uin=o?(\d+)/) ?? [])[1] ?? '' }
}

const H = (s, host) => ({ 'user-agent': UA, referer: `https://user.qzone.qq.com/${host}`, cookie: s.cookie })

async function listFeeds(s, target, num) {
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=${target}&ftype=0&sort=0&pos=0&num=${num}&replynum=0&g_tk=${s.bkn}&code_version=1&format=json&need_private_comment=1`
  const j = await (await fetch(url, { headers: H(s, target) })).json()
  if (j.code !== 0) throw new Error(`msglist code=${j.code} ${j.message ?? ''}`)
  return (j.msglist ?? []).map((m) => ({ tid: m.tid, created: Number(m.created_time ?? 0), text: String(m.content ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }))
}

async function listComments(s, host, postTid) {
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?uin=${host}&tid=${postTid}&format=json&g_tk=${s.bkn}`
  const txt = await (await fetch(url, { headers: H(s, host) })).text()
  const m = txt.match(/\{[\s\S]*\}/)
  let j = null
  try { j = m ? JSON.parse(m[0]) : null } catch {}
  if (!j || j.code !== 0) return []
  return (j.commentlist ?? []).map((c) => ({
    tid: String(c.tid ?? ''),
    uin: String(c.uin ?? c.owner?.uin ?? ''),
    name: String(c.name ?? ''),
    content: String(c.content ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    replyNum: Number(c.replyNum ?? 0),
  }))
}

async function like(s, target, feed) {
  const unikey = `http://user.qzone.qq.com/${target}/mood/${feed.tid}`
  const body = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${target}`, opuin: s.uin, unikey, curkey: unikey,
    from: '1', appid: '311', typeid: '0', abstime: String(feed.created), fid: feed.tid, active: '0', fupdate: '1',
  })
  const r = await fetch(`https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${s.bkn}`, {
    method: 'POST',
    headers: { ...H(s, target), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  return parseJsonp(await r.text())?.code === 0
}

try {
  const s = await session()
  const st = readState()

  const feeds = await listFeeds(s, OWNER, N)
  console.log('SEEN=' + feeds.length)
  if (!feeds.length) { console.log('STATE=NO_NEW'); console.log('NOTE=使用者空间没有说说'); process.exit(0) }

  const newest = feeds[0]
  const commentedToday = st.commentDate === today() ? (st.commentCount ?? 0) : 0
  const leftComments = Math.max(0, COMMENT_CAP - commentedToday)

  // 自己说说下面的评论（有人问她就得回，不受掷骰子影响）
  const myFeeds = (await listFeeds(s, s.uin, 3)).slice(0, 3)
  const repliedSet = new Set(st.repliedCids ?? [])
  const replyCands = []
  for (const f of myFeeds) {
    for (const c of await listComments(s, s.uin, f.tid)) {
      if (!c.uin || c.uin === s.uin) continue
      if (repliedSet.has(f.tid + ':' + c.tid)) continue
      replyCands.push({ postTid: f.tid, ...c })
    }
  }
  console.log('REPLY_CANDIDATES=' + replyCands.length)

  if (st.lastSeenTid === newest.tid && !replyCands.length) {
    console.log('STATE=NO_NEW')
    console.log('NOTE=没有新说说，也没人找她')
    process.exit(0)
  }

  const roll = FORCE ? 0 : Math.random()
  const rolled = roll < P
  const likedSet = new Set(st.likedTids ?? [])

  if (!rolled) {
    writeState({ ...st, lastSeenTid: newest.tid, lastSeenAt: new Date().toISOString() })
    console.log('STATE=SKIP_ROLL')
    console.log('LIKED_COUNT=0')
    console.log('NOTE=这次没掷中（p=' + P + '），但评论照旧要回')
    for (const c of replyCands) console.log('REPLY_CAND ' + c.postTid + ' ' + c.tid + ' ' + c.uin + ' ' + c.name + ' | ' + c.content.slice(0, 60))
    process.exit(0)
  }

  const fresh = feeds.filter((f) => !likedSet.has(f.tid))
  const commentedSet = new Set(st.commentedTids ?? [])
  const candidates = feeds.filter((f) => !commentedSet.has(f.tid) && f.text.length >= 4).slice(0, Math.min(COMMENT_MAX, leftComments))

  if (DRY) {
    console.log('STATE=DRY')
    console.log('FRESH_UNLIKED=' + fresh.length)
    console.log('WOULD_LIKE=' + (fresh.slice(0, LIKE_MAX).map((f) => f.tid).join(',') || ''))
    console.log('CANDIDATES=' + candidates.length)
    for (const f of candidates) console.log('CAND ' + f.tid + ' | ' + f.text.slice(0, 60))
    for (const c of replyCands) console.log('REPLY_CAND ' + c.postTid + ' ' + c.tid + ' ' + c.uin + ' ' + c.name + ' | ' + c.content.slice(0, 60))
    process.exit(0)
  }

  const likedNow = []
  for (const f of fresh.slice(0, LIKE_MAX)) if (await like(s, OWNER, f)) likedNow.push(f.tid)

  writeState({
    ...st,
    lastSeenTid: newest.tid,
    lastSeenAt: new Date().toISOString(),
    likedTids: [...new Set([...(st.likedTids ?? []), ...likedNow])].slice(-300),
    commentedTids: st.commentedTids ?? [],
    repliedCids: st.repliedCids ?? [],
    commentDate: st.commentDate ?? '',
    commentCount: commentedToday,
  })

  console.log('STATE=' + (likedNow.length ? 'LIKED' : 'LIKED_ALREADY'))
  console.log('LIKED_COUNT=' + likedNow.length)
  console.log('CANDIDATES=' + candidates.length)
  for (const f of candidates) console.log('CAND ' + f.tid + ' | ' + f.text.slice(0, 80))
  for (const c of replyCands) console.log('REPLY_CAND ' + c.postTid + ' ' + c.tid + ' ' + c.uin + ' ' + c.name + ' | ' + c.content.slice(0, 80))
  console.log('NOTE=评论 qzone.mjs comment <tid> "…" --go → --record-comment <tid>；回复 qzone.mjs reply <postTid> <cid> <uin> "…" --go → --record-reply <postTid>:<cid>')
} catch (e) {
  console.log('STATE=ERROR')
  console.log('NOTE=' + String(e.message).slice(0, 160))
  process.exit(1)
}
