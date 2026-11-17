# 运行时逻辑

[安装](QUICKSTART.md) ｜ [架构](ARCHITECTURE.md) ｜ [设计决策](DESIGN.md) ｜ **运行时** ｜ [扩展](EXTENDING.md)

全部按当前代码写；与旧文档冲突处标「**代码为准**」。文件名以 `core/lib`、`heartbeat/lib` 为准。

## 一、一条入站事件 → 一次回复
起点是**标准化事件**，不是任何协议的原始报文（QQ / Web / CLI 由各自 adapter 归一）：
```js
{ channel, chatId, senderId, senderName, isOwner, text, media[], quoted, at }
```
1. **adapter 收原始消息** → 消毒显示名（去换行/尖括号/限长）→ 准备 `<user_message …>` 数据边界。
2. **adapter 拼前导**（仅 `isOwner`）：`【先认人】` + 服从文案 + 提醒开关 + 记忆召回 + **L0 语气卡**，全部贴在正文**正上方**。
   语气卡读 `memory/语气卡.md`，按 mtime 缓存，读不到用内置 fallback。
3. **提交宿主**：`sessionController.prompt({ sessionId, mode: 'queue', content: [{type:'text', text}] })`。
4. **宿主组装 system prompt**：stable（`AGENTS.md`）+ adapter 的 section（含 `prompt.txt` 全文，mtime 缓存）+ 工具 schema → 调模型。
5. **模型可能调工具**（读文件、跑脚本、发媒体），结果回到同一轮上下文。
6. **回复** → adapter 的 `send()`；长回复分段；`[SILENT]` 整条丢弃。
7. **落盘**：宿主写 `sessions/<…>/session.<v>.jsonl.zstd`；core 只读这份日志做索引与轨迹。
8. **会话映射**：adapter 维护 `media/<channel>/chat-sessions.json`；换代时 core 记一条血缘。

## 二、context 层拼装顺序（`buildContext()`）
| # | section | 来源 | 上限 / 规则 |
|---|---|---|---|
| 1 | `### 现在（每轮刷新）` | 系统时间 | 到分钟。**代码为准**：随 `prompt.txt` 重建，默认 5 分钟 |
| 2 | `### 你是谁（形象锚点）` | 代码常量（框架行）+ persona/IDENTITY.md | 5 行；外观由人格层注入 |
| 3 | `### 会话交接（自动注入）` | `memory/会话交接.md` | 仅当 mtime < 12 h；读 2600 字 |
| 4 | `### 我们是什么关系` | `memory/关系.md` | 读 1600 字；只取含「我怎么称呼他 / 他怎么称呼我 / 「我」「他」」的 `- ` 行，≤6 行、每行 200 字 |
| 5 | `### 谁是使用者（硬规则）` | 代码常量 | 3 行。**待解耦**：应改由 adapter 的 `identity()` 注入 |
| 6 | `### 管规（必须遵守）` | `memory/管规.md` | 读 20000 字；只取 `/^\d+\.\s/` 行，**不截条数**（曾有第 30/45 条被丢） |
| 7 | `### 他的档案（摘要）` | `memory/PROFILE.md` | 读 2500 字；按关键词（生日/作息/喜欢/不喜欢/在准备/在读/专业/城市）筛，≤6 行、每行 130 字 |
| 8 | `### 今天的材料` | `heartbeat-context.mjs` 子进程 | `execFileSync` 超时 12 s；`fit(lines, 30)` —— 超 30 行留最后 30 行并前置「（更早的记录已压缩）」 |
| 9 | `### 红线（来自说明书）` | `memory/AGENTS.md` | 读 40000 字；只扫 `##` 含 红线/底线/不量化/必须/绝不/禁止 的小节；每条 80 字、总预算 400 字、≤10 条 |
| 10 | `### 最近的记录` | `memory/JOURNAL.md` | `tail 3` 行；只剥列表符，每行 130 字 |
| 11 | 去重 | — | **按行**去重（按数组元素去重无效：材料是 join 出来的一个大元素） |

