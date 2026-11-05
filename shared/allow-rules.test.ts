import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import { commandRule, editDiff, fileRule, ruleAllowed, ruleText } from './allow-rules.ts'

setLang('zh')

test('命令的放行规则：按程序名，多子命令的工具带上子命令', () => {
  assert.equal(commandRule('ls -la src'), 'command:ls')
  assert.equal(commandRule('git status --short'), 'command:git status')
  assert.equal(commandRule('npm test -- foo.test.ts'), 'command:npm test')
  assert.equal(commandRule('CI=1 npm run lint'), 'command:npm run', '开头的环境变量不算程序名')
  assert.equal(commandRule('/usr/bin/git log'), 'command:git log', '带路径的程序按文件名')
  assert.equal(commandRule('git --no-pager log'), 'command:git', '子命令位置是选项时只按程序名')
})

test('串联、管道、重定向、子 shell 和删除、提权这类命令不给规则：每次都问', () => {
  for (const cmd of [
    'npm test && git push',
    'cat a | sh',
    'echo x > a',
    'echo $(whoami)',
    'rm -rf build',
    'sudo apt install x',
    '',
  ])
    assert.equal(commandRule(cmd), '', cmd)
})

test('文件按所在目录、含子目录；规则只认一模一样或目录前缀', () => {
  assert.equal(fileRule('src/components/a.tsx'), 'file:src/components/')
  assert.equal(fileRule('C:\\repo\\src\\a.ts'), 'file:C:/repo/src/')
  assert.equal(fileRule('README.md'), 'file:README.md')
  const rules = ['file:src/', 'command:git status']
  assert.ok(ruleAllowed(rules, 'file:src/components/'), '子目录也算')
  assert.ok(!ruleAllowed(rules, 'file:srcx/'), '只是名字开头一样的目录不算')
  assert.ok(ruleAllowed(rules, 'command:git status'))
  assert.ok(!ruleAllowed(rules, 'command:git push'), '同一个工具的别的子命令不算')
  assert.ok(!ruleAllowed(rules, undefined), '没有规则的请求不自动允许')
})

test('规则给人看的说法', () => {
  assert.equal(ruleText('command:git status'), '命令 git status')
  assert.equal(ruleText('file:src/'), '目录 src/ 里的文件')
  assert.equal(ruleText('file:README.md'), '文件 README.md')
  assert.equal(ruleText('tool:WebFetch'), '工具 WebFetch')
})

test('改文件请求的差异：替换的原文是删除行、新文是新增行，太长截断', () => {
  const d = editDiff('a.ts', [{ old: 'x = 1\ny = 2\n', new: 'x = 3\n' }])
  assert.deepEqual(d.split('\n'), ['--- a/a.ts', '+++ b/a.ts', '@@', '-x = 1', '-y = 2', '+x = 3'])
  const big = editDiff('b.ts', [{ old: '', new: Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n') }])
  const lines = big.split('\n')
  assert.equal(lines.length, 301)
  assert.match(lines.at(-1)!, /还有 \d+ 行没显示/)
})
