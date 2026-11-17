# 扩展

[安装](QUICKSTART.md) ｜ [架构](ARCHITECTURE.md) ｜ [设计决策](DESIGN.md) ｜ [运行时](LOGIC.md) ｜ **扩展**

五类扩展，按改动面从小到大排。每条给最小示例 + 验收方式。**先想清楚它属于哪一层**
（[架构](ARCHITECTURE.md) 第二节），再动手。

## 一、加一条规则
规则只有一个来源：`memory/管规.md` 的 `N. ` 编号行，每轮全量进 context（读上限 20000 字）。
```diff
  44. 不在群里主动@人
+ 45. 被问到不知道的事，先说不知道，再问要不要查
```
- **验收**：`node <tools>/checks.mjs --json` 看 `rules-injected`；或 `GET /dsh-agent-core/tiers` 搜「45.」。
- **不要**写进 `AGENTS.md` —— 那份只在「红线/底线/必须/绝不/禁止」小节里被抽 ≤10 条、总 400 字。
- 不必重启：5 分钟内自动进提示词；`POST /dsh-agent-core/act {"cmd":"rebuild"}` 可立刻重建。

## 二、加一个技能
一个技能 = 一个 md，放在 `<core>/skills/`（`<core>` 默认 `{{DSH_HOME}}/agent-core`）。
```md
# 记账

> 使用者提到「记账」或者说到一笔支出时用。只写日期、名目、金额，不写评价。

## 怎么做
1. 用 read 打开 `memory/账本.md`，没有就新建。
2. 追加一行：`- YYYY-MM-DD 名目 金额`。
3. 回一句确认，不复述全文。
```
- **格式硬要求**：第一行 `# 名字`；紧跟一行 `> 一句话`（什么时候用它）。索引只取这两样，描述截 80 字。
- **正文不进提示词**：模型看到的只有索引行，真要用时自己 `read` 这个文件。
- **验收**：`GET /dsh-agent-core/skills` 能列出；`prompt.txt` 里「### 可用的 skill」下出现那一行。
- 想**每轮都生效**（风格类），别用技能，写进 `语气卡.md`（L0，开销最小）。

## 三、加一个工具
### A. 脚本 + 技能（已验证，推荐）
```js
// <tools>/ledger.mjs
import fs from 'node:fs'
const [, , amount, ...name] = process.argv
if (!amount) { console.log('用法: ledger.mjs <金额> <名目>'); process.exit(2) }
const line = `- ${new Date().toISOString().slice(0, 10)} ${name.join(' ') || '未命名'} ${amount}\n`
fs.appendFileSync(process.env.LEDGER_FILE || 'memory/账本.md', line)
console.log('OK ' + line.trim())
```
技能正文里写清 `node <tools>/ledger.mjs 30 咖啡`，模型用 shell 工具调用。**约定**：成功 stdout 打 `OK`，
失败非零退出并在 stderr 说明原因 —— 上层只靠这两条判断。

### B. 注册成模型工具（要走宿主插件）
`core` 的两个插件没注册任何模型工具，这条路要新写一个 DSH 插件：在 `apply(ctx)` 里向宿主的工具服务注册
（`name` / `description` / 参数 schema / `execute`），并在 `cordis.patch.yml` 里声明挂载。
**具体注册签名以宿主版本为准（待核实）** —— 不同 DSH 版本的工具服务名与参数形状不同，先 `dsh --version` 对文档。
验收：新会话工具面能看到、模型能调用；回滚：从 `profile/package.json` 的 `bundles` 删掉那行 + 删插件目录 + 重启。

