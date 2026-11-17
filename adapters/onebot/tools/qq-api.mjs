#!/usr/bin/env node
/**
 * QQ 万能调用器 —— 直接打本机 NapCat 的 OneBot HTTP 接口，绕过 onebot 插件的白名单。
 *
 * 为什么要有它：dsh-onebot-qq 的 `qq_napcat_api` 只放行十几个 action；
 * 但 NapCat 本身支持的多得多（名片赞、发说说、群管理…）。{{BOT_NAME}}是能跑命令的 agent，
 * 走这个脚本就能做插件没暴露的事。
 *
 * 用法：
 *   node qq-api.mjs <action> [json参数]
 *   node qq-api.mjs get_login_info
 *   node qq-api.mjs send_like '{"user_id":{{OWNER_QQ}},"times":5}'
 *   node qq-api.mjs send_qzone_msg '{"content":"今天风大","ugc_right":64}'
 *   node qq-api.mjs get_group_msg_history '{"group_id":onebot.groupId,"count":5}'
 *   node qq-api.mjs --list                # 打印实测可用的 action
 *
 * 约定：retcode===0 才算成功；否则原样打印 retcode/消息并以 1 退出（别静默吞错）。
 */

const API = process.env.QQ_API || 'http://127.0.0.1:5700'
const TOKEN = process.env.QQ_API_TOKEN || onebot.token

const KNOWN = {
  get_login_info: '当前登录的机器人号',
  get_status: '在线状态',
  get_version_info: 'NapCat/QQ 版本',
  get_friend_list: '好友列表',
  get_group_list: '群列表',
  get_stranger_info: '{user_id} 陌生人/好友资料',
  get_group_member_list: '{group_id} 群成员',
  get_group_msg_history: '{group_id,count} 群历史消息',
  get_friend_msg_history: '{user_id,count} 私聊历史',
  send_private_msg: '{user_id,message:[{type:"text",data:{text:"..."}}]} 发私聊',
  send_group_msg: '{group_id,message:[...]} 发群',
  send_like: '{user_id,times} 名片赞（每天有上限，超了返回"已达上限"）',
  send_qzone_msg: '{content,ugc_right} 发说说（1=公开 4=好友 64=仅自己）',
  set_friend_remark: '{user_id,remark} 改好友备注',
  delete_msg: '{message_id} 撤回',
  set_group_ban: '{group_id,user_id,duration(秒，0=解禁)} 禁言（我在该群必须是管理员）',
  set_group_kick: '{group_id,user_id,reject_add_request} 踢人（需要管理员）',
  set_group_card: '{group_id,user_id,card} 改群名片（需要管理员）',
  set_group_leave: '{group_id} 退群',
  get_group_info: '{group_id} 群资料',
  send_group_forward_msg: '{group_id,messages} 合并转发（长内容）',
  get_forward_msg: '{id} 读合并转发内容',
  mark_msg_as_read: '{message_id} 标记已读',
}

const argv = process.argv.slice(2)
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
  console.log('用法: node qq-api.mjs <action> [json参数]')
  console.log('\n实测可用的 action：')
  for (const [k, v] of Object.entries(KNOWN)) console.log('  ' + k.padEnd(24) + v)
  process.exit(0)
}

const action = argv[0]
let params = {}
if (argv[1]) {
  try {
    params = JSON.parse(argv.slice(1).join(' '))
  } catch (e) {
    console.error('参数不是合法 JSON：' + String(e.message))
    process.exit(2)
  }
}

const r = await fetch(`${API}/${action}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(params),
})

const raw = await r.text()
let j = null
try { j = JSON.parse(raw) } catch {}

if (!r.ok) {
  console.error(`✗ HTTP ${r.status}：${raw.slice(0, 300)}`)
  process.exit(1)
}
if (j === null) {
  console.log(`HTTP ${r.status}（非 JSON）：${raw.slice(0, 300)}`)
  process.exit(0)
}

if (j.retcode === 0) {
  console.log(JSON.stringify(j.data ?? j, null, 2))
} else {
  console.error(`✗ ${action} 失败：retcode=${j.retcode} ${j.message ?? j.wording ?? ''}`)
  process.exit(1)
}
