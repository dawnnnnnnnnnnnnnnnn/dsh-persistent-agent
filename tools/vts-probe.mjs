import fs from 'node:fs';
import path from 'node:path'
import { DSH_HOME } from '../core/lib/config.mjs'
const TOKEN = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'bili-whale', 'vts-token.json'), 'utf8')).token;
const ws = new WebSocket('ws://127.0.0.1:8001');
const log = (...a) => console.log(...a);
ws.onopen = () => log('[open]');
ws.onmessage = (ev) => log('[<<]', typeof ev.data === 'string' ? ev.data.slice(0, 400) : '<binary>');
ws.onclose = (e) => log('[close]', e.code, e.reason);
ws.onerror = (e) => log('[error]', e.message || e.type);
const send = (id, t, data = {}) => ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID: id, messageType: t, data }));
setTimeout(() => send('a1', 'APIStateRequest'), 300);
setTimeout(() => send('a2', 'AuthenticationRequest', { pluginName: 'XiXi-Helper', pluginDeveloper: 'Zhujingrui', authenticationToken: TOKEN }), 900);
setTimeout(() => send('a3', 'CurrentModelRequest'), 1600);
setTimeout(() => send('a4', 'ExpressionStateRequest', { details: true }), 2300);
setTimeout(() => send('a5', 'ExpressionActivationRequest', { expression: '体型1', active: true }), 3000);
setTimeout(() => { ws.close(); process.exit(0); }, 6000);
