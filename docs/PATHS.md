# 目录与路径（怎么被寻址，怎么重新定向）

## 一、三层路径

```
%USERPROFILE%\.dsh\            运行时根（DSH 插件按这个路径读写，不能随便搬）
  ├─ plugins\                 dsh-agent-core / dsh-qq-heartbeat（代码）
  ├─ bili-whale\              工具脚本 + 数据（stickers/bin 很重）
  ├─ agent-core\              三层产物、任务、技能、轨迹
  ├─ memory\                  人格与记忆（私有）
  ├─ media\onebot\            会话映射、配额
  ├─ patches\                 补丁快照
  └─ sessions\                对话原始记录

%USERPROFILE%\dsh-persistent-agent\        项目根（给人看 / 打包用，全是链接，不复制数据）
  ├─ core\      → .dsh\plugins\dsh-agent-core
  ├─ heartbeat\ → .dsh\plugins\dsh-qq-heartbeat
  ├─ tools\     → .dsh\bili-whale
  ├─ patches\   → .dsh\patches
  ├─ docs\      文档
  ├─ persona-template\  空白人格模板（给别人填）
  ├─ pack-oss.mjs       出开源包
  └─ dist\              出包产物

%USERPROFILE%\.dsh\QQ那只\     浏览入口（六个链接 + README 导航）
```

## 二、为什么用链接而不是搬家

代码里写死了 `~/.dsh/...`（插件、计划任务、系统服务都在用）。**搬一次要改动十几处，任何一处漏了就是深夜失联**。链接让"整理"和"零风险"同时成立：

- 你在 `dsh-persistent-agent\tools\` 里改 `checks.mjs`，改的就是运行时那份
- 你在 `dist\` 里出包，运行时文件一个字节都不动

## 三、要真搬家时的顺序（现在不用做）

1. 先在 `~/.dsh\agent-core\paths.mjs` 里加一层解析：`env XIVI_HOME > config.json > 默认 ~/.dsh`（预留，未启用）
2. 逐个脚本改成 `import { DSH } from './paths.mjs'`，**一次只改一个，改完立刻跑体检**
3. 全部改完后，才允许搬目录，并把旧路径留成 junction 兼容

## 四、开源包里的路径

出包时会把绝对路径换成占位符：

| 原值 | 包里 |
|---|---|
| `%USERPROFILE%` | `{{HOME}}` |
| 使用者 QQ | `{{OWNER_QQ}}` |
| 机器人 QQ | `{{BOT_QQ}}` |
| NapCat 令牌 | `{{NAPCAT_TOKEN}}` |
| 群号 | `{{GROUP_ID}}` |
| 人名 / 机器人名 | `{{OWNER_NAME}}` / `{{BOT_NAME}}` / `{{FRIEND_NAME}}` |

使用者填 `agent.config.json` → 跑 `node apply-config.mjs` → 占位符被替换成他自己的值。
