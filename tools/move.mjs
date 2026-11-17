#!/usr/bin/env node
/**
 * move.mjs —— 给 Live2D 发一个短动作（fire-and-forget，不阻塞调用方）
 *
 * 用法：
 *   node move.mjs nod        点头
 *   node move.mjs shake      摇头
 *   node move.mjs look 0.5 -0.2
 *   node move.mjs breath     只清一下表情
 */
import { spawn } from 'node:child_process'
import { DSH_HOME, COMFY_ROOT } from '../core/lib/config.mjs'
import path from 'node:path'

const PY = process.env.COMFY_PY || path.join(COMFY_ROOT, 'python_embeded', 'python.exe')
const CLI = process.env.VTS_CLI || path.join(DSH_HOME, 'bili-whale', 'vts-cli.py')

const [, , cmd = 'nod', ...rest] = process.argv
const args = [CLI, cmd, ...rest]
const child = spawn(PY, args, { detached: true, stdio: 'ignore', windowsHide: true })
child.unref()
