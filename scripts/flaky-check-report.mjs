#!/usr/bin/env node
/**
 * 读 logs/tests/flaky-report.json，有抖动的单元就非零退出（CI 的 test job 跑完单测后调，见 openspec test-governance 6.11）。
 * 重跑通过的单测退出码是 0，只看退出码会把抖动藏起来；报告不存在按没有抖动算。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeFlakyReport, readFlakyReport } from './lib/flaky-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ok, lines } = judgeFlakyReport(readFlakyReport(root))
console.log(lines.join('\n'))
process.exitCode = ok ? 0 : 1
