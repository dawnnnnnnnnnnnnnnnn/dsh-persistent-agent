/**
 * seed-library.mjs —— 给生图参考库播种（角色 / 服装 / 场景 / 道具）
 *
 * SPDX-License-Identifier: MIT
 *
 * 这个脚本演示「参考库怎么组织」：每个条目是一组标签 + 一段描述 + 参考图路径。
 * 出图时按 cat / tags 挑条目，把描述拼进提示词。
 *
 * 重要：**条目内容全部是占位**。这个仓库不带任何角色设定——
 * 你用自己的 IDENTITY.md 里的描述替换 DESC，再按需要加条目。
 *
 * 用法：
 *   node seed-library.mjs --dry     只打印将要写入的条目
 *   node seed-library.mjs           写入 ~/.dsh/image-studio/library
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WORKSPACE } from '../core/lib/config.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const STUDIO = path.join(HOME, '.dsh', 'image-studio', 'library')
const REF = path.join(HOME, '.dsh', 'image-studio', 'refs')
const DRY = process.argv.includes('--dry')

// ↓↓↓ 换成你自己的角色描述（从 persona 层的 IDENTITY.md 抄）
const DESC = '<角色外观：年龄感、发型、瞳色、标志性特征（耳/角/尾之类）、体型。'
  + '写多少出多少，不写就按模型自己的偏好来。>'

const entries = [
  // ── 角色本身 ──
  {
    cat: 'characters',
    name: '<你的角色名>',
    tags: ['主角', '二次元'],
    description: DESC,
    traits: '<性格与微表情：例如"被夸会移开视线"；这些会被拼进出图提示词>',
    refs: [],   // 参考图自己放：REF/<文件名>.png
  },

  // ── 服装（可多件）──
  {
    cat: 'outfits',
    name: '<默认服装>',
    tags: ['日常'],
    description: '<服装描述：版型、颜色、材质、配饰>',
    refs: [],
  },

  // ── 场景（可多个）──
  {
    cat: 'scenes',
    name: '<场景名>',
    tags: ['室内', '暖光'],
    description: '<场景描述：地点、光线、时间、环境细节>',
    defaultOutfit: '<这件场景默认穿什么>',
    refs: [],
  },

  // ── 道具（可多个）──
  {
    cat: 'props',
    name: '<道具名>',
    tags: ['小物'],
    description: '<道具描述：形状、材质、颜色>',
    refs: [],
  },
]

// ── 写入 ──
if (DRY) {
  console.log('将要写入 ' + entries.length + ' 条（--dry，不落盘）：')
  for (const e of entries) console.log('  [' + e.cat + '] ' + e.name + '  ' + (e.description || '').slice(0, 40) + '…')
  console.log('\n参考图目录：' + REF)
  process.exit(0)
}

fs.mkdirSync(STUDIO, { recursive: true })
const file = path.join(STUDIO, 'entries.json')
const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
const byName = new Map(old.map((e) => [e.cat + '/' + e.name, e]))
for (const e of entries) byName.set(e.cat + '/' + e.name, e)
fs.writeFileSync(file, JSON.stringify([...byName.values()], null, 2), 'utf8')
console.log('已写入 ' + byName.size + ' 条 → ' + file)
console.log('参考图放这里：' + REF)
