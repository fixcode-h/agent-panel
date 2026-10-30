#!/usr/bin/env node
/**
 * 把面板导出的对话包转成假 CLI 的回放录像（见 scripts/lib/replay-export.mjs、scripts/fake-cli/replay.mjs）。
 *
 * 用法：node scripts/replay-from-export.mjs <对话包.task.json> <录像.jsonl> [--child <子对话 id>]
 * 录像放 scripts/e2e/fixtures/replay/，再在 e2e 里用 FAKE_REPLAY 指向它回放。导出包已经去过密钥，
 * 存进仓库前仍要看一遍有没有个人信息和本机路径。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { exportToReplay } from './lib/replay-export.mjs'

const args = process.argv.slice(2)
const ci = args.indexOf('--child')
const child = ci >= 0 ? args.splice(ci, 2)[1] : ''
const [from, to] = args
if (!from || !to) {
  console.error('用法：node scripts/replay-from-export.mjs <对话包.task.json> <录像.jsonl> [--child <子对话 id>]')
  process.exit(1)
}
const lines = exportToReplay(JSON.parse(readFileSync(from, 'utf8')), child)
writeFileSync(to, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
console.log(`写好了 ${to}：${lines.filter((l) => l.type === 'result').length} 轮，${lines.length} 行`)
