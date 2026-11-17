#!/usr/bin/env node
/**
 * restart-later.mjs —— 延迟重启 DSH（这段时间我的回合能正常收尾，不会被自己掐断）
 *
 * 为什么要它：直接调 restart.mjs 会把 dsh web 进程当场杀掉，
 * 而我正跑在这个进程里 → 当前工具调用被切断，日志尾部只能靠 repair 补
 * 「The tool call was interrupted after it was recorded…」。
 * 改成：先派生一个游离进程，等 N 秒后重启；我在这 N 秒里把话说完。
 *
 * 用法：node restart-later.mjs [秒数，默认 20] [原因]
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const secs = Number(process.argv[2] || 20)
const reason = process.argv[3] || 'delayed restart'
const HOME = process.env.USERPROFILE || os.homedir()
const restart = path.join(HOME, '.dsh', 'bili-whale', 'restart.mjs')

const child = spawn(process.execPath, ['-e', `
  const { spawn } = require('node:child_process');
  setTimeout(() => {
    spawn(process.execPath, [${JSON.stringify(restart)}, '--mode', 'dsh', '--force', '--reason', ${JSON.stringify(reason)}],
      { detached: true, stdio: 'ignore' }).unref();
  }, ${secs * 1000});
`], { detached: true, stdio: 'ignore' })
child.unref()

console.log('OK 已安排 ' + secs + ' 秒后重启（原因: ' + reason + '）—— 这轮可以正常说完')
