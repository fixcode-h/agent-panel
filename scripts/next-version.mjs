#!/usr/bin/env node
/**
 * 算出这次正式版的版本号：<主>.<次> 取 package.json 的 version，<修订号> 是同一个主、次版本下上一个正式版标签的修订号 + 1，
 * 这个主、次版本还没发过就从 0 开始。正式版标签不带后缀（v0.29.3），带 -dev 之类后缀的不算。
 *
 * 为什么不再用提交数：以前修订号是 `git rev-list --count HEAD`，两次出包之间合了几个提交就跳几个号
 * （v0.28.2770 → v0.28.2778 → v0.28.2780），看不出这是第几个版本，也看不出中间有没有漏发。
 *
 * 用法：node scripts/next-version.mjs   （读 package.json 和本地 git 标签，打印版本号，不带 v）
 * 出包的 checkout 要带上标签（fetch-depth: 0），否则会从 0 重新数。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** base 是 package.json 的 version；tags 是仓库里的标签（带不带 v 都行） */
export function nextVersion(base, tags) {
  const m = String(base).match(/^(\d+)\.(\d+)/)
  if (!m) throw new Error(`package.json 的 version 不是 <主>.<次>.<修订> 的格式：${base}`)
  const [, major, minor] = m
  const re = new RegExp(`^v?${major}\\.${minor}\\.(\\d+)$`)
  let last = -1
  for (const t of tags) {
    const hit = t.trim().match(re)
    if (hit) last = Math.max(last, Number(hit[1]))
  }
  return `${major}.${minor}.${last + 1}`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  process.stdout.write(nextVersion(pkg.version, tags) + '\n')
}
