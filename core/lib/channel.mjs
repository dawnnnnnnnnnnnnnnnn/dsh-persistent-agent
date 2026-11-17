/**
 * core/lib/channel.mjs —— 转发到 shared/lib/channel.mjs
 *
 * SPDX-License-Identifier: MIT
 *
 * 早期：实现搬到共享包。原来 core 与 heartbeat 靠相对路径  *`../core/lib/channel.mjs` 互相引用，装不了两个独立 npm 包。现在两边都依赖 shared，
 * 这里保留一层转发，是为了不破坏已经写好的 import。
 */
export * from '../../shared/lib/channel.mjs'
