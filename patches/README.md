# dsh-persistent-agent —— profile 级补丁

把三个东西一起挂进 DSH 的 profile：

1. `core/`（dsh-agent-core）—— 通道无关的那一层
2. `heartbeat/`（dsh-heartbeat）—— 定时 tick / 日记 / 推送决策
3. `adapters/onebot/` —— QQ（OneBot 11 / NapCat）适配器，**可选**：不用 QQ 就整段删掉

## 怎么用

把 `dsh-persistent-agent.cordis.yml` 的内容合并进你的 profile 的 `cordis.patch.yml`
（通常在 `~/.dsh/profiles/<profile>/cordis.patch.yml`），或者作为独立补丁目录放进去。

```bash
# 最省事的做法：直接把两个插件目录链进 profile 的插件搜索路径
ln -s ~/dsh-persistent-agent/core      ~/.dsh/plugins/dsh-agent-core
ln -s ~/dsh-persistent-agent/heartbeat ~/.dsh/plugins/dsh-heartbeat
```

（Windows 用 `mklink /J`；注意：**不要把开源工程目录反向 junction 到现役目录**，
那样往开源工程写文件会直接改到正在运行的插件 —— 本项目踩过这个坑，见
`docs/SYNC-REPORT.md` §8。）

## 顺序

1. `core` 先起（它负责 tiers / 记忆索引 / 会话血缘 / 控制台）
2. `heartbeat` 后起（它依赖 `core/lib/channel.mjs` 的契约）
3. 适配器在 `core` 的 `apply()` 里 `registerChannel(onebot)` —— 见 `adapters/README.md`

## 配置

```bash
cp agent.config.example.json agent.config.json
$EDITOR agent.config.json          # 填 identity / channels.onebot / ports
node adapters/selfcheck.mjs       # 应 9/9 通过
```
