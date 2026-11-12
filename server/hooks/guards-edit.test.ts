/**
 * 改文件前的两个守卫（借鉴 ECC）：改之前先看过、不许改检查配置。都只拦一次。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Task, ToolUse } from '../../shared/schema.ts'
import { checkConfigDeny, editTargets, isCheckConfig, readBeforeEditDeny } from './guards-edit.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-guards-edit-'))
mkdirSync(path.join(dir, 'src'), { recursive: true })
mkdirSync(path.join(dir, '.tmp'), { recursive: true })
for (const f of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', '.tmp/x.ts', 'tsconfig.json'])
  writeFileSync(path.join(dir, f), 'x')

const edit = (...files: string[]) => ({
  tool: { kind: 'edit' as const, name: 'Edit', input: {}, path: files[0], paths: files },
})
const sh = (command: string) => ({
  tool: { kind: 'shell' as const, name: 'Bash', input: { command }, path: '', paths: [] },
})
const tool = (x: Partial<ToolUse> & Pick<ToolUse, 'kind'>): ToolUse => ({ label: '', detail: '', ...x }) as ToolUse
const task = (id: string, tools: ToolUse[] = []) =>
  ({ id, messages: [{ id: 'm', role: 'agent', text: '', tools, at: '' }] }) as unknown as Pick<Task, 'id' | 'messages'>

test('改之前先看过：没读过的已有文件拦一次，第二次放行；新文件、临时目录不拦', () => {
  assert.match(readBeforeEditDeny(dir, task('t1'), edit('src/a.ts')), /还没读过/)
  assert.equal(readBeforeEditDeny(dir, task('t1'), edit('src/a.ts')), '', '第二次放行')
  assert.equal(readBeforeEditDeny(dir, task('t1'), edit('src/new.ts')), '', '新建的文件')
  assert.equal(readBeforeEditDeny(dir, task('t1'), edit('.tmp/x.ts')), '', '临时文件')
})

test('改之前先看过：读过、搜到过、命令里看过的放行；压缩之前读的不算；改过和 sed -i 本身不算看过', () => {
  const abs = path.join(dir, 'src/b.ts').replace(/\\/g, '/')
  assert.equal(readBeforeEditDeny(dir, task('r1', [tool({ kind: 'read', label: abs })]), edit('src/b.ts')), '')
  assert.equal(
    readBeforeEditDeny(
      dir,
      task('r2', [tool({ kind: 'search', label: 'foo', output: 'src/b.ts:3: foo' })]),
      edit('src/b.ts'),
    ),
    '',
  )
  assert.equal(
    readBeforeEditDeny(
      dir,
      task('r3', [tool({ kind: 'run', label: 'cat src/b.ts', input: 'cat src/b.ts' })]),
      edit('src/b.ts'),
    ),
    '',
  )
  const compacted = task('r4', [tool({ kind: 'read', label: 'src/c.ts' }), tool({ kind: 'compact', label: '' })])
  assert.match(readBeforeEditDeny(dir, compacted, edit('src/c.ts')), /还没读过/)
  assert.match(
    readBeforeEditDeny(dir, task('r5', [tool({ kind: 'edit', label: 'src/d.ts' })]), edit('src/d.ts')),
    /还没读过/,
  )
  const sed = "sed -i 's/a/b/' src/a.ts"
  assert.match(
    readBeforeEditDeny(dir, task('r6', [tool({ kind: 'run', label: sed, input: sed })]), sh(sed)),
    /src\/a\.ts/,
  )
})

test('改文件的目标：改文件工具点名的，加 sed -i 的最后一个文件；别的命令不猜', () => {
  assert.deepEqual(editTargets(edit('a', 'b')), ['a', 'b'])
  assert.deepEqual(editTargets(sh("cd x && sed -i 's/a/b/g' src/a.ts")), ['src/a.ts'])
  assert.deepEqual(editTargets(sh("sed -i.bak -e '1d' a.txt")), ['a.txt'])
  assert.deepEqual(editTargets(sh("sed -n '1,5p' a.txt")), [])
  assert.deepEqual(editTargets(sh('echo x > a.txt')), [])
})

test('不许改检查配置：默认的和参数加的都拦一次，第二次放行；普通文件、临时目录不拦', () => {
  assert.ok(isCheckConfig('tsconfig.web.json', []) === false, '不传通配就没有')
  assert.match(checkConfigDeny(dir, 'c1', [], edit('tsconfig.json')), /检查配置/)
  assert.equal(checkConfigDeny(dir, 'c1', [], edit('tsconfig.json')), '', '说明原因后再改放行')
  assert.match(checkConfigDeny(dir, 'c2', [], edit('web/.eslintrc.cjs')), /eslintrc/, '任意目录按文件名')
  assert.match(checkConfigDeny(dir, 'c2', [], sh("sed -i 's/strict/x/' config/vitest.config.ts")), /vitest/)
  assert.match(checkConfigDeny(dir, 'c3', ['scripts/file-caps.json'], edit('scripts/file-caps.json')), /file-caps/)
  assert.equal(
    checkConfigDeny(dir, 'c4', ['scripts/file-caps.json'], edit('other/scripts/file-caps.json')),
    '',
    '带目录按相对路径比',
  )
  assert.equal(checkConfigDeny(dir, 'c4', [], edit('src/a.ts')), '')
  assert.equal(checkConfigDeny(dir, 'c4', [], edit('.tmp/tsconfig.json')), '')
})
