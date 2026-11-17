#!/usr/bin/env node
/**
 * rollback-merge-c.mjs —— 把「合并 C 方案」整体退回原样
 *
 * 还原这些：
 *   ① memory\AGENTS.md              ← 备份的 QQ 版
 *   ② bili-whale.config.json        ← 备份（home 还原，回主目录）
 *   ③ scheduler.js                  ← 备份（通道标记/一本日记 撤回）
 *   ④ bili-whale 会话目录改名        ← bili-whale-old-20261026 改回 bili-whale
 *   ⑤ 移除新增的 memory\班次\ 与 日记\私记.md（挪到备份，不删）
 *   ⑥ 管规里第 40/41 两条撤掉（按标记删行）
 *
 * 原件 {{HOME}}\AGENTS.md 从来没动过，不需要还原。
 *
 * 用法：node rollback-merge-c.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE, DSH_HOME } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const B = path.join(WORKSPACE, 'backup', 'merge-C-20261026')
const DRY = process.argv.includes('--dry')
const say = (s) => console.log((DRY ? '[预演] ' : '') + s)

function restore(from, to) {
  if (!fs.existsSync(from)) return say('缺备份，跳过: ' + from)
  say('还原 ' + to)
  if (!DRY) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }
}

restore(path.join(B, 'memory-AGENTS.md'), path.join(DSH, 'memory', 'AGENTS.md'))
restore(path.join(B, 'bili-whale.config.json'), path.join(DSH, 'bili-whale.config.json'))
restore(path.join(B, 'scheduler.js'), path.join(DSH, 'profiles', 'web', 'node_modules', 'dsh-bili-whale', 'lib', 'scheduler.js'))

// 会话目录：绝对不改名！
// 早期 事故：把 bili-whale 改成 bili-whale-old-20261026，
// 目录名与内部 session id 不一致 → 工作区/目录选择服务启动失败 → DSH 起不来。
// 现在只做检查，不改名。
// 会话目录名 = 工作目录把 : \\ / 换成 '-'（和宿主的编码规则一致，别写死用户名）
const enc = (p) => String(p).replace(/[:\\/]/g, '-')
for (const base of [
  path.join(WORKSPACE, 'dsh-data', 'sessions', '--' + enc(path.join(DSH_HOME, 'memory')) + '--'),
  path.join(WORKSPACE, 'dsh-data', 'sessions', '--' + enc(DSH_HOME) + '--'),
]) {
  const p = path.join(base, 'bili-whale')
  if (fs.existsSync(p)) say('会话目录正常: ' + p + '（不改名）')
  else say('没有 bili-whale 会话目录（不需要改回，等它自己建）')
}

// 新增文件挪走（不删）
const shelf = path.join(B, 'removed')
for (const p of [path.join(DSH, 'memory', '班次'), path.join(DSH, 'memory', '日记', '私记.md')]) {
  if (!fs.existsSync(p)) continue
  const target = path.join(shelf, path.basename(p) + '-' + Date.now())
  say('挪走新增文件: ' + p + ' → ' + target)
  if (!DRY) { fs.mkdirSync(shelf, { recursive: true }); fs.renameSync(p, target) }
}

// 管规第 40/41 条撤掉
const R = path.join(DSH, 'memory', '管规.md')
if (fs.existsSync(R)) {
  const before = fs.readFileSync(R, 'utf8')
  const after = before.split('\n').filter((l) => !/^4[01]\.\s*(日记只有一本|收到带「【通道=B站】」)/.test(l)).join('\n')
  if (after !== before) { say('撤掉管规第 40/41 条'); if (!DRY) fs.writeFileSync(R, after, 'utf8') }
}

say('完成。重启 DSH 后才完全生效：node bili-whale\\restart-later.mjs 20 "回滚合并C"')
