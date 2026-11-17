/**
 * adapters/cli/run.mjs —— 在终端里直接跟核心对话（不需要任何 IM 协议端）
 *
 * SPDX-License-Identifier: MIT
 *
 * 这是"核心与通道解耦"的最小验证：注册 CLI 适配器 → 收一行 → 交给 core 的
 * 提示词组装与模型调用 → 把回复打到终端。全程不出现 onebot / QQ。
 *
 * 用法：
 *   node adapters/cli/run.mjs                         交互式
 *   echo "在吗" | node adapters/cli/run.mjs            单条
 *   node adapters/cli/run.mjs --probe                  只检查适配器是否合格
 */
import { registerChannel, getChannel, splitText } from '../../core/lib/channel.mjs'
import { cfg, assertConfig } from '../../core/lib/config.mjs'
import cli from './index.mjs'

const probed = process.argv.includes('--probe')

// 1) 注册适配器（不合格会在这里抛错并指明缺哪个方法）
let channel
try {
  channel = registerChannel(cli)
} catch (e) {
  console.error('[cli] 适配器不合格：' + (e?.message ?? e))
  process.exit(2)
}

if (probed) {
  const conf = assertConfig()
  console.log('适配器契约 v' + channel.contract + '  实现：' + channel.label)
  console.log('probe: ' + JSON.stringify(cli.probe()))
  console.log('limits: ' + JSON.stringify(channel.limits()))
  console.log('身份: ' + JSON.stringify(channel.resolveIdentity({})))
  console.log('配置: ' + (conf.ok ? 'ok' : conf.message))
  process.exit(0)
}

// 2) 回复怎么来：这里演示的是"通道侧只负责收和发"，生成留给核心。
//    核心没挂模型时用一条固定回复，验证链路是否通。
async function replyTo(event) {
  const text = String(event.text ?? '')
  // 真实使用时：import 你的 agent 入口，把 event 交给它，拿回文本
  // 这里给的是链路自检用的回显，避免把"能对话"和"接上了模型"混成一件事
  const lines = [
    '收到（' + channel.label + ' 通道 · 会话 ' + channel.sessionOf(event.chatId) + '）',
    '原文：' + text,
    '契约版本：' + channel.contract + ' · 身份：' + (channel.resolveIdentity(event).isOwner ? '使用者' : '访客'),
  ]
  return lines.join('\n')
}

// 3) 收 → 生成 → 发
const stop = await channel.receive(async (event) => {
  const text = await replyTo(event)
  const parts = splitText(text, channel.limits().maxTextChars)
  for (const p of parts) await channel.send(event.chatId, p)
})

// 等流结束：适配器把 done 挂在 cancel 上就等 done，否则退回"调用 cancel"
// （契约只规定返回 cancel；done 是 cli 适配器加的可选属性，别的适配器可以不提供）
if (stop?.done) await stop.done
else if (typeof stop === 'function') await stop()

const conf = assertConfig()
if (!conf.ok) {
  // 只是提醒：终端能跑，但接不了真实的身份判定
  console.error('\n[cli] 提醒：' + conf.message.replace(/\n/g, '\n  '))
  process.exitCode = 0
}
