#!/usr/bin/env node
/**
 * vts.mjs —— VTube Studio API 的最小客户端（WS 8001）
 *
 * 首次使用：在 VTS 里会弹「允许插件连接」，点 Allow；
 *           token 自动存到 ~/.dsh/vts.json，以后不用再点。
 *
 * 用法：
 *   node vts.mjs hello                     连上并列参数 / 热键 / 模型
 *   node vts.mjs param ParamMouthOpenY 0.8 直接设某个参数
 *   node vts.mjs hotkey <HotkeyID>         触发热键（表情/动作）
 *   node vts.mjs say "文本" [--mouth]       （占位，TTS 接进来后填）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.USERPROFILE || os.homedir()
const TOKEN_FILE = path.join(HOME, '.dsh', 'vts.json')
const WS_URL = process.env.VTS_WS || 'ws://127.0.0.1:8001'
const PLUGIN_NAME = 'agent-bridge'
const DEV_NAME = process.env.VTS_DEV_NAME || 'agent-bridge'
const DEV_EMAIL = 'agent@local'
const PLUGIN_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAC4ElEQVR4nO2du1EkQRAFBwIdJ05Exg70UfABO84HlHGmvcGCOwnlIrhgg5nuV5WZKktEV73sz8Z89u7X08ufTbDcrx6ArEUB4CgAHAWAowBwFACOAsBRADgKAEcB4CgAHAWAowBwFACOAsBRADgKAEcB4CgAHAWAowBwFACOAsBRADgKAEcB4CgAnIcNxPPr+7c/O95fNwJ3XR8OvSVsshStBLgi9O4ytBBgZvDdRCgtwMrgu4hQUoCk4KuLUO5rYHL4FcZXWoAqzX0uMs4yW0ClhlbbEuJXgMrhVxh/tADpzetQR6wAyU3rVE+kAKnN6lhXnACJTepcX5wAAhYgbXYQ6owRIKkppHojBEhpBrHuCAEELEDCLCDXv1wA2bgCrLY/hZV9cAWAs0wAZ39GP1DPBXxyvD1++bf998dGAiXA/4L/9zMUEZbcETR7uftO8F8xW4TZdxC1PwT+JPwz/j+d1gKcFd7RWIK2Apwd2tFUgrYCSKgAMw6AV83WY8IqMPuA7AoAp50AV8/So9lZoJ0AchsKAEcB4CgAHAWAowBw2glw9dW7vdll4nYCSLgAM653XzVL9wmz3/sBZCptt4CzZ+vebO9vL8CZoe1Nw28vwBnh7Y3DX/qauBX3wd9yJW9fEPyKV8qhbgv/DNXnAqACUJb1EmeA9DdoUvrR/hAowQK4CqzvgysAnOUC0FeBsbj+5QLIWiIEWD0LyHVHCJDSDGK9MQIkNYVUZ5QAMp84AZJmB6G+OAESm9S5rkgBUpvVsZ5YAZKb1qmOaAHSm9dh/CV+OLLi20VHePBlVoCKTR1FxllOgArNHeHjK70FJG8Jo1jwLQRIEGEUDb6VACtEGMWDbynA1TKMJqEjBPipFKNh2BtdAGnwNVDORQHgKAAcBYCjAHAUAI4CwFEAOAoARwHgKAAcBYCjAHAUAI4CwFEAOAoARwHgKAAcBYCjAHAUAI4CwFEAOAoARwHg/AUhGM3E3ulv7QAAAABJRU5ErkJggg=='

const cmd = process.argv[2] || 'hello'
const args = process.argv.slice(3)

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || '' } catch { return '' }
}
function saveToken(t) {
  try { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: t }, null, 2), 'utf8') } catch {}
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', (e) => reject(new Error('连不上 VTS API（8001 开了吗？）')))
  })
}

let msgId = 0
function send(ws, type, data = {}) {
  msgId++
  const payload = { apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID: 'agent-' + msgId, messageType: type, data }
  ws.send(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(type + ' 超时（如果是第一次，VTS 里会弹允许框，要去点 Allow）')), 60000)
    const onMsg = (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.requestID !== payload.requestID) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      if (m.messageType === 'APIError') reject(new Error(type + ' 失败: ' + JSON.stringify(m.data).slice(0, 200)))
      else resolve(m.data)
    }
    ws.addEventListener('message', onMsg)
  })
}

async function ensureAuth(ws) {
  const st = await send(ws, 'APIStateRequest')
  if (st.active === false) throw new Error('VTS API 未激活：设置 → API → 启用')
  let token = readToken()
  if (!token) {
    const req = await send(ws, 'AuthenticationTokenRequest', {
      pluginName: PLUGIN_NAME, pluginDeveloper: DEV_NAME, pluginIcon: PLUGIN_ICON,
    })
    token = req.authenticationToken
    saveToken(token)
    console.log('  已获取 token（VTS 里如果弹了允许框，请点 Allow）')
  }
  const auth = await send(ws, 'AuthenticationRequest', {
    pluginName: PLUGIN_NAME, pluginDeveloper: DEV_NAME, authenticationToken: token,
  })
  if (!auth.authenticated) {
    // token 失效：重新要一个
    const req = await send(ws, 'AuthenticationTokenRequest', { pluginName: PLUGIN_NAME, pluginDeveloper: DEV_NAME, pluginIcon: PLUGIN_ICON })
    saveToken(req.authenticationToken)
    const again = await send(ws, 'AuthenticationRequest', { pluginName: PLUGIN_NAME, pluginDeveloper: DEV_NAME, authenticationToken: req.authenticationToken })
    if (!again.authenticated) throw new Error('鉴权失败：' + (again.reason || '未知'))
  }
  return auth
}

const ws = await connect()
try {
  await ensureAuth(ws)

  if (cmd === 'hello') {
    const model = await send(ws, 'CurrentModelRequest')
    console.log('  模型: ' + (model.modelName || '?') + '  (' + (model.modelID || '') + ')')
    const params = await send(ws, 'InputParameterListRequest')
    const names = (params.defaultParameters || []).map((p) => p.name)
    const custom = (params.customParameters || []).map((p) => p.name)
    console.log('  默认参数 ' + names.length + ' 个: ' + names.slice(0, 12).join(', '))
    console.log('  自定义参数 ' + custom.length + ' 个: ' + custom.slice(0, 16).join(', '))
    try {
      const hk = await send(ws, 'HotkeysInCurrentModelRequest')
      const list = hk.availableHotkeys || []
      console.log('  热键 ' + list.length + ' 个:')
      for (const h of list.slice(0, 20)) console.log('    - ' + h.name + '  [' + h.hotkeyID + ']  type=' + h.type)
    } catch {}
  } else if (cmd === 'param') {
    const [id, v] = args
    if (!id) throw new Error('用法: param <参数名> <值>')
    await send(ws, 'InjectParameterDataRequest', {
      faceFound: false, mode: 'set',
      parameterValues: [{ id, value: Number(v ?? 0) }],
    })
    console.log('  ' + id + ' = ' + Number(v ?? 0))
  } else if (cmd === 'hotkey') {
    const id = args[0]
    if (!id) throw new Error('用法: hotkey <HotkeyID>')
    await send(ws, 'HotkeyTriggerRequest', { hotkeyID: id })
    console.log('  已触发 ' + id)
  } else {
    console.log('未知命令: ' + cmd)
  }
} finally {
  try { ws.close() } catch {}
}
