# 从零到能跑

[安装] ｜ [架构](ARCHITECTURE.md) ｜ [设计决策](DESIGN.md) ｜ [运行时](LOGIC.md) ｜ [扩展](EXTENDING.md)

目标：一台机器上跑起一只有人格、有记忆、会自己醒来的持久 agent。**通道是可选的** —— 先在本机
CLI / Web 里跟她说话就能用，想接 IM 再接。

## 一、前置

| 项 | 要求 | 本仓实测 |
|---|---|---|
| DeepSeek Harness（DSH） | ≥ `0.2.0` | `0.2.2-rc.3` |
| Node.js | ≥ `22`（插件 `engines.node` 声明；通道插件与视觉插件都在 22+） | `v24.16.0` |
| 操作系统 | 跨平台；自带自愈脚本（`.ps1` / 计划任务）仅 Windows | Windows 11 |
| 模型 | 需要能读长上下文；**要发图/看图**还得有视觉模型与图像查看工具 | — |
| 通道 | 可先不接。要接 IM 时再准备一个 OneBot 11 实现（可选） | — |

`dsh --version` 先确认第一条。版本过低时宿主会拒绝加载插件（`engines.dsh` 门禁）。

## 二、目录放置

```
{{DSH_HOME}}/                     默认 ~/.dsh（DSH 的家目录，插件按它寻址）
  ├─ plugins/dsh-agent-core/      核心：提示词三层 / 索引 / 任务 / 控制台
  ├─ plugins/dsh-qq-heartbeat/    核心：心跳 / 日记 / 整理
  ├─ agent-core/                  ← 首次运行自动创建（派生产物）
  └─ memory/                      ← 人格与记忆，**你自己填**（见下）
{{WORKSPACE}}/                    解包后的仓库根（出包仓库另存，与运行时用链接或复制关联）
```

**不要**把 `memory/` 放进仓库、不要提交、不要外发。它是这台机器上唯一不可再生的东西。

人格文件按 `persona-template/` 里的空模板填：`IDENTITY.md`（我是谁）、`PROFILE.md`（对面是谁）、
`MEMORY.md`（长期事实）、`管规.md`（`N. ` 编号的硬规则）、`语气卡.md`（L0 语气）。`AGENTS.md` 可留空 ——
它只贡献「红线」小节，规矩请写进 `管规.md`。

## 三、填配置

```bash
cp persona-template/agent.config.example.json agent.config.json
# 编辑 agent.config.json，然后：
node apply-config.mjs            # 把 {{占位符}} 换成你的值
node apply-config.mjs --check    # 必须输出「没有剩余占位符了」
```

| 键 | 占位符 | 填什么 |
|---|---|---|
| `ownerQQ` | `{{OWNER_QQ}}` | **使用者**的账号 id（唯一被认作使用者的那个） |
| `botQQ` | `{{BOT_QQ}}` | agent 自己的账号 id |
| `napcatToken` | `{{NAPCAT_TOKEN}}` | 通道端的 access token（键名沿用历史命名，含义是「通道 token」）；不接通道可留空 |
| `home` | `{{HOME}}` | 家目录绝对路径，脚本按它拼 `~/.dsh/...` |
| `ownerName` | `{{OWNER_NAME}}` | 使用者的称呼（会被写进提示词） |
| `botName` | `{{BOT_NAME}}` | agent 的名字 |
| `friendName` | `{{FRIEND_NAME}}` | 第三人的占位称呼（没有就留默认） |
| `groupId` | `{{GROUP_ID}}` | 默认群 id；不用群填 `0` |

运行期还有两份配置，控制台可直接改（**改完不用重启**）：

- `{{DSH_HOME}}/agent-core/config.json`：`refreshMinutes`(5) / `indexHours`(1) / `searchK`(5) / `enabled`
- `{{DSH_HOME}}/qq-heartbeat.config.json`：`intervalSec`(14400) / `jitterSec`(1200) / `quietHours`([1,9]) /
  `diary.{hour,minute,style,maxChars}` / `diaryPush.{startMinute,endMinute}`

两份文件都按「缺字段有默认、越界自动夹紧、坏 JSON 不崩」处理，写错不会炸，但会静默用默认值。

## 四、装插件并启动

```bash
dsh plugin --profile web add link:{{WORKSPACE}}/core        # dsh-agent-core
dsh plugin --profile web add link:{{WORKSPACE}}/heartbeat   # dsh-qq-heartbeat
# 重启宿主一次
```

起来之后：

- 控制台 `http://127.0.0.1:3080/dsh-agent-core/panel`
- 三层原文 `GET /dsh-agent-core/tiers`
- 状态 `GET /dsh-agent-core/status`

**不接任何通道也能用**：直接在 DSH 的 Web / CLI 会话里跟她说话 —— 人格、记忆、心跳全部照常工作，
只是「主动发消息」这件事没有出口（心跳会判断该不该说话，但发不出去）。

## 五、首次启动检查清单

```bash
node <tools>/checks.mjs --json          # 体检，36 项；任一项 fail 会 exit 1
node {{DSH_HOME}}/agent-core/session-guard.mjs --verbose
curl -s http://127.0.0.1:3080/dsh-agent-core/status
```

