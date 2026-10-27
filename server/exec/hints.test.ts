/**
 * CLI 报错的说明：常见的报错换成能照着做的话。运行：npm run test:unit
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang, t } from '../../shared/i18n.ts'
import { getCli } from '../../shared/clis.ts'
import { fmtDuration } from '../../shared/duration.ts'
import type { Task, TaskMessage, ToolUse } from '../../shared/schema.ts'
import { classifyError, makeAlert } from '../../shared/alerts.ts'
import {
  claimsUnsentHandoff,
  clippedTranscript,
  contextFallbackKind,
  describeCompaction,
  envStallBudget,
  envStallFailure,
  envStallNote,
  envStallTimeout,
  estTokens,
  failureHints,
  looksUnfinished,
  settleContextNotes,
  settleEnvStallNotes,
  settleNetNotes,
  settleRetryNotes,
  shouldRetryEnvStall,
} from './runner.ts'
import { REQUEST_TIMEOUT_MS } from './rpc/session.ts'

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

/** 用户实际撞上的那条报错（模型窗口 1M，实际请求 1.09M） */
const CONTEXT_DETAIL =
  '400: {"message":"litellm.ContextWindowExceededError: litellm.BadRequestError: litellm._pre_call_checks: Context Window exceeded for given call. No models have context window large enough for this call.\nModel=deepseek-flash, Max Input Tokens=1000000, Got=1148341\nmodel=deepseek/deepseek-v4-flash. context_window_fallbacks=None. fallbacks=None.","type":"invalid_request_error","code":"400"}'

test('这次的真实报错归到「上下文超长」，才会走裁剪降级', () => {
  assert.equal(classifyError(CONTEXT_DETAIL), 'context')
})

test('上下文超长降级：只在真的撞上限那一轮自救一次，别的情况一个字都不变', () => {
  const base = {
    detail: CONTEXT_DETAIL,
    retried: false,
    prewarm: false,
    aborted: false,
    compact: false,
    chatResume: true,
  }
  assert.equal(contextFallbackKind(base), 'restart', '普通一轮撞上限：丢掉旧会话换新会话接着做')
  assert.equal(
    contextFallbackKind({ ...base, compact: true }),
    'compact',
    '压缩请求撞上限：改用裁剪的记录当摘要，按成功处理',
  )
  assert.equal(contextFallbackKind({ ...base, retried: true }), null, '已经降过一次，再撞就如实报错，不能无限重开')
  assert.equal(contextFallbackKind({ ...base, prewarm: true }), null, '预热请求不碰对话记录')
  assert.equal(contextFallbackKind({ ...base, aborted: true }), null, '用户已经停了，不能偷偷再开一轮')
  assert.equal(contextFallbackKind({ ...base, chatResume: false }), null, '没有历史可裁剪的轮次行为不变')
  assert.equal(
    contextFallbackKind({ ...base, detail: '400: {"message":"invalid model name"}' }),
    null,
    '别的 400 有各自的处理，不能被当成超长降级',
  )
  assert.equal(
    contextFallbackKind({ ...base, compact: true, chatResume: false }),
    'compact',
    '压缩不看有没有历史：它本来就在压缩历史',
  )
})

const chatMsg = (id: string, role: 'user' | 'agent', text: string): TaskMessage => ({
  id,
  role,
  agentId: '',
  step: '',
  text,
  tools: [],
  at: '',
})
const asTask = (messages: TaskMessage[]) => ({ messages }) as unknown as Task

test('上下文超长：按预算裁剪对话，保留最近的消息、更早的长正文省略', () => {
  const task = asTask([
    chatMsg('m1', 'user', '很早的要求' + '甲'.repeat(4000)),
    chatMsg('m2', 'agent', '中间结论'),
    chatMsg('m3', 'user', '最近的追问'),
  ])
  const out = clippedTranscript(task, 3, 100)
  assert.match(out, /中间结论/)
  assert.match(out, /最近的追问/)
  // 最早那条的正文撑爆上下文，不能再带过去；位置还在（新会话知道当时有这一轮）
  assert.doesNotMatch(out, /甲{50}/, '最早那段撑爆上下文的内容不能再带过去')
  assert.match(out, /正文太长，这里省略/)
  assert.ok(estTokens(out) < 200, `裁剪后的文字自己要在预算内，实际 ${estTokens(out)} token`)
  // 预算够时一条都不丢
  assert.match(clippedTranscript(task, 3, 100_000), /很早的要求/)
})

