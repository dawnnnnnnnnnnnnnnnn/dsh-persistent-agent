#!/usr/bin/env node
/**
 * QQ 空间：读说说 / 点赞 / 评论（走 NapCat 的 cookie + bkn，直打 Qzone web 接口）
 *
 * 用法：
 *   node qzone.mjs list [uin] [n]                    列出某人的说说（默认自己）
 *   node qzone.mjs like <tid|latest> [--uin 目标] [--go]     点赞（默认只预演）
 *   node qzone.mjs comment <tid|latest> "内容" [--uin 目标] [--go]   评论（默认只预演）
 *
 * 说明：
 *   - 目标 uin 默认 = 使用者 {{OWNER_QQ}}（配置在下方 OWNER）
 *   - 不带 --go 一律只打印"将要做什么"，不发请求
 *   - 失败会把接口原话打出来，别猜
 */

const API = process.env.NAPCAT_API || 'http://127.0.0.1:5700'
const TOKEN = process.env.NAPCAT_TOKEN || onebot.token
const OWNER = process.env.QZONE_OWNER || onebot.ownerQQ
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function qzoneSession() {
  const r = await fetch(`${API}/get_cookies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ domain: 'user.qzone.qq.com' }),
  })
  const j = await r.json()
  const cookie = String(j?.data?.cookies ?? '')
  const bkn = String(j?.data?.bkn ?? '')
  const uin = (cookie.match(/(?:^|;\s*)uin=o?(\d+)/) ?? [])[1] ?? ''
  if (!cookie || !bkn) throw new Error('NapCat 没给 cookie/bkn：' + JSON.stringify(j).slice(0, 200))
  return { cookie, bkn, uin }
}

function headers(cookie, referer) {
  return { 'user-agent': UA, referer, cookie, origin: 'https://user.qzone.qq.com' }
}

async function listFeeds(s, target, num = 5) {
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=${target}&ftype=0&sort=0&pos=0&num=${num}&replynum=0&g_tk=${s.bkn}&code_version=1&format=json&need_private_comment=1`
  const r = await fetch(url, { headers: headers(s.cookie, `https://user.qzone.qq.com/${target}`) })
  const txt = await r.text()
  let j = null
  try { j = JSON.parse(txt) } catch {}
  if (!j) throw new Error('返回不是 JSON：' + txt.slice(0, 200))
  if (j.code !== 0) throw new Error(`code=${j.code} ${j.message ?? j.msg ?? ''}`)
  return (j.msglist ?? []).map((m) => ({
    tid: m.tid,
    created: Number(m.created_time ?? 0),
    text: String(m.content ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    likes: m.likenum,
    comments: m.commentnum,
  }))
}

async function like(s, target, feed) {
  const unikey = `http://user.qzone.qq.com/${target}/mood/${feed.tid}`
  const body = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${target}`,
    opuin: s.uin,
    unikey,
    curkey: unikey,
    from: '1',
    appid: '311',
    typeid: '0',
    abstime: String(feed.created),
    fid: feed.tid,
    active: '0',
    fupdate: '1',
  })
  const r = await fetch(`https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${s.bkn}`, {
    method: 'POST',
    headers: { ...headers(s.cookie, `https://user.qzone.qq.com/${target}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const txt = await r.text()
  const j = parseJsonp(txt)
  return { ok: j?.code === 0, raw: txt.replace(/\s+/g, ' ').slice(0, 200), json: j }
}

/** Qzone 的点赞接口回的是 JSONP（frameElement.callback({...})），不是裸 JSON */
function parseJsonp(txt) {
  const m = String(txt).match(/callback\(\s*(\{[\s\S]*?\})\s*\)/)
  if (m) { try { return JSON.parse(m[1]) } catch {} }
  try { return JSON.parse(txt) } catch {}
  const m2 = String(txt).match(/\{[\s\S]*\}/)
  if (m2) { try { return JSON.parse(m2[0]) } catch {} }
  return null
}

async function comment(s, target, feed, text) {
  // 早期：参数按 astrbot_plugin_qzone 的可用实现对齐
  //   topicId 必须是 `{被评论者uin}_{tid}__1`，域名是 taotao.qzone.qq.com
  const body = new URLSearchParams({
    topicId: `${target}_${feed.tid}__1`,
    uin: s.uin,
    hostUin: target,
    feedsType: '100',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
    format: 'fs',
    ref: 'feeds',
    content: text,
  })
  const r = await fetch(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${s.bkn}`, {
    method: 'POST',
    headers: { ...headers(s.cookie, `https://user.qzone.qq.com/${target}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const txt = await r.text()
  const j = parseJsonp(txt)
  return { ok: j?.code === 0, raw: txt.replace(/\s+/g, ' ').slice(0, 240), json: j }
}

/** 删一条自己发的说说 */
async function removeFeed(s, tid) {
  const body = new URLSearchParams({
    uin: s.uin,
    topicId: `${s.uin}_${tid}__1`,
    feedsType: '0',
    feedsFlag: '0',
    feedsKey: tid,
    feedsAppid: '311',
    feedsTime: String(Math.floor(Date.now() / 1000)),
    fupdate: '1',
    ref: 'feeds',
  })
  const r = await fetch(`https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${s.bkn}`, {
    method: 'POST',
    headers: { ...headers(s.cookie, `https://user.qzone.qq.com/${s.uin}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const txt = await r.text()
  const j = parseJsonp(txt)
  return { ok: j?.code === 0, raw: txt.replace(/\s+/g, ' ').slice(0, 200), json: j }
}

// ── 评论：读 + 回复（）────────────────────────────────
async function listComments(s, host, postTid) {
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?uin=${host}&tid=${postTid}&format=json&g_tk=${s.bkn}`
  const r = await fetch(url, { headers: headers(s.cookie, `https://user.qzone.qq.com/${host}`) })
  const txt = await r.text()
  const m = txt.match(/\{[\s\S]*\}/)
  const j = m ? JSON.parse(m[0]) : null
  if (!j || j.code !== 0) throw new Error('msgdetail 失败：' + txt.slice(0, 120))
  return (j.commentlist ?? []).map((c) => ({
    tid: String(c.tid ?? ''),
    uin: String(c.uin ?? c.owner?.uin ?? ''),
    name: String(c.name ?? ''),
    content: String(c.content ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    time: c.createTime2 ?? '',
    replyNum: Number(c.replyNum ?? 0),
  }))
}

async function replyComment(s, host, postTid, commentTid, commentUin, text) {
  const body = new URLSearchParams({
    topicId: `${host}_${postTid}__1`,
    uin: s.uin,
    hostUin: host,
    feedsType: '100',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
    format: 'fs',
    ref: 'feeds',
    content: text,
    commentId: String(commentTid),
    commentUin: String(commentUin),
    richval: '',
    richtype: '',
    private: '0',
    paramstr: '2',
    qzreferrer: `https://user.qzone.qq.com/${s.uin}/main`,
  })
  const r = await fetch(`https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${s.bkn}`, {
    method: 'POST',
    headers: { ...headers(s.cookie, `https://user.qzone.qq.com/${host}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const txt = await r.text()
  const j = parseJsonp(txt)
  return { ok: j?.code === 0, raw: txt.replace(/\s+/g, ' ').slice(0, 200), json: j }
}

// ── CLI ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const cmd = argv[0]
const GO = argv.includes('--go')
const ui = argv.indexOf('--uin')
const target = ui >= 0 ? argv[ui + 1] : OWNER
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== ui + 1 && i !== 0)

const s = await qzoneSession()
console.log(`[机器人 uin=${s.uin}]`)

if (cmd === 'list') {
  const t = positional[0] || OWNER
  const n = Number(positional[1] || 5)
  const feeds = await listFeeds(s, t, n)
  console.log(`目标 ${t} 的最近 ${feeds.length} 条说说：`)
  for (const f of feeds) {
    console.log(`  tid=${f.tid}  ${new Date(f.created * 1000).toLocaleString('zh-CN')}  「${f.text.slice(0, 40)}」`)
  }
  process.exit(0)
}

if (cmd === 'like' || cmd === 'comment') {
  const want = positional[0]
  if (!want) { console.error(`用法: node qzone.mjs ${cmd} <tid|latest> ${cmd === 'comment' ? '"内容" ' : ''}[--uin 目标] [--go]`); process.exit(2) }
  const feeds = await listFeeds(s, target, 5)
  const feed = want === 'latest' ? feeds[0] : feeds.find((f) => f.tid === want)
  if (!feed) { console.error('找不到那条说说（tid 不对？）'); process.exit(1) }

  if (cmd === 'like') {
    console.log(`将要给 ${target} 的说说点赞：${new Date(feed.created * 1000).toLocaleString('zh-CN')} 「${feed.text.slice(0, 30)}」`)
    if (!GO) { console.log('（预演：加 --go 才真的点）'); process.exit(0) }
    const r = await like(s, target, feed)
    console.log(r.ok ? '✓ 已点赞' : '✗ 点赞失败', '｜', r.raw)
    process.exit(r.ok ? 0 : 1)
  }

  const text = positional[1]
  if (!text) { console.error('评论要带内容：node qzone.mjs comment latest "内容" --go'); process.exit(2) }
  console.log(`将要评论 ${target} 的说说：${new Date(feed.created * 1000).toLocaleString('zh-CN')} 「${feed.text.slice(0, 30)}」`)
  console.log('评论内容：' + text)
  if (!GO) { console.log('（预演：加 --go 才真的发）'); process.exit(0) }
  const r = await comment(s, target, feed, text)
  console.log(r.ok ? '✓ 已评论' : '✗ 评论失败', '｜', r.raw)
  process.exit(r.ok ? 0 : 1)
}

if (cmd === 'delete') {
  const tid = positional[0]
  if (!tid) { console.error('用法: node qzone.mjs delete <tid> [--go]'); process.exit(2) }
  console.log('将要删除自己的说说 tid=' + tid)
  if (!GO) { console.log('（预演：加 --go 才真的删）'); process.exit(0) }
  const r = await removeFeed(s, tid)
  console.log(r.ok ? '✓ 已删除' : '✗ 删除失败', '｜', r.raw)
  process.exit(r.ok ? 0 : 1)
}

if (cmd === 'comments') {
  const postTid = positional[0]
  if (!postTid) { console.error('用法: node qzone.mjs comments <说说tid> [--uin 空间使用者]'); process.exit(2) }
  // ：说说可能是**机器人自己**发的（uin=onebot.botQQ），
  // 默认把 host 当使用者会拿到 code=-8。没显式给 --uin 时两个都试一遍。
  const explicit = argv.includes('--uin')
  const hosts = explicit ? [target] : [...new Set([target, s.uin].filter(Boolean))]
  let list = null
  let used = target
  let lastErr = null
  for (const h of hosts) {
    try {
      list = await listComments(s, h, postTid)
      used = h
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!list) throw lastErr ?? new Error('msgdetail 失败')
  console.log(`${used} 的说说 ${postTid} 有 ${list.length} 条评论：`)
  for (const c of list) console.log(`  cid=${c.tid} | ${c.name}(${c.uin}) ${c.time} | ${c.content.slice(0, 40)}${c.replyNum ? ' | 已有回复 ' + c.replyNum : ''}`)
  // 早期：原来这里 process.exit(0)，undici 的 keep-alive socket 还在关闭中就退出，
  // 会抛 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"（exit code 1，看着像失败）。
  // 改成自然退出。
  process.exitCode = 0
  await new Promise((r) => setTimeout(r, 50))
  process.exit(0)
}

if (cmd === 'reply') {
  const [postTid, commentTid, commentUin, ...rest] = positional
  const text = rest.join(' ')
  if (!postTid || !commentTid || !commentUin || !text) {
    console.error('用法: node qzone.mjs reply <说说tid> <评论cid> <评论人uin> "回复内容" [--uin 空间使用者] [--go]')
    process.exit(2)
  }
  console.log(`将要回复 ${target} 的说说 ${postTid} 下 ${commentUin} 的评论 ${commentTid}：${text}`)
  if (!GO) { console.log('（预演：加 --go 才真的发）'); process.exit(0) }
  const r = await replyComment(s, target, postTid, commentTid, commentUin, text)
  console.log(r.ok ? '✓ 已回复' : '✗ 回复失败', '｜', r.raw)
  process.exit(r.ok ? 0 : 1)
}

console.log('用法: node qzone.mjs list|like|comment|comments|reply|delete ...')
