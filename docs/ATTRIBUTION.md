# 致谢

> 这个包能跑起来，一半功劳不在我。下面这些人和项目，把最难的那半边先做完了。
>
> 本项目以 MIT 发布（见 [`LICENSE`](../LICENSE)）。许可层面的完整义务、版本与 commit 记录，
> 在 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)；这里只讲"学到了什么、用了什么"。

---

## 底座

### DeepSeek Harness（DSH）

https://github.com/deepseek-harness

这个包本体就是一组 DSH 插件。三层提示词、记忆检索、心跳调度、控制台页面，全都长在 DSH
暴露的插件原语上（`ctx.slots.inject`、`ctx.sessionController.prompt`、`route()`、bundle patch）。
没有"一个宿主能让你把 agent 的每一层都换掉"这件事，这个项目根本不存在。

MIT，Copyright (c) 2026 DeepSeek。

---

## 想了很久才想明白的设计

### Hermes — 分层这件事，是它教的

提示词不该是一坨。`stable`（身份、规则、常驻技能）/ `context`（本次会话的取材）/ `volatile`
（这一刻的运行时状态）三层分开，各自有各自的刷新节奏 —— 这个划分来自 Hermes。
还有"记忆要能检索、不能每轮全塞进去"（memory provider + 全文检索）、
"技能只注入名字和一句话，正文用的时候再读"、"定时任务应该是一等公民而不是 shell 定时"、
"把会话导出成训练样本" —— 这些形状都是从它那儿看来的。

**没有用它的代码。** 它是 Python 单体，我们这边是 Node + Cordis 插件，
`dsh-agent-core/lib/{tiers,memory,providers,skills,jobs,trajectory}.mjs` 全部按 DSH 的原语重写。
连"照抄"的机会都没有，只能照着它的判断重做一遍。

*许可与仓库地址待核实 —— 本项目只借鉴思路，未使用其源码。*

### dsh-fish-memory — "会淡忘"比"记得多"难

https://github.com/Yuuyuko-uu/dsh-fish-memory

记忆不是硬盘。每条东西有鲜活度，越久越难被想起来 —— 不是删掉，是沉下去。这个想法很轻，
但它顺带给了我们两件很实用的东西：

- **权重 + 门槛**：清理文件不该只问"多少天了"，而该问"年龄分 + 体积分够不够格"。所以
  两天前的 300 MB 视频会先走，二十天前的 900 KB 小图还能留着。
- **事实键去重**：同一件事只留最新那份（同一个 BV 号下载的 mp4 只留一个）。

`tools/tidy.mjs` 里这两条机制是照着它做的，文件头有注明。代码没有复制 ——
它是带半衰期的记忆插件，我们这是个文件清理器，评分对象都不一样。

MIT。

### 玉子控制台（[coolsnacpai/yuzi-console](https://github.com/coolsnacpai/yuzi-console)） — 控制台该长什么样

最初那版控制台是照着玉子的结构改的：分区怎么排、状态怎么摆、什么该在首屏。**这一步属于"改造"，不是"参考"**——CSS 命名与分区骨架至今仍在（实测选择器 19/25 重合），因此这份控制台要么拿到作者许可随 MIT 分发，要么从发行包里移除（见 `THIRD-PARTY-NOTICES.md` §4.3）。
后来整页重做成了暖白纸面 + 单点缀色的编辑风格，页面结构与样式已经不含它的痕迹，
但"一个 agent 的控制台应该让人一眼看出它现在是什么状态"这个判断，是从它那儿来的。

见 [`CONSOLE-PLAN.md`](CONSOLE-PLAN.md) 里的"玉子有 / 我们缺"对照表。
*版本 v0.3.10，许可与仓库地址待核实。*

---

## 只读过、没动过代码的

这几份源码留在 `ref/` 里（**不随包分发**），读完用来对齐行为，没有抄一行。

### dsh-bili-whale

https://github.com/Alterssss/dsh-bili-whale

**和我们是邻居，不是祖先。** 本包有个明确纪律：不修改它一行代码。两边共用同一份配置口径
（`night.windows` / `skipChance` / `maxVideos` / `quota.shareDaily`）和同一份日记文件，
所以我们的控制台能读写它的设置 —— 那叫接口一致，不叫派生。我们自己的插件描述里
写的就是"不动 dsh-bili-whale"。

MIT。

### dsh-bili-subagent

https://github.com/Yuuyuko-uu/dsh-bili-subagent

