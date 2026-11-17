# dsh-persistent-agent

**版本 1.0.0** · 见 [CHANGELOG](CHANGELOG.md) · 0.99 表示核心结构定了、接口还会动

> **一个能长期活着的 agent**：不是"一问一答的模型"，有记忆，有规则，还会自己醒过来。
> 核心与通道解耦。今天接 QQ，明天接 Web 或终端，换的是适配器，不是核心。
>
> 这个仓库只发布**机制**：分层提示词与记忆结构，加上心跳与日记循环，还有生图和语音两条管线。
> 不含具体人格、使用者身份或私人数据。那些由使用者自己填。

---

---

## 它能做什么

先看这张表。每一行都是仓库里已经能跑的东西，不是规划。

### 说话

| 能力 | 怎么用 |
|---|---|
| 在 QQ 里聊天（私聊、群、@） | 接一个 OneBot 11 协议端，配 `channels.onebot` |
| 在终端里聊天（不要协议端） | `node adapters/cli/run.mjs` |
| 一次说多句话，自动分段 | 自动：超过通道字数上限就切开 |
| 该闭嘴时闭嘴 | 回复 `[SILENT]`，适配器直接丢弃这条 |

### 记得住

| 能力 | 怎么用 |
|---|---|
| 长期事实 | `memory/MEMORY.md`，按小节追加 |
| 规矩 | `memory/管规.md`，每轮注入提示词 |
| 日记 | `heartbeat.diary`，每天定一个时刻写 |
| 语义检索（不用把全部记忆塞进上下文） | 自动：`memory-index.json` 增量索引 |
| 技能（正文按需加载，只注入索引） | `skills/*.md`，一行标题 + 一句话 |

### 自己开口

| 能力 | 怎么用 |
|---|---|
| 定时醒来自查 | `heartbeat.intervalSec`（默认 4 小时 + 随机抖动） |
| 有事件时被打断 | `ctx.heartbeat.notify({ type, reason })` |
| 夜里不吵人 | `heartbeat.quietHours` |
| 判断"这次不用说" | 它自己决定，输出 `[SILENT]` 就跳过 |
| 写日记并推送 | `heartbeat.diary` + `heartbeat.diaryPush` |

### 出图

底层是 ComfyUI（HTTP 调用）。模型自备。

| 能力 | 命令 |
|---|---|
| 文生图 | `node tools/anima.mjs --prompt "..." --go` |
| 二次采样（先出小图再放大重画） | `node tools/hires-anima.mjs --image x.png --go` |
| 图生图 / 局部重绘 | `node tools/img2img.mjs --image x.png --rect ... --prompt "..." --go` |
| 超分 | `node tools/upscale.mjs --image x.png --long 2688` |
| 用参考图锁脸重绘 | `node tools/face-edit.mjs`（云端图像通道） |
| 换底模（SDXL 系） | `node tools/sdxl.mjs --prompt "..." --go` |
| 环境体检 | `node tools/draw-check.mjs` |

### 出声

后端是本地 TTS 服务（HTTP），模型自备。

| 能力 | 命令 |
|---|---|
| 文字转语音（多声线） | `node tools/feiyu-tts.mjs "内容" --style gentle` |
| 说完直接发 QQ 语音 | 同上加 `--send` |
| 说话 + Live2D 口型同步 | `node tools/speak.mjs "内容"` |
| 切表情 / 动作 | `node tools/face.mjs <情绪>`、`node tools/move.mjs <动作>` |
| 唱歌（按谱） | `node tools/sing.mjs`（需要 SVS 后端） |

### 管得住

| 能力 | 怎么用 |
|---|---|
| Web 控制台 | `/dsh-agent-core/panel`（只绑 loopback，非回环 403） |
| 体检（36 项） | `node tools/checks.mjs` |
| 清理旧会话 / 旧心跳 | `node tools/tidy.mjs`、`node tools/prune-heartbeat.mjs` |
| 加一条规矩 | `node tools/rule.mjs add "..."` |
| 导出对话轨迹做数据集 | `node tools/compact.mjs` |