## 三、volatile 层拼装顺序（`buildVolatile(short = true)`）
| # | section | 来源 | 上限 |
|---|---|---|---|
| 1 | `[身份锚点 · 每轮生效]` | 代码常量 | 4 行，每轮重写 |
| 2 | `### 可用的 skill（要看正文再读文件）` | `<core>/skills/*.md` | 只取 `# 名` + `> 一句`（截 80 字），按 name 排序；**正文不注入** |
| 3 | `### 手上的脚本（skills）` | `<core>/skills/*.mjs` | 仅文件名，排序 |
| 4 | `<memory>` / `<user_profile>` | `MEMORY.md`（≤700 字）/ `PROFILE.md`（前 10 行） | **仅 `short=false`**，默认不注入 |
| 5 | `Profile: web · cwd: <memory>` | 常量 | 1 行 |
| 6 | `Conversation started: YYYY-MM-DD 周X (Asia/Shanghai, UTC+8)` | 当前日期 | 只到日（当天字节稳定） |
| 7 | `[runtime]` | `qq-heartbeat-state.json` / 可选巡检计划 / `情绪/<月>.md` | 心跳距上次 X.X 小时、日记已写到、巡检、最后 3 行拼成 ≤110 字的「最近的我自己」（7 天内） |

## 四、产物与消费者
```js
buildAll(extra = '') {
  context = buildContext(); volatile = buildVolatile(true); volatileFull = buildVolatile(false)
  composed = `<!-- tier:context -->\n${context}\n\n${extra}\n\n<!-- tier:volatile -->\n${volatile}`
  原子写 agent-core/prompt.txt          // 给所有 adapter 读
  原子写 agent-core/prompt.json         // { builtAt, stable:{file,hash}, context, volatile, volatileFull, composed }
  if (sha256(AGENTS.md) != 上次) 写 stable-hash.json
}
```
| 读者 | 读什么 | 条件 |
|---|---|---|
| channel adapter | `prompt.txt` 全文 | mtime 变了才重读 |
| 心跳 | `prompt.txt` | 仅当 mtime 在 **15 分钟**内，否则退回 `heartbeat-context.mjs` 输出 |
| 体检 / 控制台 | `prompt.json`、`/dsh-agent-core/tiers` | 随时 |

## 五、core 注册的是什么（**代码为准**）
两个插件**都不注册模型工具**：`dsh-agent-core` 只有 `inject: ['webServer']`，`dsh-qq-heartbeat` 只有
`inject: ['sessionController']`。模型可见的工具全部由宿主与其它插件提供。core 注册的是 HTTP 路由（仅回环）：
```
GET  /dsh-agent-core/panel|status|tiers|checks|jobs|skills|providers|lineage|search?q=|logs?name=
GET/POST /dsh-agent-core/config          读写心跳与 core 参数（未知键忽略、越界夹紧）
POST /dsh-agent-core/act                 rebuild | index | restart-dsh|qq|both
POST /dsh-agent-core/trajectory          导出会话为 ShareGPT JSONL
```
要加模型工具，见 [EXTENDING](EXTENDING.md) 第三节。

## 六、心跳 tick（60 秒一次，启动 15 秒先跑一次）
```js
tick() {
  if (ticking) return; ticking = true
  try {
    cfg = readJson(qq-heartbeat.config.json, DEFAULTS); if (!cfg.enabled) return
    sid = resolveSession(&cfg.ownerQQ)           // ① 现读映射，兼容 string 与 { session }
    if (!sid) { sid = newestSessionDir() || state.lastSession; 回写映射一次 }
    if (!sid) return log('跳过：没有绑定')
    if (日记到点 && 今天没写 && 今天没触发过) {    // ②
      if (最近 3 分钟有会话写入) return            // 别抢会话
      投递 buildDiaryPrompt(); state.lastDiaryDate = 今天; return
    }
    if (推送窗口到 && 今天没推) {                   // ③
      抽分钟（当天固定，重启不变）；没日记就等下一 tick
      先发 .md 文件（校验 /^OK/m），失败退回纯文本（校验 ✓已推送）；成功才记账; return
    }
    if (存在 memory/.needs-consolidation) { 投递整理指令; return }        // ④
    if (now < lastAt + intervalSec + jitterMs) return log('未到点')      // ⑤
    if (inQuiet(hour, quietHours)) { 只记 lastQuietAt; return }          // ⑥
    material = (prompt.txt 新鲜 ? 它 : heartbeat-context.mjs 输出)        // ⑦
    投递 prompt({ mode: 'queue', text: material + '\n\n---\n\n' + cfg.prompt + testEcho })
    state.lastAt = now; state.lastSession = sid; 重抽 jitterMs             // 成功才记账
  } catch (e) { log('失败（下个 tick 再试）') } finally { ticking = false }
}
```
②③④ 命中时**当轮直接 return**，这次就不叫醒 —— 有意的串行化，不是 bug。

