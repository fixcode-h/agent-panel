import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, Task } from './schema.ts'
import { exportTask, taskHtml, TASK_HTML_MAX_CHARS, TASK_HTML_MSG_MAX, type TaskExport } from './task-export.ts'

const at = '2026-10-19T00:00:00.000Z'
const agent = Agent.parse({ id: 'a1', name: '开发', instructions: '写代码', createdAt: at, updatedAt: at })

const msg = (over: object) => ({
  id: `m${Math.random().toString(36).slice(2, 8)}`,
  role: 'agent',
  at,
  text: '',
  ...over,
})

/** 一份最小的导出包：只改用例关心的字段，其余由 Task.parse 补默认值 */
function bundle(
  over: { messages?: object[]; steps?: object[]; testRuns?: object[]; changes?: object[] } = {},
): TaskExport {
  const task = Task.parse({
    id: 't1',
    projectId: 'p1',
    title: '加一<个>按钮 & 修 "样式"',
    mode: 'chat',
    agentId: agent.id,
    status: 'done',
    createdAt: at,
    updatedAt: at,
    steps: over.steps ?? [
      {
        id: 's1',
        title: '处理',
        status: 'done',
        startedAt: at,
        endedAt: at,
        changes: [{ path: 'web/a.tsx', add: 3, del: 1 }],
      },
    ],
    messages: over.messages ?? [],
    testRuns: over.testRuns ?? [],
    changes: over.changes ?? [],
  })
  return exportTask(task, [agent], '0.3.1', new Date(at))
}

test('taskHtml：自包含、不执行脚本，所有外部文本都转义', () => {
  const html = taskHtml(
    bundle({
      messages: [
        msg({ role: 'user', text: '点这个 <img src=x onerror=alert(1)> 就坏，key 是 a&b "引号"' }),
        msg({ role: 'agent', step: 's1', text: '<script>alert(1)</script> 改好了' }),
      ],
    }),
  )
  assert.ok(html.startsWith('<!doctype html>'), '应当是一份完整的 HTML 文档')
  assert.ok(html.includes('<meta charset="utf-8">'), '必须有 charset，否则中文会乱码')
  // 用户内容里的标签、脚本、引号都要转义：打开时不会真的执行
  assert.ok(!html.includes('<script'), 'HTML 里不能有脚本')
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('a&amp;b &quot;引号&quot;'))
  // 标题也要转义
  assert.ok(html.includes('<h1>执行记录：加一&lt;个&gt;按钮 &amp; 修 &quot;样式&quot;</h1>'))
  // 样式内联在文件里，不引用外部资源（转义后的文字里可能有 src=，只查真的标签和远程引用）
  assert.ok(html.includes('<style>'))
  assert.ok(!/<img|<link|<script|@import|url\(http/i.test(html), '不能引用外部资源')
})

test('taskHtml：标题、统计、按节点的消息和工具调用折叠', () => {
  const html = taskHtml(
    bundle({
      messages: [
        msg({ role: 'user', text: '加个按钮' }),
        msg({
          role: 'agent',
          step: 's1',
          text: '改好了\n```ts\nconst a = 1\n```',
          tools: [
            { kind: 'run', name: '运行', label: 'npm test', failed: true, exitCode: 1, output: 'failed: 断言没过' },
          ],
        }),
      ],
    }),
  )
  for (const part of [
    '<h2>统计</h2>',
    '用户消息 1 条',
    '<h2>执行过程</h2>',
    '<h3>节点：处理（s1，done）</h3>',
    '<details><summary>工具调用 1 个（其中失败 1 个）</summary>',
    'failed: 断言没过',
  ])
    assert.ok(html.includes(part), `HTML 里缺少「${part}」`)
  // 围栏里的内容单独做成代码块，camelCase 的正文按原样保留
  assert.ok(html.includes('<pre class="code"><code>const a = 1</code></pre>'))
  assert.ok(html.includes('<pre class="body">改好了</pre>'))
})

test('taskHtml：改动的文件带 +n / -m，测试记录单独一节', () => {
  const html = taskHtml(
    bundle({
      testRuns: [{ stepId: 'unit', stepName: '单元测试', by: 'self', ok: true, durationMs: 65_000, tries: 1, at }],
    }),
  )
  assert.ok(html.includes('id="files"'))
  assert.ok(html.includes('web/a.tsx'))
  assert.ok(html.includes('class="num add">+3'))
  assert.ok(html.includes('class="num del">-1'))
  assert.ok(html.includes('id="tests"'))
  for (const part of ['单元测试', '通过', '1m 5s']) assert.ok(html.includes(part), `测试记录里缺少「${part}」`)
})

test('taskHtml：没有测试记录和改动文件时不出空小节', () => {
  const html = taskHtml(bundle({ steps: [{ id: 's1', title: '处理', status: 'done', startedAt: at, endedAt: at }] }))
  assert.ok(!html.includes('id="tests"'))
  assert.ok(!html.includes('id="files"'))
})

test('taskHtml：单条超长消息截断并写明省略，总量超上限时列出省略条数', () => {
  const one = 'x'.repeat(TASK_HTML_MSG_MAX + 5000)
  const short = taskHtml(bundle({ messages: [msg({ role: 'user', text: one })] }))
  assert.ok(short.includes('后面省略'), '单条消息超长时要注明截断')
  assert.ok(short.length < one.length, '截断后应当比原文短')

  // 每条消息都接近上限，凑到超过总量预算：后面的一律省略，文件本身不会无限大
  const many = Array.from({ length: 500 }, (_, i) =>
    msg({ role: 'agent', text: `${i}${'y'.repeat(TASK_HTML_MSG_MAX)}` }),
  )
  const big = taskHtml(bundle({ messages: many }))
  assert.ok(big.includes('条消息没有列出'), '超过体积上限时要写明省略了多少条')
  assert.ok(big.length < TASK_HTML_MAX_CHARS * 1.1, `文件应当有上限（实际 ${big.length}）`)
})