- [ ] `/dsh-agent-core/status` 返回 `ok: true`，且 `prompt.chars` > 2000
- [ ] `{{DSH_HOME}}/agent-core/prompt.txt` 存在，里面能搜到「管规」「谁是使用者」「可用的 skill」
- [ ] `prompt.json` 里有 `[身份锚点`（体检项 `persona-anchor`）
- [ ] `alive.json` 的 `at` 是最近 5 分钟内（说明 5 分钟 tick 在跑）
- [ ] `memory-index.json` 的 `chunks` > 0
- [ ] 体检无 fail；尤其 `tiers-inject` / `rules-injected` / `skills-index`
- [ ] 发一句话，回复正常，且**语气卡生效**（一条一句、不加句号）
- [ ] 心跳试跑一次：把 `intervalSec` 改成 60，等 2 分钟看 `qq-heartbeat.log` 出现「已叫醒」
- [ ] `session-guard.mjs --dry` 能打印会话文本量（说明能解压会话日志）
- [ ] 备份：把 `memory/` 整个复制一份到仓库外

## 六、可选：接入 QQ（OneBot 11）

通道是**适配器**，QQ 只是第一个实现。要接的时候：

1. 起一个 OneBot 11 实现（HTTP/WS 均可），记下 `access token` 与端口。
2. 在 DSH 里装对应的通道插件，把 token 填进它的配置；`agent.config.json` 的 `napcatToken` 同步。
3. 让 agent 的账号给使用者发一条消息 —— 通道适配器会写 `{{DSH_HOME}}/media/onebot/chat-sessions.json`
   的 `private:<OWNER_QQ>` 键，值就是宿主会话 id。
4. 确认心跳能读到这个键（`qq-heartbeat.log` 不再出现「跳过：没有绑定」）。
5. 群聊能力（配额、@ 判定、群规）都属于适配器层，配置文件在 `media/onebot/` 下，与人格无关。

**也可以先只在本机 CLI / Web 里跟她说话**，等用得顺了再接通道 —— 人格与记忆完全不受影响，
接通道那天要改的只有适配器。

## 七、常见故障

| 现象 | 真因 | 处置 |
|---|---|---|
| 发图她只回「看不懂」 | 当前模型不支持图片，或没有图像查看工具；图片在消息里只是 `[图片]` 占位 | 换带视觉的模型 / 开视觉路由插件；或在提示词里明确「看不到就直说」 |
| 回复一直不出现、日志无投递 | 通道端没连上，或映射文件为空 → 心跳日志「跳过：没有绑定」 | 先手动发一条消息让适配器写映射；确认 token 与端口 |
| 提示词尾部规则不生效 | 触发上限：`管规.md` 读 20000 字、红线 400 字 / 10 条、档案 6 行、材料 30 行 | 精简前面的条目；把最重要的规则**放前面**；删掉冗余描述 |
| 心跳从不触发 | `enabled: false`；`quietHours` 覆盖了整天；`intervalSec` 被写成巨大值；state 里 `lastAt` 是未来时间 | 看 `qq-heartbeat.log`；把 `quietHours` 改成 `[1,9]`；删 `lastAt` 重来 |
| 记忆文件变乱码 | 用 PowerShell `>` / `Out-File` 写 UTF-8 文件（默认按 ANSI 解码中文） | 用 node 或编辑器写；`.ps1/.cmd` 脚本保持纯 ASCII；文件一律 UTF-8 |
| 日记一晚写好几次 / 推送推了个空文件 | 判定「今天写过没」失效，或指向了旧的分节文件 | 看 `state.lastDiaryDate`；日记只认 `memory/日记/私记.md` 里当天的 `## <日期>` 小节 |
| 她在用户说话时回了空消息 | 写日记/整理任务抢了同一个会话 | 已内置保护（近 3 分钟有写入就跳过）；仍频繁时把 `diary.hour` 挪到更晚 |
| 控制台打不开 / 返回 403 | 所有路由只接受回环；反代传了外部 `Host` 头 | 用 `127.0.0.1` 直接访问；远程请自己套隧道 |
| 三层是空的 / 心跳只有材料没有设定 | `enabled: false`，或 `prompt.txt` 超过 15 分钟没更新（心跳会退回只用材料） | 看 `alive.json` 的 `at`；`POST /dsh-agent-core/act {cmd:'rebuild'}` |
| 任务不跑 | `jobsRunning` 卡住（上一个脚本超时）、或 `jobs-state` 里 `lastDay` 已是今天 | 看 `core.log` 的 `job <id> failed`；手动把该 job 的 `lastDay` 删掉 |
| 整理记忆反复触发 | `.needs-consolidation` 标记没被删（指令要求她自己删，代码不代删） | 手动删标记；或让它下次醒来自行处理 |

## 八、日常操作

| 想干的事 | 怎么做 |
|---|---|
| 改一句规则 | 编辑 `memory/管规.md`，5 分钟内生效 |
| 改语气 | 编辑 `memory/语气卡.md`，下一条消息就生效 |
| 立刻重建三层 | `POST /dsh-agent-core/act {"cmd":"rebuild"}` |
| 立刻重建索引 | `POST /dsh-agent-core/act {"cmd":"index"}` |
| 看这次到底注入了什么 | `GET /dsh-agent-core/tiers` |
| 手动补今天的日记 | `qq-heartbeat.config.json` 里 `diary.forceNow = true`，跑完记得改回 |
| 换通道 | 只动适配器；`memory/` 一个字节都不用改 |
