#!/usr/bin/env node
/**
 * wake.mjs —— 到点给使用者发一句话（不烧 token，纯本地闹钟）
 *
 * 用法：
 *   node wake.mjs --at 15:45 --text "起来上课"          # 挂一个闹钟，立刻返回
 *   node wake.mjs --in 45 --text "起来上课"             # 45 分钟后
 *   node wake.mjs --at 15:45 --text "..." --show        # 只看会怎么算，不挂
 *   node wake.mjs --list                                # 看已挂的
 *   node wake.mjs --clear                               # 全撤
 *
 * 原理：spawn 一个脱离父进程的 node 进程，setTimeout 到点后调 qq-api.mjs 发私聊。
 * 不依赖心跳、不依赖 DSH 会话、不消耗模型额度。
 * 注意：电脑关机/重启会丢（待挂表存在 state.json 里，可以自己重建）。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onebot } from '../config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(__dirname, 'qq-api.mjs');
const STATE = path.join(__dirname, 'wake-state.json');
const OWNER = onebot.ownerQQ;

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d = undefined) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return []; }
}
function saveState(list) {
  try { fs.writeFileSync(STATE, JSON.stringify(list, null, 2), 'utf8'); } catch {}
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function stamp(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmt(d)}`; }

function resolveTarget() {
  const at = opt('--at');
  const inMin = opt('--in');
  const now = new Date();
  if (inMin) {
    const m = Number(inMin);
    if (!Number.isFinite(m) || m < 1) throw new Error('--in 要给正整数分钟');
    return new Date(Date.now() + m * 60000);
  }
  if (at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
    if (!m) throw new Error('--at 要写成 HH:mm，例如 15:45');
    const t = new Date(now);
    t.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (t.getTime() <= now.getTime() + 5000) t.setDate(t.getDate() + 1); // 过了就挂明天
    return t;
  }
  throw new Error('要给 --at HH:mm 或 --in 分钟');
}

function fire(text, to = OWNER) {
  try {
    execFileSync(process.execPath, [API, 'send_private_msg', JSON.stringify({
      user_id: Number(to),
      message: [{ type: 'text', data: { text } }],
    })], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// ── 从属模式：真正等时间的那层 ──────────────────────────────
if (has('--run')) {
  const ms = Number(opt('--ms', '0'));
  const text = opt('--text', '到点了');
  const to = opt('--to', OWNER);
  const id = opt('--id', '');
  setTimeout(() => {
    fire(text, to);
    if (id) saveState(loadState().filter((x) => x.id !== id));
    process.exit(0);
  }, Math.max(0, ms));
} else if (has('--list')) {
  const list = loadState();
  if (!list.length) console.log('没有挂着的闹钟');
  else list.forEach((x) => console.log(`${x.when}  #${x.id}  ${x.text}`));
} else if (has('--clear')) {
  saveState([]);
  console.log('挂表已清空（已经跑起来的进程要靠关机或 --kill 处理）');
} else {
  // ── 主模式：算时间，派一个脱离的进程，立刻返回 ──
  const target = resolveTarget();
  const text = opt('--text', '到点了，起来');
  const to = opt('--to', OWNER);
  const ms = target.getTime() - Date.now();

  if (has('--show')) {
    console.log(`会在 ${stamp(target)}（${Math.round(ms / 60000)} 分钟后）发给 ${to}：${text}`);
    process.exit(0);
  }

  const id = `${Date.now().toString(36)}`;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run',
    '--ms', String(ms), '--text', text, '--to', to, '--id', id,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  const list = loadState();
  list.push({ id, when: stamp(target), text, to, pid: child.pid });
  saveState(list);

  console.log(`挂上了：${stamp(target)}（${Math.round(ms / 60000)} 分钟后）→ ${text}`);
}
