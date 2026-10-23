import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveProposal } from '../shared/assist.ts'

// 数据目录和用户目录都换成临时的：DATA_DIR 在导入时就定了，所以先设环境变量再动态导入
const home = await mkdtemp(path.join(os.tmpdir(), 'slash-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.AGENT_PANEL_DATA = path.join(home, '.agent-panel')
const { expandSlash, listCommands } = await import('./slash.ts')
const { writeLibrary, listLibrary } = await import('./library.ts')
const { ALL_AGENTS } = await import('../shared/commands.ts')

await writeLibrary(
  ALL_AGENTS,
  'command',
  'changelog',
  '---\ndescription: 整理更新说明\nargument-hint: [起点]\n---\n从 $ARGUMENTS 开始整理更新说明。\n',
  true,
)
await mkdir(path.join(home, '.claude', 'commands'), { recursive: true })
await writeFile(
  path.join(home, '.claude', 'commands', 'commit.md'),
  '---\ndescription: 我自己的提交\n---\n按我的习惯提交\n',
)

test('「所有 Agent」的命令出现在每个 CLI 的菜单里', async () => {
  for (const cli of ['claude', 'gemini']) {
    const list = await listCommands(cli, '')
    const c = list.find((x) => x.name === 'changelog')
    assert.equal(c?.kind, 'command', cli)
    assert.equal(c?.hint, '[起点]')
  }
  const lib = await listLibrary('command')
  assert.ok(lib.some((i) => i.cli === ALL_AGENTS && i.name === 'changelog'))
})

test('「所有 Agent」的命令由面板展开，Claude Code 也一样', async () => {
  const want = '从 v1.2 开始整理更新说明。'
  assert.equal(await expandSlash('/changelog v1.2', 'claude', '', true), want)
  assert.equal(await expandSlash('/changelog v1.2', 'gemini', '', false), want)
})

test('内置命令：CLI 自己有的原样发，没有的由面板展开', async () => {
  assert.equal(await expandSlash('/init', 'claude', '', true), '/init')
  assert.match(await expandSlash('/init', 'gemini', '', false), /AGENTS\.md/)
  assert.match(await expandSlash('/security-review', 'gemini', '', false), /安全审查/)
  const fix = await expandSlash('/fix 登录后白屏', 'claude', '', true)
  assert.match(fix, /## 问题\n登录后白屏$/)
  // 没写参数：去掉空的「问题」小节，范围换成默认说法
  assert.doesNotMatch(await expandSlash('/fix', 'gemini', '', false), /## 问题/)
  assert.match(await expandSlash('/test', 'gemini', '', false), /给最近的改动/)
})

test('CLI 自己的同名命令优先于内置命令', async () => {
  // Claude Code 自己认识，原样发
  assert.equal(await expandSlash('/commit', 'claude', '', true), '/commit')
  // 续接的会话里（native 为 false）展开成它自己的命令，而不是内置的 /commit
  assert.equal(await expandSlash('/commit', 'claude', '', false), '按我的习惯提交')
})

test('不认识的命令原样发出', async () => {
  assert.equal(await expandSlash('/nope 1', 'gemini', '', false), '/nope 1')
})

test('AI 创建命令：校验 front matter、命令名不和内置的重名', () => {
  const ctx = { agents: [], categories: [], workflows: [], rules: '', subject: { taken: 'changelog' } }
  const ok = resolveProposal(
    'command',
    { name: 'fix-issue', content: '---\ndescription: 修 issue\n---\n修复 issue $1' },
    ctx,
  )
  assert.equal(ok.proposal?.kind, 'command')
  assert.match(
    resolveProposal('command', { name: 'commit', content: '---\ndescription: x\n---\ny' }, ctx).error ?? '',
    /commit/,
  )
  assert.match(
    resolveProposal('command', { name: 'changelog', content: '---\ndescription: x\n---\ny' }, ctx).error ?? '',
    /changelog/,
  )
  assert.ok(resolveProposal('command', { name: 'a', content: '没有 front matter' }, ctx).error)
  assert.ok(resolveProposal('command', { name: 'a', content: '---\ndescription: x\n---\n' }, ctx).error)
})
