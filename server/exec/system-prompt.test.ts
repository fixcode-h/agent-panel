/**
 * 角色说明不能塞进参数里：Windows 上 npm 安装的 CLI 是 .cmd 垫片，要经过 cmd.exe，
 * 参数里的换行会把整条命令行截断，后面的参数（Pi 的 -e 桥接扩展）全部丢失，模型只剩内建工具。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { getCli } from '../../shared/clis.ts'
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