## 四、加一个心跳动作
- 想加一段「醒来时看情况做」的判断：改 `qq-heartbeat.config.json` 的 `prompt`（整段覆盖，最高优先）。
- 想改写日记的方式：`diary.customPrompt`（非空则整段覆盖默认指令）。
- 想**定时**做（不依赖她当时的心情）：用通用任务，别塞进心跳。
```json
{ "id": "ledger-weekly", "name": "每周把账本压成三行", "enabled": true,
  "schedule": { "type": "every", "seconds": 604800 },
  "action": { "type": "script", "path": "{{DSH_HOME}}/agent-core/compact-ledger.mjs" },
  "deliver": "none" }
```
放进 `<core>/jobs.json`，60 秒内被下一次 tick 捡起。**注意**：`action.type: 'prompt'` 会往当前会话投一段话，
**会抢会话** —— 和用户正在说的话排同一条队。验收：`GET /dsh-agent-core/jobs` 看 `state.<id>.lastOk`。

## 五、新增一个通道适配器
core 只依赖 7 条契约（[架构](ARCHITECTURE.md) 第三节）。骨架：
```js
// adapter-skeleton.mjs —— 骨架，不是可直接运行的实现
export default {
  name: 'channel-<name>',
  inject: ['sessionController'],
  apply(ctx) {
    const CFG = { ownerId: '<OWNER_ID>' }                 // ← 读配置文件
    const normalize = (raw) => ({
      channel: '<name>', chatId: String(raw.chatId),
      senderId: String(raw.senderId),
      senderName: String(raw.senderName || '').replace(/[<>\n\r]/g, '').slice(0, 32),  // 消毒
      isOwner: String(raw.senderId) === String(CFG.ownerId),                            // 只认配置
      text: String(raw.text || ''), media: raw.media || [], quoted: raw.quoted || null, at: Date.now(),
    })
    const resolveSession = (chatId) => { /* 读本 adapter 的映射文件；换代要跟住 */ return '' }
    const send = async (chatId, text) => { /* 调通道 API；长文本自己分段 */ }
    const preamble = (ev) => ev.isOwner                                   // 契约 7，可选
      ? `【先认人】现在说话的是使用者。\n\n${readToneCard()}\n\n` : ''
    ctx.on('channel/<name>/message', async (raw) => {                     // 入口：收 → 归一 → 提交
      const ev = normalize(raw)
      const sid = resolveSession(ev.chatId); if (!sid) return
      await ctx.sessionController.prompt({
        requestId: `<name>-${ev.at}`, sessionId: sid, mode: 'queue',
        content: [{ type: 'text', text: preamble(ev) + ev.text }],
      }, new AbortController().signal)
    })
  },
}
```
接入检查单：
1. `resolveSession()` 换代跟得住（别把 sessionId 缓存在内存就算完）。
2. `isOwner` 读**配置**，不读通道里的昵称、群名片、备注。
3. 显示名消毒（去换行、去尖括号、限长）—— 它是别人可控的字符串。
4. `send()` 自己分段；`[SILENT]` 整条丢弃，不要发出去。
5. 频控超限时静默丢弃，不要回「你太快了」（会被当成对话内容）。
6. 心跳要认得这个通道：`dsh-qq-heartbeat` 目前直读 `chat-sessions.json` 的 `private:<OWNER_QQ>`，接新通道前
   先把它改成调 `resolveSession()`，否则心跳只会醒在旧通道上（见[架构](ARCHITECTURE.md) 第十二节）。

## 六、验收与回滚
| 改动 | 验收 | 回滚 |
|---|---|---|
| 规则 | `checks.mjs --json` → `rules-injected` | 删那一行 |
| 技能 | `/skills` 列出；`prompt.txt` 有索引行 | 删 md |
| 工具（脚本） | 手动跑一遍，stdout 以 `OK` 开头 | 删脚本 + 技能里的引用 |
| 工具（插件） | 新会话工具面可见、能调用 | 从 `bundles` 移除 + 删目录 + 重启 |
| 心跳动作 | `jobs` 的 `state.<id>.lastOk`；`core.log` | 置 `enabled: false` 或删条目 |
| 通道适配器 | 一条消息能让 `resolveSession` 命中并收到回复 | 停用该 adapter 插件 |

改前一律复制一份 `*.bak-<日期>`（仓库里大量 `.bak-` 文件就是这个习惯的产物）。