### 想改它之前先看哪里

| 你想做的事 | 看这个文件 |
|---|---|
| 加一条规矩 / 改语气 | `persona-template/管规.md`、`语气卡.md` |
| 换模型 / 换端口 | `agent.config.example.json` |
| 加一个工具 | `docs/EXTENDING.md` 的「加工具」 |
| 加一个通道 | `docs/EXTENDING.md` 的「新增通道适配器」 |
| 搞清楚提示词怎么拼的 | `docs/LOGIC.md` |
| 为什么这么设计 | `docs/DESIGN.md`（13 条 ADR） |

### 明确做不到

- 没有官方模型就出不了图，没有 TTS 模型就出不了声 —— 这个仓库不带模型
- 只有一个真的 IM 适配器（QQ）；终端那个是验证用的最小实现
- 不会替你操作第三方账号（点赞、评论、下单这些要自己写适配器）

## 它解决什么问题

| 问题 | 这个包的做法 |
|---|---|
| 人格被长对话稀释 | 三层提示词 + 每轮注入的身份锚点 |
| 记忆越写越乱 | 规则 / 长期事实 / 性格 / 日记分文件，各有唯一来源 |
| agent 只在被叫时存在 | 心跳：定时唤醒 → 判断要不要说话 → 写日记 |
| 上下文爆掉后人格设定就没了 | 压缩时先保住稳定层，工具结果先瘦身 |
| 外部内容能让 agent 变成别人的 | 入站消毒 + 出站拦截 + 规则层，三层防护 |
| 换个 IM 就要重写一遍 | 核心只依赖 **7 条适配器契约**，不依赖 OneBot |

---

## 架构：借鉴了什么，独创了什么

### 借鉴 Hermes 的分层（无代码复制）

Hermes 是个 Python agent 运行时，仓库地址与许可待核实，本项目只引用它的设计思路。它把系统提示拆成
`stable` / `context` / `volatile` 三层，并按不同节奏重建。我们把这个形状照搬过来、
用 **DSH 插件原语重新实现**（Python 单体 → Node/Cordis 插件，数据结构完全不同，未复制任何源码）：

| Hermes 的做法 | 我们的实现 | 差异 |
|---|---|---|
| 三层提示词 + 注入顺序 | `core/lib/tiers.mjs`：`context` / `volatile` / `stable` | 增加**每轮必带的身份锚点**（锚点进 volatile，避免被压缩吞掉） |
| memory provider + FTS 检索 | `core/lib/memory.mjs` + `memory-index.json` | 索引按 mtime 增量重建，不常驻进程 |
| skills 索引只注入"名字 + 一句话" | `core/lib/skills.mjs` | 正文只在调用时读，避免每轮占上下文 |
| cron 当一等公民 | `core/lib/jobs.mjs`：`jobs.json` + 60 秒 tick | 与心跳共用 tick，不额外起调度器。**任务只执行动作，"该不该开口"由心跳判断** |
| `trajectories` → ShareGPT | `core/lib/trajectory.mjs` | 导出为对话对，便于做数据集 |

第三方许可与"未复制代码"的证据见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)（Hermes 一行写明：只引用思路与被引用的行号）。

### 独创：心跳（heartbeat）

调度这件事 Hermes 有，cron 语义我们借鉴了。「**定时醒来后自己判断要不要说话、不说就静默**」这一层是我们自己加的。
一个只在被叫时才存在的 agent，不算"活着"。

**它做什么**（`heartbeat/lib/index.js`）

```
每 intervalSec（默认 4h）+ 随机 jitter（0–20min，不让你抓准规律）醒一次
  ↓
喂"今天的材料"：时间、天气、最近对话、待办、上一次日记的尾巴
  ↓
它自己判断：现在该不该说话
  ├─ 不该说 → 整条回复只输出 [SILENT]，宿主丢弃这条消息（不打扰人）
  └─ 该说   → 正常回一句，走通道适配器发出去
  ↓
每天 23:40 写日记（追加到同一个文件，不建按天文件）
  ↓
23:50–23:58 之间随机一分钟把那本日记推给使用者
```

