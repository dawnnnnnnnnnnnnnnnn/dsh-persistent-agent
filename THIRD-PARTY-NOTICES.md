# Third-Party Notices

本项目（下称"本包"）采用 **MIT** 许可发布，全文见 [`LICENSE`](LICENSE)。
下列第三方组件、服务与素材按各自许可使用。本文件按 Apache-2.0 NOTICE 惯例（§4(d)）与
[REUSE](https://reuse.software/) 建议组织：每一节说明**使用方式**、**该许可对本使用方式的义务**、
以及**是否必须从发行包中移除**。

面向使用者的可读致谢版本见 [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md)；
逐文件来源标注清单见 [`ATTRIBUTION-CHECK.md`](ATTRIBUTION-CHECK.md)。

**盘点口径说明**：本包的发行物由 [`pack-oss.mjs`](pack-oss.mjs) 的显式 `INCLUDE` 清单生成
（目录：`core/` `adapters/` `heartbeat/` `tools/`（逐个点名）`patches/` `docs/` `persona-template/`；
元文件：`README.md` `LICENSE` `THIRD-PARTY-NOTICES.md` `agent.config.example.json`）。
`ref/`（第三方源码阅读留档）、`dist/`（生成物）、`CHANGELOG*`、`*-state.json`、贴纸素材、
二进制与模型权重由 `EXCLUDE` 强制排除，**不随包分发**。

需要特别指出两点：

- **`patches/` 是随包的**（`INCLUDE` 里有 `patches/`）。它是 `dsh-onebot-qq` 的 BSD-3 衍生文件，
  因此 BSD-3 的保留义务是**强制**的，不是可选的 —— 见第三节。
- `ATTRIBUTION-CHECK.md` 被 `EXCLUDE` 排除（开发内部清单，不进发行包）；它留在仓库里供维护者用。

统计：随包分发的第三方代码 **1** 项（DSH 插件 client 外壳）· 随包的第三方衍生文件 **8** 个
（`patches/dsh-onebot-qq@0.9.2/lib/*.js`）· 运行时调用不分发 **32** 项 ·
仅借鉴设计/阅读参考 **13** 项。

---

## 一、随包分发的代码

进包的 119 个文件里，**只有一处第三方代码形态**：DSH 插件客户端的加载器外壳。
其余文件均为本项目自研。

| 组件 | 版本 / commit | 来源 URL | 许可 | 我们改了什么 | 义务履行方式 |
|---|---|---|---|---|---|
| DSH 插件 client 外壳骨架（`window.__ModuleLoader__.load({ id, factory(require) })` 加载器结构） | @deepseek-ai/dsh `0.2.2-rc.2`；cordis `4.1.0` | https://github.com/deepseek-ai/deepseek-harness | MIT（Copyright (c) 2026 DeepSeek） | 只沿用加载器外壳与 `ctx.slots.inject` 的调用形状；插件业务逻辑（三层提示词、记忆检索、控制台页面）全部自研，未复制宿主内部实现 | 保留 MIT 声明：本文件即致谢处；分发时随包附 `LICENSE`（MIT 全文）。MIT §"include the copyright notice" 已满足 |

### 关于"是否必须移除"的判定

本次核查**没有发现** GPL / AGPL / 非商用许可的代码被内联进本包。所有 GPL/AGPL/非商用项
（ComfyUI、Anima 权重、NapCat、Lagrange.Core、Applio 的 NC 变体、nekowhale 的 CC BY-NC 素材）
一律维持为**进程外接口调用或用户自装**，见第二节与第六节。

> 兼容性说明：本包为 MIT。若将来有人把 GPL-3.0 的 ComfyUI 代码、GPL-3.0 的 Lagrange.Core 代码、
> 或 NapCat 的代码内联进本包，MIT 与这些许可**不兼容**，该文件必须移除并改回接口调用。
> 判定见第六节"必须移出"表。

---

## 二、运行时调用、不分发

下列组件由使用者**自行安装**，本包只通过 HTTP / 子进程 / 文件路径调用，**不包含其任何代码或权重**。
使用者须自行遵守各自许可；本包不对其许可合规性作任何担保。

### 2.1 生成与合成后端（外部服务/模型）

| 组件 | 来源 | 许可 | 调用方式 | 使用者需自行安装并遵守其许可 |
|---|---|---|---|---|
| ComfyUI | https://github.com/Comfy-Org/ComfyUI | **GPL-3.0** | HTTP `POST /prompt`、`GET /history`、`GET /view`（默认 `http://127.0.0.1:8188`），仅走网络接口 | 自行部署。**不得**把 ComfyUI 源码或其自定义节点代码复制进本包或与之静态链接；若分发基于 ComfyUI 的衍生作品，须整体按 GPL-3.0 发布 |
| Anima（动漫底模） | https://huggingface.co/circlestone-labs/Anima | **CircleStone Labs Non-Commercial License v1.0**（底模另含 NVIDIA Open Model License） | 由使用者的 ComfyUI 加载 `anima-*.safetensors` + 角色 LoRA（使用者自备） + `qwen_3_06b_base` 文本编码器 + Qwen-Image VAE | **禁止商用**。权重与 LoRA 属 Derivative，继承非商用条款，**不得随本包分发**；分发衍生模型须附该许可全文与指定 Attribution Notice。生成图可商用，但不得暗示模型方背书 |
| Qwen-Image（VAE / 文本编码器 / 图像模型） | https://github.com/QwenLM/Qwen-Image | Apache-2.0（Copyright 2024 Alibaba Cloud） | 作为 ComfyUI 的 VAE/CLIP 组件被加载 | 自行下载。若再分发权重须附 Apache-2.0 全文与 NOTICE（如有） |
| CosyVoice / CosyVoice3（语音合成） | https://github.com/FunAudioLLM/CosyVoice | Apache-2.0 | 本地 HTTP 服务（`http://127.0.0.1:9880` 语音服务），本包只发请求 | 自行部署。Apache-2.0 §4 要求：分发时附许可全文、保留版权与 NOTICE、修改过的文件加显著变更声明 |
| SoulX-Singer（歌声合成） | https://github.com/Soul-AILab/SoulX-Singer | Apache-2.0 | 本地 python 子进程 + 产物文件 | 同上（Apache-2.0 义务） |
| RVC（检索式音色转换） | https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI | MIT（Copyright (c) 2023 liujing04, 源文雨, Ftps） | 使用者在 `xi-sing/venv` 里装好后由本包调子进程 | 自行安装。MIT 要求保留版权与许可声明 |
| Applio（RVC 分支） | https://github.com/IAHispano/Applio | **待核实**：官方 README 声明 MIT；流通的 `LICENSE` 存在 "MIT License (Non-Commercial)" 变体（禁止商用、禁止销售） | 与 RVC 同一路径（音色转换），按使用者所选分支 | 使用前必须核对**自己所装那一份**的 `LICENSE` 原文。若为 NC 变体：禁止商用 |
| ffmpeg | https://ffmpeg.org | **LGPL-2.1-or-later**；若为 GPL 构建则 GPL（取决于编译选项） | `execFile` 调可执行文件（抽帧、混音、转码：`sing.mjs` / `feiyu-tts.mjs` / `sheet.mjs`） | 自行安装。本包**不打包** ffmpeg。若分发二进制须附其许可与源码获取方式；若用了 `--enable-gpl` 构建，整链按 GPL 处理 |

### 2.2 QQ 协议端（本包不含，用户自装）

| 组件 | 来源 | 许可 | 调用方式 | 使用者需自行安装并遵守其许可 |
|---|---|---|---|---|
| NapCat | https://github.com/NapNeko/NapCatQQ | **Limited Redistribution License**（Copyright © 2024 Mlikiowa）：禁止商用；再分发须附全文与出处；**禁止任何项目未经作者授权基于 NapCat 代码开发**；修改版不得公开发布 | 本包只对它暴露的 OneBot HTTP/WS 端口（默认 `127.0.0.1:3000/6099`）发请求，并读取其令牌 | **绝不可**把 NapCat 代码或其修改版并入本包；不可用于商业用途 |
| LLOneBot / LLBot | https://github.com/LLOneBot/LLOneBot | MIT（Copyright (c) 2024 LLOneBot） | 同上（OneBot 11 / Satori 协议） | 自行安装；MIT 保留声明 |
| Lagrange.Core | https://github.com/LagrangeDev/Lagrange.Core | **GPL-3.0** | 同上（OneBot 实现） | 自行运行；**不得**与本包静态链接或内联其代码，否则本包须整体 GPL-3.0 |

### 2.3 运行时第三方 DSH 插件（用户自装，本包只调用其接口/读其产物）

本包的脚本会 import 这些插件的模块、读它们的配置文件或产物目录。它们**不随本包分发**。

| 组件 | 版本 | 许可 | 调用方式 |
|---|---|---|---|
| dsh-onebot-qq | 0.9.2 | **BSD-3-Clause**（Copyright (c) 2026 dsh-external contributors） | QQ 通道本体；本包对其打运行时补丁（见第三节） |
| dsh-bili-whale | 0.4.5 | MIT（Copyright (c) 2026 ALTERSSSS） | 互操作：与本包共用 `~/.bili-ai/*.json` 配置口径与 `~/.dsh/whale-diary.md`；**不修改其一行代码** |
| dsh-nekowhale-stickers | 1.1.0 | **Apache-2.0 AND CC-BY-NC-4.0** | 读 `~/.dsh/nekowhale-stickers/` 下已下载的表情素材；见第五节 |
| dsh-qwen-paint | 0.1.2 | MIT | 动态 import 其 `lib/cjk-tags.mjs`（中文→tag 词典） |
| dsh-image-studio | 0.3.0 | MIT | 读写其参考库 `~/.dsh/image-studio/library/` |
| dsh-purge-community | 1.6.93 | MIT | 客户端注入一条 CSS 把其全屏遮罩压掉（`client.js`），不改其代码 |
| dsh-context | 0.73.0 | **Apache-2.0** | 同宿主并存；若再分发须附许可与 NOTICE |
| dsh-bili-live | 0.9.3 | MIT（仓库内无 LICENSE 文件，以 `package.json` 声明为准） | 直播抓取 |
| dsh-soundcheck | 0.6.8 | MIT | 音频链路自检 |
| dsh-video-storyboard | 0.3.0 | MIT | 视频分镜 |
| dsh-vision-router | 3.1.0 | MIT | 视觉路由 |
| dsh-orb | 0.2.1 | MIT | 状态球 |
| dsh-deepseek-balance | 0.1.0 | MIT | 余额查询 |
| dsh-<name>-live2d | — | 见其仓库 | Live2D 形象驱动（使用者自备） |
| dsh-research | 0.1.0 | MIT | 调研 |
| dsh-at-file | 0.6.3 | MIT | @文件 |
| dsh-reasoning-effort | 0.8.1 | MIT | 推理档位 |
| dsh-worktable | 0.4.0 | MIT | 工作表 |

### 2.4 运行平台与外部服务

| 组件 | 来源 | 许可 / 条款 | 调用方式 |
|---|---|---|---|
| DeepSeek Harness（DSH）本体：`@deepseek-ai/*` 全家族 | https://github.com/deepseek-ai/deepseek-harness | MIT（Copyright (c) 2026 DeepSeek）；`cordis`/`schemastery` MIT（Shigma）；`libreoffice-kit` MPL-2.0 | 本包作为 DSH 插件运行，通过公开的 Cordis 插件 API（`ctx.slots.inject`、`ctx.sessionController.prompt`、`route()`）接入 |
| Node.js | https://nodejs.org | MIT | 运行时 |
| Bilibili 公开 Web API | — | 非官方接口，无代码与数据随附；接口文档整理自 https://github.com/SocialSisterYi/bilibili-API-collect | HTTP 请求；使用者自负合规责任 |
| VTube Studio（Live2D 驱动） | Steam 应用 | 专有软件，按最终用户协议使用 | 本包只作为 WebSocket 客户端（`vts*.mjs`）连接其 API |
| DeepSeek 官方账号服务 / 模型 API | https://platform.deepseek.com | 服务条款（非开源许可） | HTTPS API 调用；凭据由使用者自备，本包不含任何密钥 |

---

## 三、代码补丁

`patches/` 是**运行时**补丁：DSH 启动前由 `apply-patches.mjs` 把"打补丁后的整文件"覆盖到
profile 的 `node_modules`。

**注意：`pack-oss.mjs` 的 `INCLUDE` 里包含 `patches/`，所以这些文件是随包分发的。**
它们是第三方代码的**衍生作品**，因此 BSD-3-Clause 的义务全部生效，不能只当本地脚本看。

| 目标包 | 版本 | 补丁文件 | 许可 | 补丁内容性质 | 为何不算本项目的衍生作品 / 如何遵守 |
|---|---|---|---|---|---|
| `dsh-onebot-qq` | `0.9.2`（`manifest.json` 记录抓取时间，上游 https://github.com/mario841859784/dsh-onebot） | `lib/bridge.js`、`lib/commands.js`、`lib/cq.js`、`lib/deferred.js`、`lib/inbound.js`、`lib/outbound.js`、`lib/prompt.js`、`lib/registry.js`（各带 `dsh-local-patch` / `sentinel` / `agentCoreTiers` / `local fix` 标记） | **BSD-3-Clause**（Copyright (c) 2026, dsh-external contributors） | 整文件替换：会话映射合并、`[SILENT]` 拦截、三级提示词注入、注册项修复等**本地行为修正**；不改上游对外协议与导出接口 | ① 保留版权与免责声明：**必须**在补丁目录内附 BSD-3 全文（建议 `patches/dsh-onebot-qq@0.9.2/LICENSE`）并保留上游版权行 —— BSD-3 §1/§2；② 标注改动：每个补丁文件头写明"本地修改版、未被上游发布、改了什么" —— §2 要求"must cause any modified files to carry prominent notices stating that You changed the files"（本项仍有 8 个文件待补，见 `ATTRIBUTION-CHECK.md` §3）；③ 禁止背书：BSD-3 §3 不允许用上游作者/贡献者名义为本衍生作品背书，本包文档未作任何此类暗示；④ BSD-3 与 MIT 兼容，因此这些衍生文件可以留在 MIT 包里，**不构成必须移除** |

> 若将来不想承担上述义务，最小改动是在 `pack-oss.mjs` 的 `EXCLUDE` 里加
> `/^patches(\/|$)/`，改为只发一个"补丁示例"说明文档。当前选择是"发补丁 + 履行 BSD-3"。

---

## 四、仅借鉴设计，未使用代码

### 4.1 有明确证据的借鉴

| 项目 | 借鉴了什么 | 无代码复制声明 |
|---|---|---|
| **Hermes**（Python agent 运行时，代码头注释引用其 `agent/system_prompt.py:730`、`v0.22.2`） | 提示词三层分层（`stable` / `context` / `volatile`）与注入顺序；memory provider + FTS 检索的形状；skills 索引只注入"名字 + 一句话"；把定时任务当一等公民（cron 语义）；`trajectories` → ShareGPT 导出；`platform_hint` 的通道约束写法 | 本项目以 **DSH 插件原语**重新实现（`dsh-agent-core/lib/{tiers,memory,providers,skills,jobs,trajectory}.mjs`、`agent-core/session-guard.mjs`）。**未复制 Hermes 任何源码**：语言、运行时、数据结构均不同（Python 单体 → Node/Cordis 插件）。代码相似度扫描显示与 `ref/` 各项目的重合行全为 fetch 头、`mkdirSync({recursive:true})` 一类通用样板（≤3.1%，最高一例来自 DSH 插件脚手架） |
| **dsh-fish-memory**（MIT, https://github.com/Yuuyuko-uu/dsh-fish-memory） | "权重 + 门槛"清理模型（年龄分 + 体积分，合计过线才候选）与"事实键去重：同一件事只留最新"两条机制 | `tools/tidy.mjs` 自述"借鉴自 fish-memory"。**未复制其代码**：fish-memory 是带"鲜活度/半衰期"的记忆插件，本处是文件清理器，阈值公式与评分对象均不同 |
| **玉子控制台 v0.3.10**（作者：coolsnacpai，见 §4.3） | `core/lib/panel.html` 的**信息结构与命名习惯**改造自此。早期 实测比对：CSS 选择器 19/25 重合（wrap / logo / chip / grid / card / row / sec / dot …），JS 函数名重合 3 个（toast / refreshAll / loadLog），**无逐字复制**（>40 字长句 0 条重合）；样式已在 早期 整体重做为暖白纸面 + 单点缀色。**属"改造/衍生"，需原作者许可后随 MIT 分发**（见 §4.3） |

### 4.2 仅阅读参考、未采用任何代码

以下项目源码留档在 `ref/`（**不随包分发**，见第六节），阅读后未采用代码。
若其中某项确有思路沿用而本文未列明，请按 `ATTRIBUTION-CHECK.md` 的模板补一条。

| 项目 | 版本 / commit | 许可 | 借鉴了什么 / 读了什么 | 无代码复制声明 |
|---|---|---|---|---|
| dsh-bili-subagent | 0.7.5 @ `57616b9`（上游 fork 自 c1overzz/dsh-bili-scroll 0.1.10） | MIT | B 站账号态检测、抽帧链路、任务卡与额度闸门的组织方式；其内置 `vendor/bilibili-mcp`（MIT, AGI_Ananas）**未采用** | 未复制其代码 |
| dsh-bili-whale | 0.4.5 @ `ef3f741` | MIT | 与本包是**互操作**关系：配置字段口径（`night.windows` / `skipChance` / `maxVideos` / `quota.shareDaily`）与日记文件位置需与其一致，本包控制台才能读写同一份配置 | 未复制其代码；配置字段名属功能性接口标识符，非表达性代码 |
| dsh-feiyu-mood | 0.4.2 @ `38eb330` | MIT | 心情"每轮判一次 + 自行回稳"的建模取向 | 未复制其代码；本包**未实现**量化心情（`tools/checks.mjs` 反而把"心情被量化"列为告警项） |
| dsh-qq-bridge | 0.3.4 @ `00dc7e3` | MIT | 轮询协议端收消息、图片双向中继的取舍 | 未复制其代码；本包通道走 `dsh-onebot-qq` |
| dsh-speak-up | 0.2.1 @ `7993a82` | **待核实**：仓库内**无 LICENSE 文件**，`package.json` 声明 `"license": "MIT"` | "先掷本地骰子、掷中才花模型"的主动搭话经济学 | 未复制其代码；本包心跳用的是固定间隔 + `jitterSec` 抖动，不是每轮骰子 |
| dsh-tts-bridge | 1.2.9 @ `d112dd2` | **待核实**：仓库内**无 LICENSE 文件**，`package.json` 声明 `"license": "MIT"` | "DSH 侧排队、浏览器侧出声"的桥接分层 | 未复制其代码；本包走本地语音服务（CosyVoice/RVC） |
| dsh-nekowhale-stickers | 1.1.0 @ `61ede40` | Apache-2.0（代码）+ CC-BY-NC-4.0（知识库数据） | 贴纸检索/渲染的交互形态 | 未复制其代码；本包只**调用**已安装的插件并读其已下载素材（见第五节） |
| dsh-digital-life | — | 见其仓库 | 数字生命的人设命名空间 / 侧栏注入做法（本地仅有源码存档记录，未接入） | 未复制其代码 |
| dsh-super-agents | — | 见其仓库 | Router/Worker 两层自治、工单与看板的设计语言（想法层） | 未复制其代码 |
| dsh-paoding | — | 见其仓库 | 按角色裁剪工具面、上下文隔离带来的 token 收益（想法层） | 未复制其代码 |

### 4.3 玉子控制台（[coolsnacpai/yuzi-console](https://github.com/coolsnacpai/yuzi-console)）

`core/lib/panel.html` 的**信息结构、分区骨架与 CSS 命名习惯**改造自此（样式于 早期 重做）。

经作者许可，随本项目以 MIT 许可分发：

```
Copyright (c) 2026 coolsnacpai (workbench prototype: console information architecture)
```

因此 `LICENSE` 保留两行版权：本项目一行，原作者一行；`AUTHORS.md` 中列为「工作台雏形作者」。

## 五、资源与模型

| 资源 | 来源 | 许可 | 是否随包分发 | 判定 |
|---|---|---|---|---|
| Anima 底模（不随包） | circlestone-labs/Anima；LoRA 由使用者自备，本项目不训练、不分发 | CircleStone 非商用 v1.0；LoRA 为其 Derivative，继承非商用 | **否**（模型在 ComfyUI 的 `models/` 下，白名单不含任何权重） | 允许本地自用与生成图商用；**禁止**随包分发权重/LoRA，**禁止**商用模型本身 |
| Qwen-Image VAE / 文本编码器 | Qwen/Qwen-Image | Apache-2.0 | **否** | 若再分发须附许可全文与版权行 |
| 生图参考库（角色设定图、场景/服饰参考） | 本项目自建 | 本项目所有（含 AI 生成稿） | **否**（`.dsh/image-studio/library/` 不在白名单） | 可分发，但其中如含第三方角色设计须另行取得授权 |
| 贴纸素材与模板（`nekowhale` 系列） | dsh-nekowhale-stickers；素材作者信息见其 `NOTICE` | **代码 Apache-2.0；知识库数据与素材 CC BY-NC 4.0** | **否**（`.dsh/bili-whale/stickers/` 约 195 MB 被排除；`byhash/` 缓存亦不在白名单） | **禁止商用、禁止收费提供**；任何情况下不得把素材打进发行包。若将来要分发，必须保留原作者链接/网站并按 Apache-2.0 保留其 `NOTICE` 全文 |
| 表情包合成字体 | 使用者系统字体 / `dsh-nekowhale-stickers` 自带字体 | 见其 `LICENSE-ASSETS` 与字体自身许可 | **否** | 打包任何字体前须单独核实其许可（字体许可常限制嵌入与再分发） |
| 二进制（`.dsh/bili-whale/bin/`、`.dsh/bin/`） | 第三方构建（ffmpeg 等） | 各自许可，见 2.1 | **否**（约 100 MB，白名单外） | 若要分发须逐件核实并附许可；建议永不随包 |
| 本项目生成的内容（日记、生图产物、语音） | 本项目运行时产生 | 归使用者 | **否**（记忆/会话/媒体目录全部在白名单外） | — |

---


### 5.1 LoRA 归属说明

生图链路里的风格 LoRA **不是本项目训练的**。它由社区作者训练并发布，本项目只是调用方：

| 项 | 说明 |
|---|---|
| 训练者 | 社区作者，非本项目 |
| 许可 | 跟随其发布页声明；多数风格 LoRA 默认继承底模的非商用条款 |
| 是否随包 | **否**。仓库与发行包里没有任何 `.safetensors`（已核：0 个权重文件） |
| 你怎么拿到 | 自己从发布页下载，放进 ComfyUI 的 `models/loras/` |
| 你的义务 | 遵守该 LoRA 自己的许可：能不能商用、能不能再分发、改过的版本怎么标 |

**改过的 LoRA 不能在商用前提下继续叫原名**——那是训练者的署名，不是描述词。

使用者在 `agent.config.json` 里填自己 LoRA 的文件名即可：

```json
{ "media": { "imageEngine": "comfyui", "lora": "<你的 lora 文件名>.safetensors" } }
```

本项目的 MIT 许可**不覆盖**任何模型权重、LoRA 或生成图。

## 六、发布前必须移出（或永远不得进入）发行物的项

| # | 项 | 原因 | 处理 |
|---|---|---|---|
| 1 | `ref/**`（8 个第三方仓库的完整源码，含 `vendor/bilibili-mcp`） | 他人代码；其中 `dsh-speak-up`、`dsh-tts-bridge` **仓库内无 LICENSE 文件**（默认保留所有权利）；`dsh-nekowhale-stickers` 的素材说明为 CC BY-NC；`dsh-bili-subagent` 还内嵌 upstream fork 说明 | **已由 `EXCLUDE` 拒绝**（`/(^\|\/)ref(\/\|$)/`）；公开仓库时仍须加 `.gitignore`（当前工程尚未初始化 git，见第八节第 7 条）。本地留档保留 |
| 2 | `patches/**` | `dsh-onebot-qq@0.9.2` 的 BSD-3 衍生整文件，**且随包分发** | **不移除**（BSD-3 与 MIT 兼容）。但义务强制：补丁目录内须附 BSD-3 全文（`patches/dsh-onebot-qq@0.9.2/LICENSE`），8 个文件须加"本地修改版"声明头 —— 二者仍待补，见 `ATTRIBUTION-CHECK.md` §3。若不想承担，可在 `EXCLUDE` 加 `/^patches(\/|$)/` |
| 3 | `dist/**`（含两份历史包与旧 zip） | 生成物，且旧版可能仍含未脱敏值 | **已排除**。仓库须 `.gitignore` |
| 4 | ComfyUI 源码 / 自定义节点 | GPL-3.0，与 MIT 不兼容 | **已移出，改为接口调用**（HTTP 8188） |
| 5 | Anima 权重与 LoRA | 非商用许可 | **已移出，改为由使用者自备** |
| 6 | Applio（若为 NC 变体） | 非商用 | **已移出，改为子进程调用**；使用前核对所选分支的 LICENSE |
| 7 | NapCat 及其修改版 | Limited Redistribution License：禁商用、禁未授权派生 | **已移出**，只保留 HTTP 客户端 |
| 8 | Lagrange.Core | GPL-3.0 | **已移出**，只保留 OneBot 协议调用 |
| 9 | nekowhale 素材 / 任何字体 / 二进制 | CC BY-NC 或体积/许可不明 | **已移出**（见第五节） |
| 10 | `.dsh/**` 下的记忆、会话、媒体、凭据 | 个人数据，非许可问题但等同泄露 | 由 `scan-privacy.mjs` + `pack-oss.mjs` 白名单双重拦截 |

---

## 七、待核实清单

以下项在本次核查中**无法从官方来源确证**，按约定标注为待核实，发布前应补齐：

| 项 | 待核实内容 | 建议核实地址 |
|---|---|---|
| Hermes（Hermes Agent） | 仓库地址、许可类型、版权行；本文只引用其**思路**与代码注释中被引用的行号，未使用代码 | 待核实：其官方仓库 `LICENSE`（本地仅有阅读笔记，无源码与许可文件） |
| Applio | 实际使用分支的 `LICENSE` 是 MIT 还是 "MIT License (Non-Commercial)"；官方 README 与流通 LICENSE 文本不一致 | https://github.com/IAHispano/Applio/blob/main/LICENSE |
| `dsh-speak-up` / `dsh-tts-bridge` | 仓库无 LICENSE 文件，仅 `package.json` 声明 MIT；严格说"保留所有权利"，不能当作 MIT 使用其代码 | 其仓库根目录（建议作者补 LICENSE） |
| `dsh-bili-live` 0.9.3 | 无 LICENSE 文件，仅 `package.json` 声明 MIT | 其仓库根目录 |
| Anima 的 Attribution Notice 原文 | 分发 Any Derivative 时须逐字附上的 Notice 文本 | https://huggingface.co/circlestone-labs/Anima（许可正文） |

---

## 八、与文档不一致、需要修的地方（核查中顺带发现）

1. **`patches/` 实际随包，但正文有些地方还写着"不进包"。** `pack-oss.mjs` 的
   `INCLUDE` 里**有** `patches/`，`EXCLUDE` **没有**排除它 → 补丁会一起发出去。
   因此 BSD-3 的保留义务是强制的（见第三节），而不是"反正不进包"。
   已在本次核查中改掉 §6 的旧说法；`docs/OPEN-SOURCE.md` 里"补丁副本脱敏后才进包"这句
   现在是真的，但**没提 BSD-3 义务**，建议补充。
2. **`ATTRIBUTION-CHECK.md` 被排除**：`EXCLUDE` 有 `/ATTRIBUTION-CHECK\.md$/`。
   这是设计选择（内部清单不进包），但它意味着**终端用户看不到逐文件的溯源说明**；
   面向用户的溯源只靠本文件 + `docs/ATTRIBUTION.md`，两者都随包。
3. **30 个脚本 import 不存在的模块。** `tools/` `adapters/` 下共 30 个文件写
   `import … from '../core/lib/config.mjs'`，但工程内 `core/lib/config.mjs` **不存在**
   （`core/lib` 只有 client / index / jobs / memory / panel / providers / skills / tiers /
   trajectory / util）。在工程里 `tools/` 与 `core/` 是同级目录，路径能解析但文件缺失 →
   一 import 就失败。发布前必须让 `sync-latest.mjs` 生成/同步 `core/lib/config.mjs`，
   或把这批 import 改成真正存在的模块。
4. **`INCLUDE` 有 4 条指向不存在的文件**：`tools/send-voice.mjs`、`tools/vts-cli.py`、
   `tools/vts-say.py`、`tools/vts-dump.py`（实际 `send-voice.mjs` 在
   `adapters/onebot/tools/` 下，三个 `.py` 工程内没有）。出包脚本应把这些条目标成告警，
   否则"清单写了但没打进去"没人会发现。
5. **`heartbeat/lib/index.js` 注释块里混了一行代码。** 该文件块注释 `/** … */` 内部有一行
   `const HOME = process.env.USERPROFILE || os.homedir();`（`node --check` 通过，
   且全文件不再引用 `HOME`，所以不影响运行）。属可读性缺陷，建议移出或删掉。
6. **同步会抹掉归属注释。** `sync-latest.mjs` 从现役目录重新生成 `core/` `heartbeat/`
   `tools/` `adapters/`，不保留手工加的注释头 → 本工程已加的 12 个归属注释会在下次同步时丢失。
   对策：同步后跑一次 `node apply-attribution-headers.mjs --go`（幂等），或把它挂进同步收尾。
7. **工程尚未 `git init`，也没有 `.gitignore`。** 公开前至少应忽略：`ref/`、`dist/`、
   `node_modules/`、`*.log`、`*.bak*`。`patches/` 现在是要发的，**不要**忽略它；
   但要确认补丁里没有真实令牌/路径（由 `scan-privacy.mjs` 兜）。

---

*本文件仅记录许可事实与义务，不构成法律意见。若将本项目用于商业场景，请就第 2 节的非商用项
（Anima、Applio NC 变体、NapCat、nekowhale 素材）单独取得授权。*
