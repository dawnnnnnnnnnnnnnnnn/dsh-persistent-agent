# dsh-agent-core

给 DSH 里的 agent 补上 **Hermes 式的一层**：三层提示词、记忆检索、会话血缘、规则体检、通用任务、轨迹导出，外加一个自带控制台。

> 只动你自己的插件，不改 DSH 内核，也不碰任何别的插件。

## 它解决什么

DSH 默认把会话、提示词、调度都管起来了，但**没有**这些能力：

| 缺口 | 这个插件补的 |
|---|---|
| 提示词只有一大段，改一个字就整段重算 | **stable / context / volatile 三层**，易变的放最后，前缀尽量不重写 |
| 只靠上下文记忆，没法检索 | **记忆倒排索引** + `/search`（按文件、小节给出来源） |
| 会话换代就断了线索 | **lineage.jsonl** 记录 parent → child |
| 定时任务不可靠 | **jobs.json 通用任务**（daily / every，可跑脚本或投递提示词） |
| 规则写在文档里靠自觉 | **checks 体检**：18 项，任何一项掉了 exit 1，可挂每日任务 + 失败推通道 |
| 没有可看的运行状态 | **独立控制台** `/dsh-agent-core/panel` |

## 安装

```bash
dsh plugin --profile web add link:<本目录>
```

或者从 npm：

```bash
dsh plugin --profile web add dsh-agent-core
```

装完重启一次 DSH。控制台：

```
http://127.0.0.1:3080/dsh-agent-core/panel
```

## 控制台能干什么

- **状态卡**：当前会话、上次心跳、日记进度、今日通道配额、已认会话、索引规模、提示词字数、补丁版本
- **参数调试**：心跳间隔 / 随机抖动 / 安静时段 / 日记时间与开关 —— 保存即生效，不用重启
- **日记更多选项**：文体（散文/短句/信/清单）、每本字数上限、额外主题、写完是否推送、自定义写日记指令
- **心跳提示词**：整段可改，留空用内置默认
- **动作**：重建三层 / 重建索引 / 跑体检 / 重启 DSH / 重启通道
- **三层原文**：直接看这次注入给模型的 context 与 volatile
- **记忆检索**：输入关键词，返回命中的文件 + 小节 + 原文
- **日志**：core / heartbeat / restart / checks / watchdog 五路

> 控制台页面是**每次请求现读**的（`lib/panel.html`），改样式或加按钮，刷新页面即可，不用重启。

## HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-agent-core/panel` | 控制台页面 |
| GET | `/dsh-agent-core/status` | 会话 / 心跳 / 索引 / 补丁 |
| GET/POST | `/dsh-agent-core/config` | 读写心跳与日记参数（越界自动夹紧） |
| GET | `/dsh-agent-core/tiers` | 三层原文 |
| GET | `/dsh-agent-core/checks` | 跑体检，返回差异集合 |
| GET | `/dsh-agent-core/search?q=` | 记忆检索 |
| GET | `/dsh-agent-core/jobs` | 任务列表与上次运行 |
| GET | `/dsh-agent-core/skills` | skills 索引 |
| GET | `/dsh-agent-core/providers` | 记忆 provider 列表 |
| POST | `/dsh-agent-core/trajectory` | 导出某个会话为 ShareGPT JSONL |
| GET | `/dsh-agent-core/logs?name=` | 日志尾巴 |

所有接口**只接受本机回环**（`127.0.0.1` / `localhost` / `::1`）。

## 目录

```
~/.dsh/agent-core/
  prompt.json / prompt.txt   三层产物（给别处读）
  memory-index.json          倒排索引
  lineage.jsonl              会话血缘
  jobs.json / jobs-state.json  通用任务
  config.json                插件自身配置
  skills/                    技能（一个 md 一个技能）
  providers/                 自定义记忆 provider（可选）
  trajectories/              导出的对话样本
  obey.txt                   绝对服从模式的注入文案
  core.log / checks.log / restart.log
```

## 配置

`~/.dsh/agent-core/config.json`：

```json
{
  "enabled": true,
  "refreshMinutes": 5,
  "indexHours": 1,
  "searchK": 5,
  "maxChunkChars": 800,
  "memoryProvider": "builtin"
}
```

心跳与日记的配置在 `~/.dsh/qq-heartbeat.config.json`（由配套插件 `dsh-qq-heartbeat` 读取）。控制台改的就是这份文件。

## 通用任务（对标 cron）

`~/.dsh/agent-core/jobs.json`：

```json
{
  "jobs": [
    {
      "id": "daily-trajectory",
      "name": "每日导出轨迹",
      "enabled": true,
      "schedule": { "type": "daily", "hour": 4, "minute": 10 },
      "action": { "type": "script", "path": "…/export-trajectory.mjs" },
      "deliver": "none"
    },
    {
      "id": "journal-compact",
      "name": "JOURNAL 小步压缩",
      "enabled": true,
      "schedule": { "type": "every", "seconds": 604800 },
      "action": { "type": "script", "path": "…/compact.mjs" },
      "deliver": "qq"
    }
  ]
}
```

- `schedule.type`：`daily`（时+分）或 `every`（秒）
- `action.type`：`script`（跑 node 脚本）或 `prompt`（往当前会话投一段话）
- `deliver`：`channel` 把脚本输出推到当前通道（走 adapters/ 的契约），`none` 只进日志

## 记忆 provider（可替换）

默认 `builtin`（倒排索引）。想换后端：在 `providers/` 放一个 md? 不，放 `.mjs`：

```js
export function index(memoryDir) { /* 返回你的索引结构 */ }
export function search(built, query, k) { /* 返回 [{file, heading, text, score}] */ }
```

然后 `config.json` 里把 `memoryProvider` 改成文件名（不带 `.mjs`）。

## 体检

`node ~/.dsh/bili-whale/checks.mjs`

```
✓ 出口不许乱叫使用者        ✓ 他不在的会话不说话
✓ 通道每天最多 10 句      ✓ 重启不再清空映射
✓ 静默 [SILENT] 被吞      ✓ 三层提示词注入
✓ 提示词带「谁是使用者」     ✓ 管规进了提示词
✓ 每轮先认人              ✓ 自建 .ps1 必须纯 ASCII
✓ 会话映射非空            ✓ 补丁快照与版本一致
✓ jobs runner 有任务      ✓ 轨迹导出可用
✓ skills 索引进提示词     ✓ JOURNAL 可压缩
```

`--selftest` 会故意造一个违规，确认检查**真的会报**（检查假 = 装饰）。

## 已知边界

- **前缀缓存**：只保证「前缀尽量不变」，没法插 provider 级缓存断点（宿主不暴露请求结构）。对 DeepSeek 这类自动前缀缓存的服务，效果等价。
- **滚动摘要**：`compact.mjs` 是文件层搬运 + 规则摘要，不是 LLM 摘要。
- **工具级 gating**：DSH 用权限预设，没有逐工具开关。

## License

MIT