test('上下文超长：工具调用不能被省掉，正文放不下就让它让位', () => {
  const tools: ToolUse[] = [
    { kind: 'edit', label: 'server/exec/runner.ts', detail: '' },
    { kind: 'run', label: 'npm run typecheck', detail: '' },
    { kind: 'agent', label: 'spawn_agents 调研', detail: '' },
  ]
  const task = asTask([{ ...chatMsg('m1', 'agent', '总结：' + '乙'.repeat(3000)), tools }])
  const line = '（工具：修改 server/exec/runner.ts；运行 npm run typecheck；子对话 spawn_agents 调研）'
  // 预算紧：正文让位，工具限一行不能少（新会话要知道已经改过什么、跑过什么）
  const tight = clippedTranscript(task, 1, 210)
  assert.ok(tight.includes(line), `工具行必须保留，实际：${tight}`)
  assert.match(tight, /正文太长，这里省略/)
  // 余量够：工具和截断后的正文都在
  const roomy = clippedTranscript(task, 1, 1200)
  assert.ok(roomy.includes(line))
  assert.match(roomy, /中间省略/)
  // 连工具行都放不下：整条省略并写清省略了几条，不会只留正文丢工具
  const tiny = clippedTranscript(task, 1, 10)
  assert.match(tiny, /更早的 1 条消息因为太长省略了/)
  assert.doesNotMatch(tiny, /乙{10}/)
})

test('上下文超长：工具记录按时间分层，久远的压成计数、最近的保留细节', () => {
  const old: ToolUse[] = [
    { kind: 'edit', label: 'web/src/a.tsx', detail: '' },
    { kind: 'edit', label: 'web/src/b.tsx', detail: '' },
    { kind: 'run', label: 'npm run lint', detail: '' },
    { kind: 'agent', label: 'spawn_agents 调研', detail: '' },
  ]
  const task = asTask([
    { ...chatMsg('m1', 'agent', '很早的总结'), tools: old },
    chatMsg('n0', 'user', '接着做'),
    chatMsg('n1', 'agent', '最近的回复 1'),
    chatMsg('n2', 'user', '最近的追问'),
    chatMsg('n3', 'agent', '最近的回复 2'),
    { ...chatMsg('last', 'agent', '最近这一轮'), tools: [{ kind: 'run', label: 'npm run typecheck', detail: '' }] },
  ])
  const out = clippedTranscript(task, task.messages.length, 100_000)
  // 很久以前那条：只留类别计数，不再列文件名和命令
  assert.match(out, /（早先的工具：修改×2；运行×1；子对话×1）/)
  assert.doesNotMatch(out, /web\/src\/a\.tsx/)
  // 最近这一轮：命令原文完整保留，不靠计数
  assert.match(out, /（工具：运行 npm run typecheck）/)
})

test('上下文超长：单条就超预算时截断着保留，不整段丢掉', () => {
  const task = asTask([chatMsg('m1', 'agent', '结论：' + '丙'.repeat(4000))])
  const out = clippedTranscript(task, 1, 600)
  assert.match(out, /结论：/)
  assert.match(out, /中间省略/)
  assert.ok(estTokens(out) < 700, `截断后 ${estTokens(out)} token`)
})

test('上下文超长降级接上了：失败卡片收回成普通说明', () => {
  const base = 'Pi 执行失败（退出码 3221226505）：\n400: ContextWindowExceededError got=1148341'
  const msg: TaskMessage = {
    id: 'c1',
    role: 'system',
    agentId: '',
    step: '',
    text: [base, '', '正在丢掉旧会话，把对话裁剪后开新会话接着做…'].join('\n'),
    tools: [],
    at: '',
    error: true,
    alert: makeAlert('warn', base, 'context'),
  }
  settleContextNotes([{ msg, base }])
  assert.equal(msg.error, undefined, '这一轮最终继续做下去了，不能一直挂着红色错误')
  assert.equal(msg.transient, true, '继续执行时要能去掉')
  assert.match(msg.text, /ContextWindowExceededError/, '超长的原因留着，方便查')
  assert.match(msg.text, /已丢掉旧会话，把对话裁剪后开新会话接着做了。/)
  assert.doesNotMatch(msg.text, /正在丢掉旧会话/)
  assert.equal(msg.alert?.level, 'warn')
  assert.match(msg.alert?.resolved ?? '', /已裁剪对话/)
})

