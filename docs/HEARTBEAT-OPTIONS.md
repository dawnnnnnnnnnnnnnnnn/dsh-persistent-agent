# 心跳改造：从「写提示词」到「勾选项」

## 一、问题

现在心跳每次唤醒，喂给她的是一段**自由文本**提示词（`qq-heartbeat.config.json` 的 `prompt`）。
懂的人能改，不懂的人只会一脸茫然：**"我该在这里写什么？"**

开源出去之后，90% 的人会卡在这一步。

## 二、改成什么：模块 + 选项

心跳 = **一组内置模块**，用户只勾选"这次醒来要做什么"。每个模块自带提示词，用户不需要写字。

```json
{
  "heartbeat": {
    "intervalSec": 14400,
    "jitterSec": 1200,
    "quietHours": [1, 9],
    "modules": {
      "weather":     { "on": true,  "options": { "city": "auto", "rainAlert": true } },
      "qzone":       { "on": true,  "options": { "likeLimit": 10, "commentLimit": 10 } },
      "biliDigest":  { "on": false, "options": { "count": 3 } },
      "diary":       { "on": true,  "options": { "hour": 23, "minute": 40, "style": "散文", "maxChars": 700 } },
      "diaryPush":   { "on": true,  "options": { "fromMinute": 1430, "toMinute": 1438 } },
      "anniversary": { "on": true,  "options": { "advanceDays": 3 } },
      "silence":     { "on": true  }
    },
    "customPrompt": ""
  }
}
```

### 七个内置模块

| 模块 | 干什么 | 用户要填的 |
|---|---|---|
| `weather` | 取当地天气；要下雨/降温就提醒带伞添衣 | 城市（默认自动定位） |
| `qzone` | 刷一眼他的 QQ 空间：点赞、偶尔留评 | 点赞/评论上限 |
| `biliDigest` | 把 B 站那只昨天看的、分享的，摘一段给他 | 条数 |
| `diary` | 写两本日记（给他看 / 私记） | 时间、文体、字数 |
| `diaryPush` | 在时间窗里随机挑一分钟推「给他看」 | 起止时间 |
| `anniversary` | 生日/纪念日提前提醒 | 提前几天 |
| `silence` | 没真事就 `[SILENT]`，不打扰 | 无 |

**`customPrompt` 留空就用模块拼；填了就整段覆盖**（给高级用户留的后门，但默认路径不需要写字）。

## 三、拼装顺序（固定，避免各家写法不一）

```
1. 身份锚点（永远第一）
2. [SILENT] 协议（永远第二，防刷屏）
3. 勾选的模块（按上表顺序）
4. 本次可用的动作清单（qq-api / report / sing …）
5. customPrompt（如果有）
```

## 四、和现在的关系

- 现在 `qq-heartbeat.config.json` 的 `prompt` 字段**继续有效**（等于 customPrompt）
- 新配置写在 `agent.config.json` 的 `heartbeat.modules`
- 迁移：首次启动读旧配置 → 自动生成一份 modules（默认全开），**不需要用户重填**

## 五、B站那只也一样

它的夜班（`whale-night.json`）已经是"窗口 + 次数 + 上限"的参数化了，同理把动作做成可勾：

```json
{ "bili": { "windows": [...], "actions": { "watch": true, "comment": "ask", "dm": "ask", "dynamic": "ask" } } }
```

`comment/dm/dynamic` 三档：`true` 自动做 / `ask` 每次问他 / `false` 不做。
**默认 `ask`** —— 对外说话不能默认自动。

## 六、实现顺序

1. 配置 schema + 默认值 + 迁移（不动行为，只多一层解析）
2. 心跳拼装函数改成"模块拼接"，`customPrompt` 仍然最高优先
3. 控制台「心跳」页改成勾选框 + 少量输入
4. 体检加一条：`heartbeat-modules`（确认拼出来的提示词里含勾选项）
