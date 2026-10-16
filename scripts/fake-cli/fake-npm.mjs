#!/usr/bin/env node
// 端到端测试用的假 npm：记下参数，输出一点像 npm 的内容
import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG + '.npm', JSON.stringify(args) + '\n')
// npm view <包> version：返回一个比假 CLI（0.0.1）新的版本
if (args[0] === 'view') {
  console.log('9.9.9')
  process.exit(0)
}
// npm prefix -g：给一个不存在的目录，假 CLI 就不算 npm 装的
if (args[0] === 'prefix') {
  console.log('/nonexistent/fake-npm-prefix')
  process.exit(0)
}
// 装完以后假 CLI 报告新版本，模拟更新成功
if (args[0] === 'install' && process.env.FAKE_CLI_LOG) writeFileSync(process.env.FAKE_CLI_LOG + '.ver', '9.9.9')
process.stderr.write('npm warn deprecated something@1.0.0\n')
console.log(args[0] === 'install' ? `added 1 package in 1s` : `removed 1 package in 1s`)