test('重试成功后，前面那张「正在重试」收成已恢复', () => {
  const retryCard = (label: string): ToolUse => ({
    kind: 'other',
    name: '提示',
    label,
    detail: '',
    alert: makeAlert('warn', '502 Bad Gateway', 'retry'),
  })
  const other: ToolUse = {
    kind: 'other',
    name: '提示',
    label: '别的警告',
    detail: '',
    alert: makeAlert('warn', 'ECONNRESET', 'network'),
  }
  const msgs: TaskMessage[] = [
    // 上一轮留下的卡：这一轮成功不能把它写成「这一轮第 N 次成功了」
    { id: 'old', role: 'agent', agentId: '', step: '', text: '', tools: [retryCard('上一轮的卡')], at: '' },
    { id: 'u', role: 'user', agentId: '', step: '', text: '接着改', tools: [], at: '' },
    { id: 'b', role: 'agent', agentId: '', step: '', text: '', tools: [retryCard('第 1 次重试')], at: '' },
    // 执行中用户插话：它落在同一轮里，不能把它当成新的一轮边界
    { id: 'steer', role: 'user', agentId: '', step: '', text: '顺便看一下日志', tools: [], at: '' },
    { id: 'c', role: 'agent', agentId: '', step: '', text: '', tools: [retryCard('第 2 次重试')], at: '' },
    { id: 'd', role: 'agent', agentId: '', step: '', text: '', tools: [other], at: '' },
  ]
  // 本轮从 index 2 开始（进入 runAgent 时的长度）
  assert.equal(settleRetryNotes(msgs, '第 2 次重试成功了，接着做。', 2), true)
  assert.equal(msgs[4].tools[0].alert?.resolved, '第 2 次重试成功了，接着做。')
  assert.equal(
    msgs[2].tools[0].alert?.resolved,
    '第 2 次重试成功了，接着做。',
    '一轮重试了两次，中间隔着用户插话也要收',
  )
  assert.equal(msgs[4].tools[0].alert?.level, 'warn', '恢复了也是 warn：这一轮没失败，只是不需要再处理')
  assert.equal(msgs[5].tools[0].alert?.resolved, undefined, '别的警告不能被顺手收掉')
  assert.equal(msgs[0].tools[0].alert?.resolved, undefined, '上一轮留下的卡不收：写这一轮的第 N 次会张冠李戴')
  // 已经恢复过、或者根本没有这张卡：返回 false，不再多插一行「已恢复」
  assert.equal(settleRetryNotes(msgs, '再来一次', 2), false)
})

test('上游网关断开的失败卡也给连接中断的说明', () => {
  const hints = failureHints('502 Bad Gateway', { id: 'pi', name: 'Pi' })
  assert.equal(hints.length, 1)
  assert.match(hints[0], /连接中途断开/)
})

test('环境性失败（进程活着、没有任何输出的超时）自动重试一次', () => {
  // 第一次超时：放宽等待再跑一次
  assert.equal(shouldRetryEnvStall({ stall: true, retries: 0, aborted: false, prewarm: false, budget: 10_000 }), true)
})

test('环境性失败只重试一次：重试也超时就不再重试，失败卡片写明已重试过', () => {
  assert.equal(
    shouldRetryEnvStall({ stall: true, retries: 1, aborted: false, prewarm: false, budget: 10_000 }),
    false,
    '重试过就不再重试，不能循环',
  )
  assert.equal(shouldRetryEnvStall({ stall: true, retries: 5, aborted: false, prewarm: false, budget: 10_000 }), false)
  // 两次都没等到响应：失败卡上要写明面板已经重试过，用户看得出不是第一次就失败
  assert.equal(envStallFailure(1), t('已自动重试 {n} 次，仍然没有响应。', { n: 1 }))
})

test('内容性失败不重试：模型明确报错、用户停止、预热轮都没有环境性标记', () => {
  const ok = { retries: 0, aborted: false, prewarm: false, budget: 10_000 }
  // 模型报错、工具失败这类是任务内容的问题，多等一会儿也一样，重试只会白跑一轮
  assert.equal(shouldRetryEnvStall({ stall: false, ...ok }), false)
  assert.equal(shouldRetryEnvStall({ stall: true, ...ok, aborted: true }), false)
  assert.equal(shouldRetryEnvStall({ stall: true, ...ok, prewarm: true }), false)
})

