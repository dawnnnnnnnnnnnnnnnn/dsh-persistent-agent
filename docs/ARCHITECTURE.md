# 架构

[安装](QUICKSTART.md) ｜ **架构** ｜ [设计决策](DESIGN.md) ｜ [运行时](LOGIC.md) ｜ [扩展](EXTENDING.md) ｜ [路径](PATHS.md)

一个长期运行的**陪伴型 agent**：常驻、有人格、有记忆、会自己醒来。**与通道无关** —— 它不「属于」任何
一个 IM；任何通道都只是把消息喂进来、把回复发出去的一个适配器。三层依赖单向：`runtime` → `adapters` → `core`。
## 一、总览
```
┌──────── adapters（通道适配，可替换、可并存）─────────┐
│ OneBot 11 · Web · CLI · 未来任一 IM                  │
│ 收消息→标准化事件 · 发消息 · 发媒体 · 身份 · 限流 · L0│
└───────────────────────┬──────────────────────────────┘
                        │ 标准化事件 / 发送原语
┌───────────────────────┴──────────────────────────────┐
│ core（通道无关）：提示词三层 · 记忆与索引 · 心跳调度  │
│                   日记与整理 · 通用任务 · 控制台      │
└───────────────────────┬──────────────────────────────┘
                        │ system prompt section / 工具面
┌───────────────────────┴──────────────────────────────┐
│ runtime（DSH 宿主）：模型 · 工具 · 会话 · webServer   │
└──────────────────────────────────────────────────────┘
```
`core` 里不该出现「群」「@」这类词；出现即是耦合缺陷，见第十二节。
## 二、三层职责
| 层 | 负责 | 不负责 | 现在落在哪 |
|---|---|---|---|
| **runtime** | 模型调用、上下文压缩、工具注册表、会话持久化、HTTP 服务 | 人格从哪来、何时醒 | DSH 宿主（不改内核） |
| **adapters** | 消息 ↔ 事件、发送原语、身份与权限、频控、把 L0 语气卡贴到正文上方 | 记忆、规则、何时说话 | 通道插件（QQ 只是其一） |
| **core** | 三层提示词、记忆索引与检索、会话血缘、心跳与日记、通用任务、控制台 | 任何通道协议细节 | `dsh-agent-core` / `dsh-qq-heartbeat` |

**为什么这么切**：陪伴型 agent 的成本几乎全在「给模型看什么」和「记住什么」，这两件事与通道无关；
换通道时该改的是 30 行适配器，不是人格和记忆。
## 三、通道适配器契约
`core` 只依赖这 7 条，不依赖任何具体协议。

| # | 契约 | 必须 | 语义 |
|---|---|---|---|
| 1 | `normalize(raw) → Event` | ✅ | 通道原始消息 → 标准化事件（见下） |
| 2 | `send(chatId, text)` | ✅ | 发一条文本；长文本自己分段；`[SILENT]` 整条丢弃 |
| 3 | `resolveSession(chatId) → sessionId` | ✅ | 通道会话 → 宿主会话映射，换代自己跟住 |
| 4 | `identity(senderId) → {isOwner, displayName}` | ✅ | 使用者判定读**配置**，不读通道昵称 |
| 5 | `sendMedia(chatId, {type, path\|url})` | ⬜ | 图片 / 文件 / 语音 / 视频 |
| 6 | `rateLimit(chatId) → allow/deny` | ⬜ | 频控与配额，超限静默丢弃 |
| 7 | `preamble(event) → text` | ⬜ | L0 注入点：语气卡、先认人贴在正文正上方 |

