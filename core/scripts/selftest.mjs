#!/usr/bin/env node
// 离线自测：不走 DSH，直接跑 tiers + memory，验证产出
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildAll } from '../lib/tiers.mjs'
import { buildIndex, search } from '../lib/memory.mjs'

const DSH = path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
const a = buildAll()
console.log('=== tiers ===')
console.log('context 字数:', a.context.length, '｜volatile 字数:', a.volatile.length, '｜合计:', a.composed.length)
console.log('--- context 前 300 字 ---')
console.log(a.context.slice(0, 300))
console.log('--- volatile ---')
console.log(a.volatile)

console.log('\n=== memory index ===')
const idx = buildIndex(path.join(DSH, 'memory'))
console.log('文件:', idx.files, '｜chunk:', idx.chunks, '｜倒排词:', Object.keys(idx.index.postings).length)
for (const q of ['生日', '心跳', '空间', '声音']) {
  const hits = search(idx, q, 2)
  console.log(`  「${q}」→ ${hits.length} 命中` + (hits[0] ? `（${hits[0].file} / ${hits[0].heading}）` : ''))
}
