#!/usr/bin/env node
// 端到端测试用的假 npm：记下参数，输出一点像 npm 的内容
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG + '.npm', JSON.stringify(args) + '\n')
// npm view <包> version：返回一个比假 CLI（0.0.1）新的版本
if (args[0] === 'view') {
  console.log('9.9.9')
  process.exit(0)
}
process.stderr.write('npm warn deprecated something@1.0.0\n')
console.log(args[0] === 'install' ? `added 1 package in 1s` : `removed 1 package in 1s`)
