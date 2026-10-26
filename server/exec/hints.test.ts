/**
 * CLI 报错的说明：常见的报错换成能照着做的话。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import type { TaskMessage } from '../../shared/schema.ts'
import { claimsUnsentHandoff, describeCompaction, failureHints, looksUnfinished, settleNetNotes } from './runner.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

const gemini = { id: 'gemini', name: 'Gemini CLI' }

test('Google 不再支持个人账号用 Gemini CLI：说明是服务端限制，指到 API 方式', () => {
  const detail =
    'An unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.'
  const hints = failureHints(detail, gemini)
  assert.equal(hints.length, 1)
  assert.match(hints[0], /Google 服务端的限制/)
  assert.match(hints[0], /API 配置/)
})

test('普通的报错不加说明', () => {
  assert.deepEqual(failureHints('something else went wrong', gemini), [])
})

test('Pi 没配 API Key：提示在终端里登录', () => {
  const hints = failureHints('No API key found for anthropic.\n\nUse /login to log into a provider', {
    id: 'pi',
    name: 'Pi',
  })
  assert.equal(hints.length, 1)
  assert.match(hints[0], /运行 pi，在里面输入 \/login/)
})

test('Command Code 的响应流中途断开：按断流处理，给出续接说明', () => {
  const hints = failureHints('Failed to process successful response', { id: 'commandcode', name: 'Command Code' })
  assert.equal(hints.length, 1)
  assert.match(hints[0], /连接中途断开/)
})

test('自动续接成功后，断开时的报错不再显示成错误', () => {
  const msg: TaskMessage = {
    id: 'n1',
    role: 'system',
    agentId: '',
    step: '',
    text: 'Command Code 执行失败：\n原始输出：\nFailed to process successful response\n\n正在自动续接会话重试（第 1/2 次）…',
    tools: [],
    at: '',
    error: true,
  }
  settleNetNotes([{ msg, base: 'Command Code 执行失败：\n原始输出：\nFailed to process successful response', n: 1 }])
  assert.equal(msg.error, undefined, '这一轮最终成功了，不能一直挂着红色错误')
  assert.equal(msg.transient, true, '继续执行时要能去掉')
  assert.match(msg.text, /Failed to process successful response/, '断开的原因留着，方便查')
  assert.match(msg.text, /已自动续接会话（第 1 次）/)
  assert.doesNotMatch(msg.text, /正在自动续接/)
})

test('模型接口拒绝聊天记录：说明换模型后旧会话接不上', () => {
  const detail =
    'litellm.BadRequestError: OpenAIException - {"error":{"type":"invalid_request_error","code":"400002","message":"The request parameter input.content is invalid or missing.","param":"input.content"}}'
  const hints = failureHints(detail, { id: 'codex', name: 'Codex' })
  assert.equal(hints.length, 1)
  assert.match(hints[0], /input\.content/)
  assert.match(hints[0], /新建一个对话/)
})

test('压缩上下文：写明压缩了多少、现在占上下文窗口多少', () => {
  const tool = { kind: 'compact' as const, label: '', detail: '' }
  describeCompaction(tool, 96_000, 14_000, 200_000)
  assert.equal(tool.label, '压缩了 82.0k token（96.0k → 14.0k）')
  assert.equal(tool.detail, '当前占用 7%')
  describeCompaction(tool, 9000)
  assert.equal(tool.label, '压缩前 9.0k token')
  assert.equal(tool.detail, '')
})

test('空回合：只说了一句「我先…」就收尾、或者一个字都没回的，都算没做完', () => {
  const empty = (text: string, tools = 0, changed = 0) => looksUnfinished({ texts: [text], tools, changed })
  // 真实发生过的两次：说完就结束，一个工具都没调
  assert.equal(empty('我先将本地仓库更新到最新，同时查看当前状态和仓库结构。'), true)
  assert.equal(empty('我先把工作区更新到最新，顺便确认分支和本地改动的基线。'), true)
  assert.equal(empty('我先看一下你发的截图。'), true)
  // 调过工具、改过文件的就是真在做事
  assert.equal(empty('我先看一下你发的截图。', 2), false)
  assert.equal(empty('我先看一下你发的截图。', 0, 1), false)
  // 本来就该这么答的：结论、结果、命令，都不能当成没做完
  assert.equal(empty('更新到最新了，接下来按你说的修。'), false)
  assert.equal(empty('已完成：更新到 eb195c1，并跑通 typecheck 和 lint。'), false)
  assert.equal(empty('这个项目的测试命令是 npm run test:unit。'), false)
  // 长篇回复已经有内容，不推
  assert.equal(empty(`我先${'看'.repeat(240)}`), false)
  // 一个字都没收到也是没做完：CLI 报了一轮成功、面板却什么都没拿到时，那一轮不能算完成。
  // 否则它会保活等下一句，用户之后发来的消息全落进死回合（既没回复也没报错）
  assert.equal(looksUnfinished({ texts: [], tools: 0, changed: 0 }), true)
  assert.equal(looksUnfinished({ texts: ['', '  '], tools: 0, changed: 0 }), true)
  // 工具调过或文件改过就不算：那是真在做事，只是没说话
  assert.equal(looksUnfinished({ texts: [], tools: 1, changed: 0 }), false)
  assert.equal(looksUnfinished({ texts: [], tools: 0, changed: 1 }), false)
})

test('说已转给子对话却没调用发送工具：算没发出去', () => {
  const claim = '已转给正在加 OpenDesign 的子对话：厂家地址补上 Anthropic 协议的地址，并补对应单测。'
  assert.equal(claimsUnsentHandoff({ texts: [claim], tools: [] }), true)
  // 调用过发送（各家 CLI 的名字写法不同）就是真的发了
  assert.equal(
    claimsUnsentHandoff({ texts: [claim], tools: [{ name: 'mcp__panel__send_to_conversation', label: '' }] }),
    false,
  )
  assert.equal(
    claimsUnsentHandoff({ texts: [claim], tools: [{ name: 'MCP', label: 'panel-1a2b · create_conversation' }] }),
    false,
  )
  // 别的工具不算
  assert.equal(claimsUnsentHandoff({ texts: [claim], tools: [{ name: 'Read', label: 'a.ts' }] }), true)
  // 没说子对话、没说已转交的都不管
  assert.equal(claimsUnsentHandoff({ texts: ['已改好，单测通过。'], tools: [] }), false)
  assert.equal(claimsUnsentHandoff({ texts: ['要不要转给子对话处理？'], tools: [] }), false)
  assert.equal(claimsUnsentHandoff({ texts: [], tools: [] }), false)
})
