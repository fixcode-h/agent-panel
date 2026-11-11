/**
 * 少占上下文的守卫和提醒（工作包 I）：读大文件前拦一次、大输出事后提醒。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bigOutputHint, bigReadDeny } from './guards-context.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-bigread-'))
writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(80 * 1024))
writeFileSync(path.join(dir, 'small.ts'), 'x'.repeat(1024))
writeFileSync(path.join(dir, 'pic.png'), 'x'.repeat(80 * 1024))

const read = (file: string, ranged = false) => ({
  tool: { kind: 'read' as const, name: 'Read', input: { file_path: file }, path: file, paths: [file], ranged },
})
const sh = (command: string) => ({
  tool: { kind: 'shell' as const, name: 'Bash', input: { command }, path: '', paths: [] },
})

test('读大文件：整份读超过阈值拒绝一次，同一个文件再读放行；分段读、小文件、图片不拦', () => {
  assert.match(bigReadDeny(dir, 't1', 64, read('big.log')), /80 KB.*offset/)
  assert.equal(bigReadDeny(dir, 't1', 64, read('big.log')), '', '同一个文件第二次放行')
  assert.equal(bigReadDeny(dir, 't2', 64, read('big.log', true)), '', '带了分段参数')
  assert.equal(bigReadDeny(dir, 't2', 64, read('small.ts')), '')
  assert.equal(bigReadDeny(dir, 't2', 64, read('pic.png')), '', '图片不是整段文字')
  assert.equal(bigReadDeny(dir, 't2', 0, read('big.log')), '', '0 表示不拦')
  assert.equal(bigReadDeny(dir, 't2', 64, read('missing.txt')), '')
  // 定义里没写分段参数的 CLI：ranged 不带，不知道怎么分段就不管
  const unknown = { tool: { ...read('big.log').tool, ranged: undefined } }
  assert.equal(bigReadDeny(dir, 't3', 64, unknown), '')
})

test('读大文件：shell 里只管单独一条 cat / Get-Content，接了管道、重定向、只取一段的放行', () => {
  assert.match(bigReadDeny(dir, 's1', 64, sh('cat big.log')), /rg -n/)
  assert.match(bigReadDeny(dir, 's2', 64, sh(`Get-Content "${path.join(dir, 'big.log')}"`)), /big\.log/)
  assert.equal(bigReadDeny(dir, 's3', 64, sh('cat big.log | rg error')), '')
  assert.equal(bigReadDeny(dir, 's3', 64, sh('cat big.log > out.txt')), '')
  assert.equal(bigReadDeny(dir, 's3', 64, sh('Get-Content big.log -Tail 200')), '')
  assert.equal(bigReadDeny(dir, 's3', 64, sh('tail -n 200 big.log')), '')
  assert.equal(bigReadDeny(dir, 's3', 64, sh('cd sub && cat big.log')), '', '多段命令不猜目录')
})

test('大输出提醒：按截短前的字数算，只管命令和读文件，后台命令能用时才提 run_background', () => {
  const out = (kind: 'shell' | 'read' | 'edit', size: number) => ({
    tool: { kind, name: 'X', input: {}, path: '', paths: [], result: { output: 'x', size } },
  })
  assert.match(bigOutputHint(out('shell', 30000), 20000, true), /30000 字.*run_background/)
  assert.doesNotMatch(bigOutputHint(out('shell', 30000), 20000, false), /run_background/)
  assert.match(bigOutputHint(out('read', 30000), 20000, false), /读进来的内容/)
  assert.equal(bigOutputHint(out('shell', 10000), 20000, true), '')
  assert.equal(bigOutputHint(out('edit', 30000), 20000, true), '')
  assert.equal(bigOutputHint(out('shell', 30000), 0, true), '', '0 表示不提醒')
})
