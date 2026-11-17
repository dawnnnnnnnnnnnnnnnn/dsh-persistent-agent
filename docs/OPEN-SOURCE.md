# 开源边界：什么进仓库，什么永远不进

## 一、一句话原则

**代码和架构进仓库，人和关系不进仓库。**

别人拿去能跑起来一套"自己的"{{BOT_NAME}}，但拿不到关于你的任何一个字。

## 二、进仓库（白名单，`pack-oss.mjs` 里写死）

| 路径 | 内容 | 为什么要 |
|---|---|---|
| `plugins/dsh-agent-core/lib` | 三层提示词、记忆检索、任务、控制台页面 | 核心架构 |
| `plugins/dsh-agent-core/scripts` | 自测 | 让别人能验证 |
| `plugins/dsh-qq-heartbeat/lib` | 心跳、日记、记忆整理 | 核心机制 |
| `tools/*.mjs` | QQ/B站工具（qq-api、notify、report、meme-learn、checks、restart…） | 能力层 |
| `agent-core/*.mjs` | doctor、session-guard、audio-watch、轨迹导出、日报推送 | 自愈层 |
| `docs/` | 架构、路径、控制台计划 | 让别人看懂 |
| `persona-template/` | **空白**人格模板 + 配置模板 + apply-config | 让他填自己的 |

出包实测：**43 个文件，0 敏感命中**。

## 三、永不进仓库

| 内容 | 在哪 | 为什么 |
|---|---|---|
| 记忆与日记 | `.dsh\memory\`（IDENTITY / PROFILE / MEMORY / JOURNAL / 日记……） | 全是私事 |
| 会话原始记录 | `.dsh\sessions\` | 原文 |
| 会话映射与配额 | `.dsh\media\onebot\` | 含 QQ 号 |
| 表情包库 | `.dsh\<某目录>\stickers\`（体积大） | 版权 + 体积 |
| 二进制 | `.dsh\bili-whale\bin\`（100 MB） | 体积 |
| 日志 | `*.log` | 含对话片段 |
| 补丁里的真实值 | `patches\` 的副本会脱敏后才进包 | 令牌/路径 |

## 四、脱敏机制

出包时对**副本**做替换，运行中的文件一个字节都不动：

```
真实使用者 ID        → {{OWNER_ID}}
真实机器人 ID      → {{BOT_ID}}
真实本机路径        → {{LOCAL_PATH}}
<协议端令牌>        → {{ADAPTER_TOKEN}}
群号九连          → {{CHAT_ID}}
{{OWNER_NAME}}/{{CONTACT_NAME}}/{{BOT_NAME}} → {{OWNER_NAME}} / {{CONTACT_NAME}} / {{BOT_NAME}}
```

包生成后自动跑一遍扫描，命中项写进 `DESENSITIZE.md`。**扫描没通过就等于不该发。**

## 五、使用者怎么用这个包

```bash
# 1. 复制配置模板
cp agent.config.example.json agent.config.json

# 2. 填：使用者 QQ、机器人 QQ、NapCat 令牌、家目录
# 3. 把占位符换成自己的值
node apply-config.mjs
node apply-config.mjs --check     # 确认没有残留

# 4. 填人格
#    persona-template\ 里那几份（IDENTITY/PROFILE/MEMORY/管规/语气卡）照格式写自己的
# 5. 装插件
dsh plugin --profile web add link:<...>/plugins/dsh-agent-core
dsh plugin --profile web add link:<...>/plugins/dsh-qq-heartbeat
```

## 六、发布前的人工检查（我做不了的部分）

- [ ] 有没有把 `.dsh\sessions\` 或 `memory\` 误拷进 `dist\`
- [ ] `DESENSITIZE.md` 是否写着"没有命中"
- [ ] 有没有新的硬编码值（新写的脚本要过一遍 `--scan-only`）
- [ ] LICENSE 与出处（借鉴了 Hermes 的分层思路，要在 README 里说明）

## 七、承认借鉴

- **提示词分层（stable / context / volatile）、记忆整理（consolidation）** 的思路来自 Hermes Agent
- **控制台的视觉与结构** 参考玉子控制台 v0.3.10
- 两者都不是本项目的代码，README 里要写清楚