B 站账号态怎么检测、抽帧链路怎么串、任务卡和额度闸门怎么组织。它自己也是
[c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 的 fork（MIT），
里面还内置了 [bilibili-mcp](https://github.com/adoresever/bilibili-mcp)（MIT, AGI_Ananas）——
两层署名都保留了，这点值得学。

MIT。

### dsh-feiyu-mood

https://github.com/Yuuyuko-uu/dsh-feiyu-mood

心情不是关键词猜、也不是随机数，而是每轮聊完判一次"往哪走"，会起伏也会自己回稳。
我们的取向和它一致，但**故意不实现量化心情** —— `tools/checks.mjs` 里反而把
"记忆里出现心情分数/好感度数值"列为告警项。心情写下来就死了。

MIT。

### dsh-qq-bridge

https://github.com/Yuuyuko-uu/dsh-qq-bridge

通道该怎么接：轮询协议端收消息、图片双向中继时"转发原图而不是自己那份重编码副本"
这类细节，都是看它才想到的。本包的通道实现走的是 `dsh-onebot-qq`（见下），不是它。

MIT。

### dsh-speak-up

https://github.com/Yuuyuko-uu/dsh-speak-up

"没人在跟它说话的时候，它也可以先开口" —— 而且先掷一次本地骰子，掷不中一个 token 都不花。
这个经济学很干净。我们的心跳选了另一条路（固定间隔 + 抖动），但这个"先算成本再决定要不要动"
的顺序记住了。

*仓库内无 LICENSE 文件，仅 `package.json` 声明 MIT —— 待核实。*

### dsh-tts-bridge

https://github.com/Yuuyuko-uu/dsh-tts-bridge

"DSH 这边知道说了什么，浏览器那边负责让声音出来，中间靠一座桥接起来"——
把一件事拆成两半、各自用最合适的运行时，这个分层很值得学。我们的语音走本地合成
（CosyVoice / RVC），但桥接的分层判断是这儿来的。

*仓库内无 LICENSE 文件，仅 `package.json` 声明 MIT —— 待核实。*

### dsh-nekowhale-stickers

https://github.com/Loping151/dsh-nekowhale-stickers

贴纸检索与渲染的交互形态。本包**只调用**已安装的它、只读它自己下载到本地的素材，
**不打包任何素材**。它的许可是代码 Apache-2.0、知识库数据与素材 CC BY-NC 4.0
（禁止商用、禁止收费提供），所以素材永远不进发行包。

### dsh-digital-life / dsh-super-agents / dsh-paoding

- https://github.com/elonnzhang/dsh-digital-life —— 数字生命的人设放哪个命名空间、侧栏怎么注入。
- https://github.com/mindtheory/dsh-super-agents —— Router/Worker 两层自治、工单与看板的设计语言。
- https://github.com/lifangjin/dsh-paoding —— 按角色裁剪工具面，真正的收益是上下文隔离而不是省 token。

这三个只读了设计，代码一行没用。第三种尤其改变了我们对"多 agent 到底省不省"的看法：
省的不是那几千 token，是主 agent 的窗口不再被别人的产物塞满。

---

## 跑起来靠的这些东西（不在包内）

这些我们**不分发**，只调用。用之前请自己装、自己看许可：

| 干什么 | 用什么 | 注意 |
|---|---|---|
| 出图 | [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | GPL-3.0。我们只走它 8188 的 HTTP 接口，**不打包它** |
| 动漫底模 | [Anima](https://huggingface.co/circlestone-labs/Anima) | CircleStone 非商用许可。权重与 LoRA **不随包分发**，不可商用 |
| 图像 VAE / 编码器 | [Qwen-Image](https://github.com/QwenLM/Qwen-Image) | Apache-2.0 |
| 语音合成 | [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) | Apache-2.0 |
| 歌声合成 | [SoulX-Singer](https://github.com/Soul-AILab/SoulX-Singer) | Apache-2.0 |
| 音色转换 | [RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) / [Applio](https://github.com/IAHispano/Applio) | RVC 是 MIT；Applio 请自行核对你装的那份 LICENSE（有 NC 变体在流通） |
| 抽帧 / 混音 | [ffmpeg](https://ffmpeg.org) | LGPL-2.1+，GPL 构建则为 GPL。自己装 |
| QQ 协议端 | [NapCat](https://github.com/NapNeko/NapCatQQ) / [LLOneBot](https://github.com/LLOneBot/LLOneBot) / [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | **NapCat 是非商用受限许可，Lagrange 是 GPL-3.0。都别打进包里** |
| QQ 通道插件 | [dsh-onebot-qq](https://github.com/mario841859784/dsh-onebot) | BSD-3-Clause。我们的 `patches/` 是对它 0.9.2 的本地补丁，不随包 |
| 中文→tag | dsh-qwen-paint | MIT |
| 形象驱动 | VTube Studio | 专有软件，按它的 EULA 用 |

**一句提醒**：上面标了非商用的（Anima、Applio 的 NC 变体、NapCat、nekowhale 素材），
如果你要拿这个包做商业项目，得单独拿授权。这不是我们能替你解决的部分。

---

## 表情与素材

贴纸素材的作者信息按原项目要求保留在其自身 `NOTICE` 里，本包不复制、不再分发。
如果你在自己的实例里启用了贴纸，请顺带看一眼那个项目的 `NOTICE` 与 `LICENSE-ASSETS`——
它要求保留作者链接，并且禁止收费提供。