**四个设计决定**

| 决定 | 为什么 |
|---|---|
| **静默靠 `[SILENT]` 这个输出** | 由它自己判断"现在没必要说话"，不由外部规则硬卡 |
| **加随机抖动** | 整点唤醒像机械闹钟，一眼就看出来。加了抖动才像临时想起 |
| **安静时段 `quietHours`** | 默认 [1, 9)，跨午夜也支持 |
| **日记只写一本** | 两本会互相看，写出来的东西就往观感上偏。合成一本，写给自己 |

**抢会话保护**：心跳和真人对话共用同一个会话，写日记前要拿锁（默认 180000 ms 超时）。
拿不到就让位，不打断正在进行的对话。

配置全部在 `agent.config.json` 的 `heartbeat` 段，热改即生效（不用重启）。

### 语音：脚本随包，模型不随包

`tools/feiyu-tts.mjs` 是**调用方**，不是模型。它干三件事：提交任务，等状态，取音频。
真正的推理在本地服务里（`POST /v1/speech` → 202 queued → 轮询 → 取 wav）。

后端可选（本项目验证过的两条线）：

| 能力 | 后端 | 许可 | 是否随包 |
|---|---|---|---|
| 说话 / 换声 | [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) 系（含社区微调音色） | Apache-2.0（模型权重另有条款） | ✗ 自备 |
| 歌声合成 | [SoulX-Singer](https://github.com/Soul-AILab/SoulX-Singer) | Apache-2.0 | ✗ 自备 |
| 音色转换 | [RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) / [Applio](https://github.com/IAHispano/Applio) | MIT（Applio 有 NC 变体，需自行确认） | ✗ 自备 |
| 口型同步 | VTube Studio（WebSocket API） | 商业软件 | ✗ 自备 |

**为什么脚本里带"声线"参数**：多声线是这套系统的实用功能（同一句话换语气），
所以 `--style` 是接口的一部分。具体有哪些声线，取决于你后端装了什么模型。

模型权重、LoRA 和素材都在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 里逐条标了许可与
"禁止商用 / 必须附许可全文"的要求。**模型不是代码，不跟着 MIT 走**。

### 生图：工作流指引，不是模型分发

`tools/anima.mjs` 是「给 ComfyUI 递一张工作流图」的脚本。默认工作流：

```
UNETLoader（Anima 底模） + CLIPLoader + VAELoader（qwen_image_vae）
  ↓ 可选 LoraLoader
ModelSamplingAuraFlow(shift 3.0)
  ↓
EmptyLatentImage 896×1152
  ↓
KSampler（er_sde / simple / 30 步 / cfg 4）
  ↓ 可选二次采样
ImageScale(lanczos, ×1.5) → VAEEncode → KSampler(denoise 0.42) → VAEDecode
  ↓
SaveImage
```

**三级参数建议**（`--quality`）：`small` 只用来验链路（12 步、0.5MP），
`normal` 是日常（25–30 步、896×1152），`hires` 出成品（×1.5，denoise 0.42–0.45）。

**思路要点**

- **先固定链路再调参**：工作流跑通一次（`small`），再动步数/cfg，否则分不清是链路错还是参数错
- **cfg 与 LoRA 强度联动**：LoRA 0.85–0.9 时 cfg 4–4.3 最稳；cfg 上到 6 以上容易糊
- **hires 只在 denoise 0.4–0.45 之间有用**：低于 0.35 等于放大，高于 0.55 会重画
- **换底模要重测同一组参数**：不同底模的 cfg 甜点差很多，别照抄

生图模型（Anima / Qwen-Image）**不随包分发**：Anima 是 CircleStone 非商用许可、
LoRA 作为 Derivative 继承该条款，所以只能由使用者自备。见 NOTICES 第五节。

---

## 包结构

```
README.md                 本文件（总入口）
LICENSE                   MIT（代码）
THIRD-PARTY-NOTICES.md    第三方组件 / 服务 / 借鉴项目的许可与义务
agent.config.example.json  使用者配置模板（全占位符）

docs/
  QUICKSTART.md           从零到能跑（先读这个）
  ARCHITECTURE.md         有哪几层，每层的唯一来源是什么
  DESIGN.md               13 条 ADR：为什么这么切，代价是什么
  LOGIC.md                一条入站事件之后到底发生什么（与代码逐条对齐）
  EXTENDING.md            加规则 / 技能 / 工具 / 心跳动作 / 新通道
  PATHS.md                目录怎么被寻址、怎么重新定向
  OPEN-SOURCE.md          开源边界：什么进仓库，什么永远不进
  HEARTBEAT-OPTIONS.md    心跳可调项
  CONSOLE-PLAN.md         控制台面板设计

shared/                   核心与心跳共用：通道契约、配置解析
core/                     通道无关：三层提示词、记忆、技能、任务、面板
heartbeat/                通道无关：tick 调度、日记生成、推送决策
adapters/
  contract.mjs            7 条契约的接口定义
  onebot/                 QQ（OneBot 11）
  cli/                    终端（最小实现，验证核心解耦）
  README.md               适配器怎么写
tools/                    通道无关脚本（生图、语音、Live2D 口型、体检）
patches/                  DSH profile 补丁示例（怎么把包挂进 profile）
persona-template/         人格文件空模板（占位符，自己填）
```

**核心层不认识"群""@"和表情包**。这些只存在于 `adapters/onebot/`。

---

## 三分钟跑起来

```powershell
# 1. 前置：DSH ≥ 0.2.0（实测 0.2.2-rc.3）、Node ≥ 22（实测 v24.16）

# 2. 配置
copy agent.config.example.json agent.config.json
#    填 dshHome / workspace / identity.ownerId / identity.botId
#    接 QQ 再填 channels.onebot.accessToken

# 3. 挂载（把 core/ heartbeat/ 的 patch 合进 profile）
#    参考 patches/ 里的示例

# 4. 人格
#    复制 persona-template/ 到记忆目录，按自己的设定填

# 5. 起通道
#    A. 接 QQ：自备 OneBot 11 实现（5700），确认 DSH 已连上
#    B. 不接 QQ：先把 channels.active 改成 cli，在本机终端里跟她说话
```

完整检查清单与故障表见 [`docs/QUICKSTART.md`](docs/QUICKSTART.md)。

---

## 七个契约（核心唯一依赖）

```js
// adapters/contract.mjs
normalize(raw) → Event            // 通道原始消息 → 标准化事件
send(chatId, text)                // 发文本；长文本自己分段；[SILENT] 丢弃
resolveSession(chatId) → id       // 通道会话 → 宿主会话映射
identity(senderId) → {isOwner}    // 使用者判定读配置，不读昵称
sendMedia(chatId, {type, path})   // 图片 / 文件 / 语音（可选）
rateLimit(chatId) → allow|deny    // 频控与配额（可选）
preamble(event) → text            // L0 注入点：语气卡贴在正文正上方（可选）
```

新增一个通道 = 实现这三个必选方法，核心一行不改。见 [`docs/EXTENDING.md`](docs/EXTENDING.md)。

---

## 脱敏约定

包内所有本机专属值都是占位符，运行时从 `agent.config.json` 解析：

| 占位符 | 含义 | 例子 |
|---|---|---|
| `{{LOCAL_PATH}}` | 本机绝对路径（数据目录、工作区、模型目录） | `C:\Users\你\.dsh` |
| `{{OWNER_ID}}` / `{{BOT_ID}}` | 使用者 / 机器人身份（QQ 号、user id 或用户名） | — |
| `{{OWNER_NAME}}` / `{{BOT_NAME}}` | 使用者 / 机器人显示名 | — |
| `{{CONTACT_NAME}}` | 第三方联系人名（示例用） | — |
| `{{CHAT_ID}}` | 会话 / 群标识（与通道相关） | — |
| `{{ADAPTER_TOKEN}}` / `{{API_KEY}}` / `{{SECRET}}` | 通道令牌、模型密钥 | — |
| `{{INSTITUTION}}` / `{{CITY}}` / `{{WEIGHT}}` / `{{VALUE}}` / `{{PHONE}}` / `{{EMAIL}}` | 机构、城市、身体数据、联系方式（仅在示例文本里出现） | — |

**自查**：仓库根目录的 `scan-privacy.mjs` 与 `pack-oss.mjs` 是构建工具，**不进发行包**；
本包生成时已对产物做过脱敏扫描，结果写在 `DESERIALIZE`/`DESENSITIZE.md`（0 高危）。

---

## 第三方与致谢

完整清单与许可义务见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)，可读版见 [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md)。

三类关系的区分：
- **随包分发的代码** —— 只有本仓库自研部分；第三方向来以接口调用或补丁形式使用
- **运行时调用、不分发**：ComfyUI、CosyVoice、SoulX-Singer、RVC/Applio，以及协议端（NapCat / LLOneBot / Lagrange）
- **仅借鉴设计、未复制代码**：若干社区项目，借鉴点逐条列明

---

---

## 模型、素材与内容边界

### 仓库里没有的东西

| 类别 | 状态 |
|---|---|
| 模型权重（底模 / VAE / 文本编码器） | **0 个** |
| LoRA | **0 个**（风格 LoRA 由社区作者训练，使用者自备） |
| 训练/参考素材、生成图 | **0 个** |
| 音色模型、语音权重 | **0 个** |

仓库里全是代码和文档，最大文件 54 KB（`core/lib/panel.html`）。

### 关于风格 LoRA

生图那块调用的风格 LoRA **不是本项目的产物**，是社区作者训练的。所以：

- 不要指望 clone 下来就能出图，模型得自己下、自己放
- 它的许可跟着它自己的发布页走，通常继承底模的非商用条款
- 商用前先看它的 LICENSE；改过的版本不能继续用原作者的名字

### 生成内容的责任

工具是通用的，出来什么由使用者决定：

- 仓库里不带提示词预设。提示词是使用者跟模型之间的事，写什么、留不留，都不在这个仓库的范围内
- 生成的图像和音频，版权与合规责任在使用者。不同平台、不同地区规则不一样
- 拿别人的脸、声音，或者把某个人做成素材之前，先拿到对方同意。这一条没有例外
- 底模自己的使用条款优先于本项目的 MIT

### 底线

代码可以随便改。模型不行。别人训练的权重，不会因为放在你机器上就变成你的。

## 边界声明

- **通道适配器不在本包内**。QQ 需要自备 OneBot 11 实现；该实现的许可、稳定性与账号风险由使用者承担。
- **模型不在本包内**。提示词按 OpenAI 兼容接口组织，可接任意后端；图像 / 语音需要本地推理环境（且各有许可限制，尤其图像模型多为非商用）。
- **人格不在本包内**。`persona-template/` 只有空模板。
- 本项目与 DeepSeek、腾讯、B 站及任何协议端项目均无隶属关系。

---

---

## 作者与贡献者

- **dsh-persistent-agent contributors**：架构、核心插件、心跳、工具链、文档
- **coolsnacpai**（[yuzi-console](https://github.com/coolsnacpai/yuzi-console)）—— **工作台雏形作者**：控制台的信息结构、分区骨架与命名习惯

详见 [`AUTHORS.md`](AUTHORS.md)。第二位版权人同样出现在 `LICENSE` 里（MIT 要求保留每位版权行）。

---

## 许可

- 代码：**MIT**（见 `LICENSE`）
- 文档：**CC BY 4.0**
- 第三方依赖、模型与素材：各自遵循原始许可，见 `THIRD-PARTY-NOTICES.md`
