# adapters —— 通道适配器

core / heartbeat / tools 三层**不认识任何具体的 IM 平台**。
"消息从哪来、怎么发出去、谁是使用者、限额多少" 全部由适配器实现，
核心只认 `core/lib/channel.mjs` 里的契约。

```
core/lib/channel.mjs          ← 契约 + 注册表 + NULL 通道（没装适配器也不崩）
adapters/onebot/index.mjs     ← OneBot 11 / NapCat 实现
adapters/onebot/config.mjs    ← 唯一允许出现 QQ 号 / 群号 / 令牌的地方
adapters/onebot/sessions.mjs  ← 会话绑定映射（上游 chat-sessions.json 的私活）
adapters/onebot/tools/*.mjs   ← 只服务 QQ 的小脚本（发消息 / 空间 / 群管理 / 戳一戳）
```

## 契约（v1.0.0）

必需五个方法，缺一个 `defineChannel()` 直接抛错：

| 方法 | 作用 | 核心层的用法 |
|---|---|---|
| `receive(handler)` | 收消息，归一成标准事件，返回 `unsubscribe` | 收到事件 → 交给 agent 会话 |
| `send(chatId, text, opts?)` | 发文本（超长由 `splitText()` 先切开） | `heartbeat` 推送、`jobs` 投递结果 |
| `sendMedia(chatId, files)` | 发图 / 语音 / 文件 | 日记 `.md`、生成的图 |
| `resolveIdentity(raw)` | 认人：`{ id, name, isOwner, isSelf, label }` | `tiers.mjs` 判断"是不是使用者" |
| `limits()` | `{ maxTextChars, maxMediaBytes, minIntervalMs }` | 切片、限流、防打爆 |

可选扩展（有就用，没有核心自动降级）：

| 成员 | 作用 |
|---|---|
| `label` | 通道中性名（`onebot` / `discord`），日记标题用它 |
| `sessionOf(chatId)` | `chatId` → 宿主 sessionId |
| `sessions.{get,set,heal,newest,lastActivityMs}` | 会话绑定的读 / 写 / 自愈 / 最近活动 |
| `probe()` | 健康快照，`/dsh-agent-core/status` 直接透传 |
| `hints()` | 平台特有的提示词小抄（核心层不认识这些工具） |
| `mediaDir()` | 待发媒体的临时目录 |

### 标准事件

```js
{
  chatId: 'group:123' | 'private:456',   // 通道自己的寻址串
  userId: '456',
  text: '纯文本部分',
  media: [{ type: 'image', data: {...} }],
  at: Date,
  raw: { /* 原始事件，调试用 */ }
}
```

### 注册

```js
import { registerChannel } from './core/lib/channel.mjs'
import onebot from './adapters/onebot/index.mjs'

registerChannel(onebot)          // 之后 core / heartbeat 立刻走这个通道
```

不注册也能跑：`getChannel()` 返回一个 NULL 通道，
`send()` 会抛一条"没有注册适配器"的明确错误，其它调用返回空值 —— 不会因为缺通道把宿主拖崩。

## 写一个新适配器

1. 新建 `adapters/<name>/index.mjs`，导出带上面五个方法的对象；
2. 平台的身份 / 令牌只放在 `adapters/<name>/config.mjs`，**别写进 core**；
3. 用 `defineChannel()` 自检一遍（它会把缺的方法名报出来）；
4. 在 `agent.config.example.json` 里加一段 `<name>: { ... }` 示例。

## 自检

```bash
# 契约齐不齐
node -e "import('./core/lib/channel.mjs').then(async m=>{const a=await import('./adapters/onebot/index.mjs');m.defineChannel(a.default,{label:'onebot'});console.log('ok')})"

# core 里不许出现的词（出现就是耦合）
grep -rnE 'onebot|QQ|群|私聊' core/ || echo "core 干净"
```