## 七、日记与推送时间线
| 时刻 | 动作 | 判据 |
|---|---|---|
| 每天 23:40 之后 | 触发写日记 | `nowMin >= hour*60+minute` 且 当日小节不存在 且 `lastDiaryDate != 今天` |
| 23:50–23:58 之间某一分钟 | 推送日记 | 当天**只抽一次**分钟数存 state |
| 随时 | 整理记忆 | 标记文件存在即触发；写完后**由她删标记**（代码不代删） |

日记只有一本：`memory/日记/私记.md`，追加 `## <日期> <时间> · <通道>` 小节；`〔不想给你看〕` 段**照发不剥**，只换成可见标注。

## 八、压缩与整理阈值
| 量 | 值 | 行为 |
|---|---|---|
| 会话解压后文本 | ≥ 4,000,000 B | 放 `.needs-consolidation`（JSON：时间 / sessionId / bytes） |
| 同上 | ≥ 9,000,000 B | 额外推一条提醒给使用者 |
| `MEMORY.md` mtime | 12 小时内 | **冷却**：超阈值也不放标记 |
| 标记存在 | 每次心跳 | 让她把长期事实压成 ≤10 行写入 `MEMORY.md`、判断写入 `情绪/<月>.md`，然后删标记 |

## 九、通用任务（`jobs.json`）
`{ id, name, enabled, schedule: {type:'daily',hour,minute} | {type:'every',seconds}, action: {type:'script',path,args,timeoutMs} | {type:'prompt',text}, deliver: 'none'|'qq' }`
tick：启动 20 秒后开始，之后 60 秒一次；`jobsRunning` 为真跳过（防重入）。`isDue`：`daily` 看「今天这个点之后没跑过」，
`every` 看 `lastRunAt + max(60, seconds) <= now`。`deliver:'qq'` 只对 `script` 生效（推输出前 300 字）。

## 十、数值速查
| 名字 | 值 | 位置 |
|---|---|---|
| `refreshMinutes` / `indexHours` / `searchK` | 5 / 1 / 5（夹紧 1–60 / 1–24 / 1–20） | `agent-core/config.json` |
| `intervalSec` / `jitterSec` | 14400 / 1200（4 h ± 20 min） | `qq-heartbeat.config.json` |
| `quietHours` | `[1, 9)`，支持跨午夜 | 同上 |
| 心跳 tick / 首跑 | 60000 / 15000 ms | `heartbeat/lib/index.js:506` |
| 任务 tick / 首跑 | 60000 / 20000 ms | `core/lib/index.js:225` |
| 抢会话保护 | 180000 ms | `heartbeat/lib/index.js:258` |
| 心跳材料新鲜度 | 15 分钟 | `heartbeat/lib/index.js:476` |
| 体检项数量 | 36 | `checks.mjs` |

## 十一、代码为准清单
| 说法 | 事实 |
|---|---|
| 「提示词每轮刷新」 | 文件 5 分钟重建一次，adapter 按 mtime 读 |
| 「压缩阈值 1.5 MB」 | 4 MB 警告 / 9 MB 硬提醒 |
| 「日记写两本」 | 只有 `私记` 一本 |
| 「体检 18 / 21 项」 | 36 项 |
| 「`maxChunkChars` 可调」 | 未接线，`chunkText()` 写死 1200 字 |
| 「心跳会自己删整理标记」 | 不会，指令要求她自己删 |
| 「工具由 core 注册」 | core 只注册 HTTP 路由 |
