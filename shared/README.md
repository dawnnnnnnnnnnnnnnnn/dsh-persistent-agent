# shared

core 与 heartbeat 共用的两个模块：

| 文件 | 作用 |
|---|---|
| `lib/channel.mjs` | 通道适配器契约（七条方法 + 注册表 + splitText） |
| `lib/config.mjs` | 统一配置解析（读 `agent.config.json`，env 回落，旧字段兼容） |

## 为什么单独一个包

之前 heartbeat 用相对路径引 core：

```js
import { getChannel } from '../core/lib/channel.mjs'
```

相对路径出不了 npm 包——把 heartbeat 单独装进别的项目，这个 import 就断了。
所以两个模块提到这里，core 与 heartbeat 各自依赖它。

`core/lib/channel.mjs` 和 `core/lib/config.mjs` 现在只剩一层转发，旧 import 不用改。

## 依赖方向

```
shared  ←  core
shared  ←  heartbeat
```

core 与 heartbeat 之间**不互相引用**。要传消息就走 channel 契约。