标准化事件（`core` 唯一接受的形状）：
```js
{ channel: 'onebot' | 'web' | 'cli' | '<name>',
  chatId: '<通道内会话 id>',        // 私聊/群聊/终端一律抽象成 chat
  senderId: '<发送者 id>', senderName: '<已消毒的显示名>',
  isOwner: true,                    // 由 adapter 按配置判定
  text: '<纯文本>',
  media: [{ type: 'image', path: '<本地路径>' }],
  quoted: { chatId, senderId, text } | null,
  at: 1700000000000 }
```
**边界**：`core` 收到事件后只做三件事 —— 读写文件、拼提示词、调 `sessionController.prompt()`。
不联网、不碰通道 API、不知道「群」是什么。
## 四、提示词四层
| 层 | 内容 | 谁产出 | 注入位置 | 刷新 |
|---|---|---|---|---|
| **L0 语气卡** | 一条一句 / 不加句号 / 不汇报腔 | `memory/语气卡.md` | adapter 贴在**用户消息正上方** | 每条消息，改文件即生效 |
| **L1 stable** | 长期身份 | `memory/AGENTS.md` | 宿主 system prompt | 宿主决定 |
| **L2 context** | 时间、形象锚点、关系、使用者判定、管规、档案摘要、今日材料、红线、最近记录 | `tiers.mjs` `buildContext()` | `agent-core/prompt.txt` → adapter 作为 section 注入 | `refreshMinutes`（默认 5） |
| **L3 volatile** | 身份锚点、skills 索引、runtime 行 | `tiers.mjs` `buildVolatile()` | 同上 | 同上 |

`prompt.txt` 被**任意** adapter 读成一段 system prompt section（标题「现取材料（每轮自动注入，不是让你复述）」），
按 mtime 缓存。所以「每轮注入」的真实粒度 = 文件重建的粒度。
## 五、文件层与唯一来源
| 层 | 文件 | 只回答一个问题 | 谁写 |
|---|---|---|---|
| **人格层** | `IDENTITY.md`、`PROFILE.md` | 我是谁 / 对面是谁 | 人 |
| **规则层** | `管规.md`（`N. ` 编号行）、`语气卡.md` | 必须怎么做 | 人 / `rule.mjs` |
| **事实层** | `MEMORY.md`、`JOURNAL.md`、`日记/私记.md`、`情绪/<月>.md` | 发生过什么、我判断过什么 | 她自己 |
| **派生层** | `prompt.txt`、`prompt.json`、`memory-index.json`、`lineage-*.json`、`alive.json`、`*-state.json` | —（全部可重算） | core |

**一事情一来源**：身份 → 人格层 + `管规.md`；硬规则 → 只有 `管规.md`（写 `AGENTS.md` 默认不生效，它只抽红线段落）；
语气 → 只有 `语气卡.md`；长期事实 → 只有 `MEMORY.md`；会话绑定 → 各 adapter 自己的映射文件，core 不去「自愈」它。

派生层随时可删了重建；人格层与事实层删了就没了 —— 所以 `session-guard` 动 `MEMORY.md` 前先备份到
`memory/_archive/`（只留 3 份）。
## 六、生命周期
| 周期 | 动作 | 实现 |
|---|---|---|
| **每轮** | 语气卡 + 身份提示 + `user_message` 边界 | adapter（契约 7） |
| **每轮（读）** | 读 `prompt.txt` 当 system section，mtime 变了才重读 | adapter |
| **5 分钟** | 重建 `prompt.txt` / `prompt.json`，写 `alive.json` | `tickTiers` |
| **1 小时** | 重建记忆倒排索引 | `tickIndex` |
| **60 秒** | 心跳 tick：解析会话 → 日记 → 推送 → 整理标记 → 判断该不该醒 | `dsh-qq-heartbeat` |
| **60 秒** | 通用任务 tick（`jobs.json` 的 `daily` / `every`） | `tickJobs` |
| **永久** | 人格与事实文件 | 人 + 她 |

## 七、组件边界
| 组件 | 拿到什么 | 不许做什么 |
|---|---|---|
| **runtime（DSH）** | 模型、工具面、会话、`webServer`、`sessionController` | 不知道人格文件长什么样 |
| **`dsh-agent-core`** | `inject: ['webServer']`；写 `agent-core/` 全部派生文件；注册 `/dsh-agent-core/*` | 不注册模型工具、不 import 任何 adapter |
| **`dsh-qq-heartbeat`** | `inject: ['sessionController']` | 不改提示词内容、不碰 `prompt.txt` |
| **adapter** | 通道 API、配置里的使用者标识 | 不写规则、不判断「该不该主动说话」 |
| **工具脚本层** | 命令行 + 环境变量 | 不做长驻进程 |

