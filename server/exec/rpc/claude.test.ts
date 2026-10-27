/**
 * Claude Code 的提问走原生 AskUserQuestion：CLI 发 control_request(can_use_tool)，面板转成提问卡片，
 * 用户的选择再写回 updatedInput.answers。这条链路断了，模型提问就只剩纯文本。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CliEvent } from '../parsers.ts'
import type { RpcContext } from './types.ts'
import { claudeAdapter, claudeAsk } from './claude.ts'

/** 只记下发出的记录和事件，够检查适配器的转换和回话 */
function fakeCtx() {
  const events: CliEvent[] = []
  const sent: any[] = []
  const ctx = {
    cwd: '/tmp',
    input: '',
    images: [],
    finished: false,
    send: (r: Record<string, unknown>) => sent.push(r),
    request: async () => undefined,
    emit: (e: CliEvent | CliEvent[]) => events.push(...(Array.isArray(e) ? e : [e])),
    finish: async () => false,
    hold: () => {},
  } as unknown as RpcContext
  return { ctx, events, sent }
}

function askRequest(id: string, questions: unknown[]) {
  return {
    type: 'control_request',
    request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } },
  }
}

test('Claude Code：AskUserQuestion 换成提问卡片', () => {
  const ask = claudeAsk('AskUserQuestion', {
    questions: [
      {
        header: '发布',
        question: '要发到线上吗？',
        options: [{ label: '发', description: '直接上线' }, { label: '先不发' }],
      },
    ],
  })
  assert.equal(ask.kind, 'question')
  assert.equal(ask.title, '要发到线上吗？')
  assert.equal(ask.detail, '发布')
  // 单选时 options 是可直接点的标签；完整的问题列表也带出去（一次可以问几个）
  assert.deepEqual(ask.options, ['发', '先不发'])
  assert.deepEqual(ask.questions, [
    {
      header: '发布',
      question: '要发到线上吗？',
      options: [
        { label: '发', description: '直接上线' },
        { label: '先不发', description: '' },
      ],
      multiSelect: false,
    },
  ])
})

test('Claude Code：control_request 里的提问转成卡片，回答写回 updatedInput.answers', () => {
  const { ctx, events, sent } = fakeCtx()
  const adapter = claudeAdapter({ cwd: '/tmp', input: '', parse: () => [] })
  adapter.request!(
    ctx,
    askRequest('req-1', [
      { header: '方案', question: '用哪种？', options: [{ label: 'A' }, { label: 'B' }] },
      { header: '时间', question: '什么时候发？', options: [{ label: '现在' }] },
    ]),
  )
  assert.equal(events.length, 1)
  const ask = events[0]
  assert.equal(ask.type, 'ask')
  if (ask.type !== 'ask') return
  assert.equal(ask.kind, 'question')
  assert.equal(ask.title, '用哪种？')
  assert.deepEqual(ask.options, ['A', 'B'])

  ask.reply({ allow: true, answers: ['A', '现在'] })
  const res = sent[0].response
  assert.equal(res.subtype, 'success')
  assert.equal(res.request_id, 'req-1')
  assert.equal(res.response.behavior, 'allow')
  // 答案按问题原文对上，Claude Code 靠它接着往下跑
  assert.deepEqual(res.response.updatedInput.answers, { '用哪种？': 'A', '什么时候发？': '现在' })
})

test('Claude Code：用户拒绝提问时回 deny，带上用户的话', () => {
  const { ctx, events, sent } = fakeCtx()
  const adapter = claudeAdapter({ cwd: '/tmp', input: '', parse: () => [] })
  adapter.request!(ctx, askRequest('req-2', [{ header: '', question: '要发吗？', options: [{ label: '发' }] }]))
  const ask = events[0]
  assert.equal(ask.type, 'ask')
  if (ask.type !== 'ask') return
  ask.reply({ allow: false, answer: '先别发' })
  assert.deepEqual(sent[0].response.response, { behavior: 'deny', message: '用户拒绝了：先别发' })
})
