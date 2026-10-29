/**
 * 角色说明不能塞进参数里：Windows 上 npm 安装的 CLI 是 .cmd 垫片，要经过 cmd.exe，
 * 参数里的换行会把整条命令行截断，后面的参数（Pi 的 -e 桥接扩展）全部丢失，模型只剩内建工具。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { getCli } from '../../shared/clis.ts'
import { PROMPT_LANG_ENV, promptLangModSource } from '../../shared/prompt-lang.ts'
import { writeSystemPrompt } from './invoke.ts'

const ROLE = '你是这个项目对话的统筹：判断用户的每条消息怎么处理。\n\n## 规则\n- 要动手的任务分给子对话\n- 不改文件'

test('Pi 的角色说明走文件参数，参数里不带换行', () => {
  const def = getCli('pi')!
  assert.equal(def.systemPromptFileFlag, '--append-system-prompt')
  // invoke 先把角色说明写成文件，参数里只放路径
  const args = def.buildArgs({
    model: 'deepseek/deepseek-flash',
    permission: 'full',
    extraArgs: [],
    systemPrompt: '/tmp/x/system-prompt.md',
  })
  assert.deepEqual(args.slice(-2), ['--append-system-prompt', '/tmp/x/system-prompt.md'])
  assert.ok(
    args.every((a) => !/[\r\n]/.test(a)),
    '参数里不能有换行',
  )
})

test('写角色说明文件：内容原样保留换行，路径里没有换行', async () => {
  const { dir, file } = await writeSystemPrompt(ROLE)
  try {
    assert.equal(await readFile(file, 'utf8'), ROLE)
    assert.ok(!/[\r\n]/.test(file))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Command Code 用 --mod 追加语言规则，没有路径时不传这个参数', () => {
  const def = getCli('commandcode')!
  assert.equal(def.systemPromptMod, true)
  // 常驻协议走 rpcArgs：面板实际就是这样启动 Command Code 的
  const mod = '/data/mods/agent-panel-prompt-lang.mjs'
  const args = def.buildArgs({
    model: 'deepseek/deepseek-v4-flash',
    permission: 'accept-edits',
    extraArgs: [],
    systemPromptModPath: mod,
  })
  const at = args.indexOf('--mod')
  assert.ok(at >= 0, '要用 --mod 加载追加语言规则的 mod')
  assert.equal(args[at + 1], mod)
  const plain = def.buildArgs({ model: 'deepseek/deepseek-v4-flash', permission: 'accept-edits', extraArgs: [] })
  assert.ok(!plain.includes('--mod'), '没有语言规则时不加载 mod')
})

test('系统提示词通道按 CLI 声明走：有 --append-system-prompt 的不用 mod', () => {
  for (const id of ['claude', 'codex', 'pi']) assert.equal(getCli(id)?.systemPromptFlag, true, id)
  assert.ok(!getCli('commandcode')?.systemPromptFlag)
  // Claude Code 的角色说明也走文件：上万字放进参数会超过 Windows 命令行上限（The command line is too long）
  const claude = getCli('claude')!
  assert.equal(claude.systemPromptFileFlag, '--append-system-prompt-file')
  const base = { model: 'claude-sonnet-5-5', permission: 'acceptEdits', extraArgs: [] }
  const file = claude.buildArgs({ ...base, systemPrompt: '/tmp/x/system-prompt.md', systemPromptFile: true })
  assert.equal(file[file.indexOf('--append-system-prompt-file') + 1], '/tmp/x/system-prompt.md')
  assert.ok(!file.includes('--append-system-prompt'))
  // 写文件失败时 invoke 照旧把文本放参数里，这时用不带 -file 的参数
  const inline = claude.buildArgs({ ...base, systemPrompt: ROLE })
  assert.equal(inline[inline.indexOf('--append-system-prompt') + 1], ROLE)
})

test('语言 mod 源码：两种语言的规则都在，按环境变量取', () => {
  const src = promptLangModSource()
  assert.match(src, new RegExp(PROMPT_LANG_ENV))
  assert.match(src, /## 回复语言/)
  assert.match(src, /## Reply language/)
})