test('没有加载预算的 CLI 不重试：放宽不了等待，原样重跑既没用、文案也会说谎', () => {
  assert.equal(envStallBudget('commandcode'), 0, 'Command Code 没有启动期要加载的桥接扩展')
  assert.equal(shouldRetryEnvStall({ stall: true, retries: 0, aborted: false, prewarm: false, budget: 0 }), false)
  assert.equal(envStallTimeout('commandcode'), REQUEST_TIMEOUT_MS, '没有预算时就用默认超时')
})

test('重试轮的超时按扩展加载预算推导，说明里写清没有响应、已重试 1 次', () => {
  const def = getCli('pi')!
  const loadBudget = Number(def.mcp!.vars.loadBudget)
  const timeout = envStallTimeout('pi')
  assert.equal(envStallBudget('pi'), loadBudget)
  // 默认 15 秒 = 加载预算 10 秒 + 5 秒余量；重试轮再留一整份加载预算，不是随手写个 60 秒
  assert.equal(timeout, REQUEST_TIMEOUT_MS + loadBudget)
  assert.ok(timeout > REQUEST_TIMEOUT_MS, `重试轮要真的放宽：${timeout}ms`)
  assert.ok(timeout < 60_000, `不要把用户晾到一分钟：${timeout}ms`)
  const note = envStallNote(timeout)
  assert.equal(note, t('这一轮没有响应，已自动重试 {n} 次（等待放宽到 {wait}）…', { n: 1, wait: fmtDuration(timeout) }))
})

test('环境性失败重试成功：那张「没有响应」的卡收成普通说明', () => {
  const base = 'Pi 执行失败：\nget_state 没有响应（已等 15s）\n进程还在运行\nstderr 没有输出'
  const msg: TaskMessage = {
    id: 's1',
    role: 'system',
    agentId: '',
    step: '',
    text: [base, '', envStallNote(25_000)].join('\n'),
    tools: [],
    at: '',
    error: true,
    alert: makeAlert('warn', base, 'no_response'),
  }
  settleEnvStallNotes([{ msg, base }])
  assert.equal(msg.error, undefined, '这一轮最终做成了，不能一直挂着红色失败卡片')
  assert.equal(msg.transient, true, '继续执行时要能去掉')
  assert.match(msg.text, /get_state 没有响应/, '没响应的原因留着，方便查')
  assert.ok(msg.text.includes(t('已自动重试 {n} 次，这一轮继续做完了。', { n: 1 })))
  assert.equal(msg.alert?.level, 'warn')
  assert.equal(msg.alert?.resolved, t('已自动重试，继续做完了'))
})

/**
 * 源码里每个 `runAgent(...)` 调用的实参文本：按括号配对取。
 * 用正则跨行匹配会连到下一个函数的右括号上，把无关代码也算进去；函数定义本身用 lookbehind 排除
 */
function runAgentCalls(src: string) {
  const out: string[] = []
  for (const m of src.matchAll(/(?<!function )runAgent\(/g)) {
    let depth = 0
    let i = m.index! + m[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    out.push(src.slice(m.index!, i + 1))
  }
  return out
}

test('环境性重试的计数和留痕要在每个 runAgent 调用点上都带上（漏传会清零、红卡收不掉）', () => {
  const src = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8')
  // 除首次进入这一轮的 `runAgent(ctx, call)` 外，其余每个调用都是重跑或又一次完整调用：
  // 缺 envStalls 会让「只重试一次」失效，缺 envStallNotes 会让重试成功后那张红卡收不掉（评审 R2 就是这么漏的）。
  // 压缩轮那种 `await runAgent(...)` 也算在内——它同样会走到环境性失败的重试分支
  const calls = runAgentCalls(src).filter((call) => !/^runAgent\(ctx, call\)$/.test(call.replace(/\s+/g, ' ')))
  assert.ok(calls.length >= 6, `至少有几处重跑：${calls.length}`)
  for (const call of calls) {
    assert.match(call, /envStalls/, `这处调用没传 envStalls：${call.replace(/\s+/g, ' ').slice(0, 120)}`)
    assert.match(call, /envStallNotes/, `这处调用没传 envStallNotes：${call.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
})
