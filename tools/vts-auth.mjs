// 持久连接版：每 8 秒重发一次 TokenRequest，直到拿到 token（VTS 的允许框每次请求都会弹）
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from '../core/lib/config.mjs'

const OUT = path.join(DSH_HOME, 'vts.json')
const LOG = path.join(DSH_HOME, 'bili-whale', 'vts-auth.log')
const log = (s) => {
  const line = '[' + new Date().toLocaleTimeString('sv-SE') + '] ' + s
  console.log(line)
  try { fs.appendFileSync(LOG, line + '\n') } catch {}
}

const ws = new WebSocket('ws://127.0.0.1:8001')
let n = 0
let got = ''

ws.addEventListener('open', () => {
  log('连接成功，开始每 8 秒申请一次 token（请在 VTS 里点 Allow）')
  const tick = () => {
    n++
    ws.send(JSON.stringify({
      apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0',
      requestID: 'tok-' + n,
      messageType: 'AuthenticationTokenRequest',
      data: {
        pluginName: 'agent-bridge', pluginDeveloper: process.env.VTS_DEV_NAME || 'agent',
        pluginIcon: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAC4ElEQVR4nO2du1EkQRAFBwIdJ05Exg70UfABO84HlHGmvcGCOwnlIrhgg5nuV5WZKktEV73sz8Z89u7X08ufTbDcrx6ArEUB4CgAHAWAowBwFACOAsBRADgKAEcB4CgAHAWAowBwFACOAsBRADgKAEcB4CgAHAWAowBwFACOAsBRADgKAEcB4CgAnIcNxPPr+7c/O95fNwJ3XR8OvSVsshStBLgi9O4ytBBgZvDdRCgtwMrgu4hQUoCk4KuLUO5rYHL4FcZXWoAqzX0uMs4yW0ClhlbbEuJXgMrhVxh/tADpzetQR6wAyU3rVE+kAKnN6lhXnACJTepcX5wAAhYgbXYQ6owRIKkppHojBEhpBrHuCAEELEDCLCDXv1wA2bgCrLY/hZV9cAWAs0wAZ39GP1DPBXxyvD1++bf998dGAiXA/4L/9zMUEZbcETR7uftO8F8xW4TZdxC1PwT+JPwz/j+d1gKcFd7RWIK2Apwd2tFUgrYCSKgAMw6AV83WY8IqMPuA7AoAp50AV8/So9lZoJ0AchsKAEcB4CgAHAWAowBw2glw9dW7vdll4nYCSLgAM653XzVL9wmz3/sBZCptt4CzZ+vebO9vL8CZoe1Nw28vwBnh7Y3DX/qauBX3wd9yJW9fEPyKV8qhbgv/DNXnAqACUJb1EmeA9DdoUvrR/hAowQK4CqzvgysAnOUC0FeBsbj+5QLIWiIEWD0LyHVHCJDSDGK9MQIkNYVUZ5QAMp84AZJmB6G+OAESm9S5rkgBUpvVsZ5YAZKb1qmOaAHSm9dh/CV+OLLi20VHePBlVoCKTR1FxllOgArNHeHjK70FJG8Jo1jwLQRIEGEUDb6VACtEGMWDbynA1TKMJqEjBPipFKNh2BtdAGnwNVDORQHgKAAcBYCjAHAUAI4CwFEAOAoARwHgKAAcBYCjAHAUAI4CwFEAOAoARwHgKAAcBYCjAHAUAI4CwFEAOAoARwHg/AUhGM3E3ulv7QAAAABJRU5ErkJggg==',
      },
    }))
    log('→ 第 ' + n + ' 次申请')
  }
  tick()
  const timer = setInterval(() => { if (got) return clearInterval(timer); tick() }, 8000)
  setTimeout(() => { log('60 秒到了，结束'); try { ws.close() } catch {}; process.exit(got ? 0 : 1) }, 60000)
})

ws.addEventListener('message', (ev) => {
  const s = typeof ev.data === 'string' ? ev.data : ''
  if (!s) { log('← (空包)'); return }
  let m
  try { m = JSON.parse(s) } catch { return }
  if (m.messageType === 'AuthenticationTokenResponse') {
    got = m.data?.authenticationToken || ''
    if (got) {
      fs.writeFileSync(OUT, JSON.stringify({ token: got }, null, 2), 'utf8')
      log('✓ 拿到 token，已存 ' + OUT)
      try { ws.close() } catch {}
      process.exit(0)
    }
  } else if (m.messageType === 'APIError') {
    log('← 错误: ' + JSON.stringify(m.data).slice(0, 200))
  }
})

ws.addEventListener('error', () => log('WS 错误'))
