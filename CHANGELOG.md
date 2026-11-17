# Changelog

## 0.99.3 — 早期

### 修正：工具脚本里的占位化

0.99.0 说「不含人格设定」，但生图那几个脚本里还留着具体角色的外观常量。
`persona-template/` 是空的，设定却藏在工具的提示词常量里。

- 两个只为单一角色存在的脚本已删除
- `tools/seed-library.mjs` 的条目改成占位（角色 / 服装 / 场景 / 道具各一条示例）
- `core/lib/tiers.mjs` 的形象锚点改为「由 persona 层的 IDENTITY.md 定义」
- 生图脚本里的角色常量改为从配置 / 环境变量读

### 修正：素材路径

`seed-library.mjs` 里原来引着本机的素材路径。图片字节从未进入仓库，路径已改占位。

## 0.99.2 — 早期

### 文档：README 加「它能做什么」

之前 README 从"架构"讲起，看的人得先理解分层才知道这东西能干什么。现在开头就是功能表，分七组：

说话 / 记得住 / 自己开口 / 出图 / 出声 / 管得住 / 明确做不到

每行写的是"能力 + 怎么用"，命令都是仓库里真实存在的文件（18 条全部核对过路径）。

另加一张导航表：「你想做的事 → 看哪个文件」。给改代码的人一个入口，不用通读。

### 版本

三个 package.json（core / heartbeat / shared）同步到 0.99.2。

## 0.99.1 — 早期

把 0.99.0 里那三条"下一步"做掉了。

### 新增：第二个通道适配器（`adapters/cli/`）

在终端里跟核心对话，不碰任何 IM 协议端：

```bash
node adapters/cli/run.mjs                    # 交互式
echo "在吗" | node adapters/cli/run.mjs      # 单条
node adapters/cli/run.mjs --probe            # 只检查适配器是否合格
```

意义不在功能，在验证：**七条契约够不够用、核心里有没有藏着的 IM 假设**。
只有 onebot 一个实现时，"核心与通道解耦"是设计意图；有两个实现时，它才是事实。

### 变更：`channel` 与 `config` 提成共享包（`shared/`）

原来 heartbeat 用相对路径引 core：

```js
import { getChannel } from '../core/lib/channel.mjs'
```

相对路径出不了 npm 包——单独装 heartbeat 就断了。现在：

```
shared  ←  core
shared  ←  heartbeat
```

core 与 heartbeat **不互相引用**。`core/lib/channel.mjs` 与 `core/lib/config.mjs` 保留一层转发，旧 import 不用改。

### 新增：心跳支持事件触发

之前只有定时（每 4h + 抖动）。现在多了一条路：

```yaml
heartbeat:
  triggers:
    enabled: true
    maxPerHour: 4      # 一小时最多被事件叫醒几次
    cooldownSec: 600    # 两次事件唤醒之间至少隔多久
```

调用方往队列里塞事件，醒不醒仍由心跳决定：

```js
ctx.heartbeat.notify({ type: 'message-idle', reason: '对方 40 分钟没说话' })
ctx.heartbeat.stats()   // { pending, lastWakeAt, hourCount }
```

限流在心跳里做，不在调用方做——**"该不该开口"这件事只有一处判断**。

### 修正

- CLI 适配器：管道模式下 close 早于 handler 完成，回复会丢（改为等 pending 全部落完）
- 心跳：事件块引用了后面才声明的 `st`/`now`，运行时会 TDZ（提前声明）

## 0.99.0 — 早期

首个公开版本。0.99 的意思是：核心结构定下来了，但接口还会动，所以先不承诺兼容。

### 包含

- **核心（`core/`，通道无关）**：三层提示词（context / volatile / stable）、记忆索引与检索、技能索引、通用任务、轨迹导出、控制台面板
- **心跳（`heartbeat/`）**：定时唤醒 + 自我判断要不要说话、安静时段、日记写入与推送、抢会话保护
- **适配器（`adapters/onebot/`）**：QQ（OneBot 11）的收发、群/私聊语义、媒体发送
- **工具（`tools/`）**：生图工作流、语音调用、Live2D 口型、体检与清理
- **文档（`docs/`）**：架构、设计决策、运行时逻辑、扩展指南、快速开始、路径说明、开源边界

### 明确不含

- 模型权重、LoRA、音色模型、素材
- 人格设定（`persona-template/` 只有空模板）
- 任何提示词预设

### 已知限制

- 通道适配器只实现了 OneBot 11 一个
- `maxChunkChars` 读了但没接线（`memory.mjs` 的阈值目前写死 1200 字）
- `rateLimit` 契约留了接口，没有默认策略
- 多通道并存的优先级未定义
- 依赖 DSH ≥ 0.2.0、Node ≥ 22

### 下一步

- 补齐第二个通道适配器（CLI 或 Web），验证"核心不依赖具体 IM"不是口号
- 把 `channel.mjs` 和 `config.mjs` 提成共享包，让 core 与 heartbeat 能独立安装
- 心跳的触发条件从"定时"扩展到"有事件时"
