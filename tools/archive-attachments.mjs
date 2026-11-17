#!/usr/bin/env node
// Recovery 早期: age does not mean a session no longer needs an attachment.
// Read-only inventory even without --dry. No move/delete mode.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const root = path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'attachments')
let files = 0, bytes = 0
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.isFile()) { files++; bytes += fs.statSync(file).size }
  }
}
if (fs.existsSync(root)) walk(root)
console.log(JSON.stringify({ readOnly: true, files, bytes, path: fs.existsSync(root) ? fs.realpathSync(root) : root,
  message: 'Attachments retained: historical sessions require original objects. Age-based moving is disabled.' }))