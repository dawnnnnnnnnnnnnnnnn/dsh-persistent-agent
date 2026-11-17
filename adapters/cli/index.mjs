/**
 * adapters/cli/index.mjs —— 终端适配器（最小实现，用来验证"核心不依赖具体 IM"）
 *
 * SPDX-License-Identifier: MIT
 *
 * 这个适配器只做七条契约要求的事，不引入任何外部依赖：
 *   receive(handler)         从 stdin 逐行读，归一成标准事件后交给 handler
 *   send(chatId, text)       打到 stdout
 *   sendMedia(chatId, files) 只打印路径（终端没法显示图，不假装能发）
 *   resolveIdentity(raw)     认人：拿配置里的 ownerId 比对
 *   limits()                 终端没有平台限额，给一个宽松值
 *
 * 可选方法按契约降级：
 *   sessionOf() 固定返回一个会话 id，不维护映射表
 *   probe() 说明自己是什么
 *
 * 用法：
 *   node adapters/cli/run.mjs                 # 交互式
 *   echo "你好" | node adapters/cli/run.mjs   # 单条
 *
 * 存在意义：core 与 heartbeat 只调 channel 契约。能换一个通道跑通，
 * 就说明"解耦"不是写文档时的想象——这是第二个实现，不是第二个说法。
 */
import readline from 'node:readline'
import { cfg } from '../../core/lib/config.mjs'

const SESSION_ID = 'cli:main'

/** 把一行文本包成 core 认识的标准事件 */
function toEvent(line, identity) {
  return {
    channel: 'cli',
    chatId: 'cli:main',
    senderId: identity.id,
    senderName: identity.name,
    text: line,
    media: [],
    at: Date.now(),
    raw: { line },
  }
}

const adapter = {
  label: 'cli',

  /** 收消息：逐行读到 EOF；Ctrl-C 结束 */
  async receive(handler) {
    const me = adapter.resolveIdentity({})
    const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY })

    let closed = false
    const pending = new Set()
    const done = new Promise((resolve) => {
      rl.on('line', (line) => {
        const text = line.trim()
        if (text === '') return
        if (text === '/exit' || text === '/quit') { rl.close(); return }
        // 每条消息一个 promise，关流时统一等
        const job = (async () => {
          try {
            await handler(toEvent(text, me))
          } catch (e) {
            process.stderr.write('[cli] 处理失败: ' + (e?.message ?? e) + '\n')
          }
        })()
        pending.add(job)
        job.finally(() => pending.delete(job))
      })
      rl.on('close', async () => {
        closed = true
        await Promise.allSettled([...pending])
        resolve()
      })
    })

    // 返回一个"取消订阅"函数，与契约一致；额外挂 done 让调用方能等流结束
    const cancel = async () => {
      if (!closed) rl.close()
      await done
    }
    cancel.done = done
    return cancel
  },

  /** 发文本：直接写 stdout，长文本按行切 */
  async send(_chatId, text) {
    const s = String(text ?? '')
    if (s.trim() === '' ) return []
    process.stdout.write(s.endsWith('\n') ? s : s + '\n')
    return ['cli']
  },

  /** 发媒体：终端显示不了，明确说清楚而不是假装成功 */
  async sendMedia(_chatId, files) {
    const list = Array.isArray(files) ? files : [files]
    for (const f of list) {
      const p = typeof f === 'string' ? f : (f?.path ?? f?.url ?? '')
      process.stdout.write('[媒体] ' + p + '（终端不显示，文件已在磁盘）\n')
    }
    return ['cli']
  },

  /** 认人：配置里 ownerId 匹配就是使用者 */
  resolveIdentity(raw) {
    const id = String(raw?.id ?? raw?.userId ?? cfg.identity?.ownerId ?? 'local')
    const isOwner = cfg.identity?.ownerId ? id === String(cfg.identity.ownerId) : true
    return {
      id,
      name: cfg.identity?.ownerName || 'local',
      isOwner,
      isSelf: false,
      label: '终端',
    }
  },

  /** 终端没有平台限额 */
  limits() {
    return { maxTextChars: 4000, maxMediaBytes: 64 * 1024 * 1024, minIntervalMs: 0 }
  },

  // ── 可选 ──
  sessionOf() { return SESSION_ID },

  sessions: {
    get: () => SESSION_ID,
    set: () => true,
    heal: () => false,
    newest: () => SESSION_ID,
    lastActivityMs: () => 0,
  },

  probe() {
    return { channel: 'cli', ok: true, detail: '终端通道（stdin/stdout）' }
  },

  hints() { return [] },
  mediaDir() { return '' },
  logs() { return '' },
}

export default adapter