所有 HTTP 路由只接受 loopback（`127.0.0.1` / `localhost` / `::1`），非回环一律 403。
## 八、目录
```
{{DSH_HOME}}/                    默认 ~/.dsh
  ├─ plugins/dsh-agent-core/     core：三层 · 索引 · 血缘 · 任务 · 控制台
  ├─ plugins/dsh-qq-heartbeat/   core：心跳 · 日记 · 整理 · 推送
  ├─ plugins/<channel>-*/        adapters：每个通道一个
  ├─ agent-core/                 prompt.json/txt · memory-index.json · lineage.jsonl
  │                              jobs.json · session-guard.mjs · doctor.mjs · logs
  ├─ memory/                     AGENTS · IDENTITY · PROFILE · MEMORY · JOURNAL
  │                              管规 · 关系 · 语气卡 · 日记/ · 情绪/
  ├─ media/<channel>/            各 adapter 的会话映射与配额
  ├─ sessions/                   会话原文（宿主写，插件只读）
  └─ <tools>/                    qq-api / report / checks / restart 等脚本
{{WORKSPACE}}/                    出包仓库：docs/ · core→plugins · heartbeat→plugins
```

## 九、为什么这样分层
1. **改一个字不重算整段**：易变的放最后，时间戳只到日，稳定前缀尽量不动 —— 换前缀缓存命中。
2. **压缩之后设定不漂**：文件记事实，锚点记「我是谁」。任一失效，另一个还兜得住。
3. **规矩必须「在场」**：写在文档里靠自觉等于不生效。规则进 context（5 分钟），语气进 L0（贴脸上）。
4. **通道可替换**：人格与记忆是资产，通道是耗材。耗材换了，资产不能动。
## 十、踩过的坑（都已修，写在这里防回退）
| 症状 | 真因 | 现在 |
|---|---|---|
| 规则写了不生效 | `AGENTS.md` 不进提示词，只有红线段落被抽 | 硬规矩写 `管规.md`，并有体检项盯着 |
| 同一句在提示词里出现两次 | 按数组元素去重，而「今日材料」是几十行 join 成一个元素 | 改为**按行**去重 |
| 记录里的日期变成「:0x」 | 去列表符的正则把行首日期一起吃掉了 | 只剥列表符，不动正文数字 |
| 天冷了没提醒 | 天气按行前缀过滤，数值行不以前缀开头 → 整段被吞 | 只做行数预算（30 行） |
| 一晚写七八次日记 | 判定「今天写过没」查的是按天文件，而日记早已合并成一份 | 查合并文件里的当日小节 + 当日只触发一次 |
| 正在说话时回复是空的 | 写日记任务和用户消息抢同一会话 | 近 3 分钟有会话写入就跳过本轮 |

## 十一、与旧文档不一致（代码为准）
| 旧文档 | 代码 | 结论 |
|---|---|---|
| 压缩阈值 1.5 MB | `WARN_BYTES = 4_000_000`、`HARD_BYTES = 9_000_000` | 以代码为准 |
| `checks.mjs` 21 项 | 实际 36 项 | 以代码为准 |
| 「日记写两本」 | `sections: ['私记']`，只有一本 | 以代码为准 |
| `maxChunkChars` 可调 | `chunkText()` 写死 1200 字阈值，未接线 | 待核实（该键当前无效） |

## 十二、已知耦合（接新通道前要先解掉）
| 位置 | 耦合 | 应改成 |
|---|---|---|
| `dsh-qq-heartbeat` 读 `chat-sessions.json` 的 `private:<OWNER_QQ>` | 直接依赖 OneBot 的映射格式 | adapter 提供 `resolveSession(chatId)` |
| 心跳兜底扫 `sessions/onebot-private-*` | 依赖 OneBot 会话 id 命名 | 同上 |
| 提示词里写死「使用者只有一个：`{{OWNER_QQ}}`」 | 使用者判定挤进 core | 注入 adapter 的 `identity()` 结果 |
| 日记推送调用 `send-file.mjs` / `qq-notify.mjs` | 发送原语写死为某个通道的工具 | 走契约 2 / 5 |
| `group-quota.json` | 「群」概念进了 core | 收敛为契约 6 `rateLimit()` |
