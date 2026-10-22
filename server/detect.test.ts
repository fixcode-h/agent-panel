import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failLine } from './detect.ts'

test('Node 崩溃时挑出真正的错误，不是 node:internal 的源码位置', () => {
  const stderr = [
    'node:internal/modules/esm/resolve:271',
    '    throw new ERR_MODULE_NOT_FOUND(',
    '          ^',
    '',
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\npm\\node_modules\\command-code\\dist\\x.mjs' imported from C:\\npm\\node_modules\\command-code\\dist\\index.mjs",
    '    at finalizeResolution (node:internal/modules/esm/resolve:271:11)',
    '',
    'Node.js v24.1.0',
  ].join('\r\n')
  assert.match(failLine('', stderr), /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/)
})

test('普通的报错原样取第一行', () => {
  assert.equal(failLine('', 'Command Code needs Node.js 22 or newer\nmore'), 'Command Code needs Node.js 22 or newer')
  assert.equal(failLine('usage: x', ''), 'usage: x')
  assert.equal(failLine('', ''), '')
})
