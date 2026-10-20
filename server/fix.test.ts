import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationAround, fixPrompt, FixInput, type ConversationLine } from '../shared/fix.ts'

const parse = (o: Record<string, unknown>) => FixInput.parse({ title: '出错了', ...o })

test('交给 AI 排查的提示词带上项目路径和报错前后的对话', () => {
  const prompt = fixPrompt(
    parse({
      error: 'Maximum call stack size exceeded',
      conversation: '用户：看一下这个报错\n\nAI：我看一下\n\n报错：Maximum call stack size exceeded',
      cwd: 'F:\\Project\\demo',
    }),
    { os: 'win32 x64', cwd: 'F:\\Project\\demo' },
  )
  assert.ok(prompt.includes('F:\\Project\\demo'), '项目路径写进环境一行')
  assert.ok(prompt.includes('报错前后的对话：'), '对话节选单独一块')
  assert.ok(prompt.includes('AI：我看一下'), '对话内容带上')
  // 要求和环境分开写：对话在前，要求在后
  assert.ok(prompt.indexOf('报错前后的对话：') < prompt.indexOf('要求：'))
  assert.ok(prompt.includes('上面是出错前后的对话节选'))
})

test('没有对话节选时不写这一块，也不加对应的说明', () => {
  const prompt = fixPrompt(parse({ error: '找不到文件' }), { os: 'linux', cwd: '/tmp/x' })
  assert.ok(!prompt.includes('报错前后的对话'))
  assert.ok(!prompt.includes('上面是出错前后的对话节选'))
  assert.ok(prompt.includes('相关目录（项目路径）：/tmp/x'))
  // 没有目录时不写空：说清楚没提供
  assert.ok(fixPrompt(parse({}), { os: 'linux', cwd: '' }).includes('相关目录（项目路径）：未提供'))
})

test('对话节选只报告错附近的几条，长内容逐条截断，工具调用只留名字', () => {
  const msgs: ConversationLine[] = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 ? 'agent' : 'user') as 'user' | 'agent',
    text: `第 ${i} 条的${'很长'.repeat(2000)}`,
    tools: i === 20 ? [{ kind: 'run', name: '运行', label: 'npm test', failed: true }] : [],
  }))
  msgs[21] = { role: 'system', text: '出错了', error: true, tools: [] }
  const text = conversationAround(msgs, 21)
  assert.ok(text.includes('第 13 条'), '往前带 8 条')
  assert.ok(!text.includes('第 12 条'), '再往前的不带')
  assert.ok(text.includes('第 23 条'), '往后带 2 条')
  assert.ok(!text.includes('第 24 条'), '再往后的不带')
  assert.ok(text.includes('报错：出错了'))
  assert.ok(text.includes('（工具：运行 npm test 失败）'))
  assert.ok(text.includes('…'), '长内容截断')
  assert.ok(text.length <= 12_000)
})

test('对话里的面板提示（不是报错、不是用户回答）不进节选', () => {
  const msgs = [
    { role: 'user' as const, text: '继续' },
    { role: 'system' as const, text: '任务已暂停' },
    { role: 'system' as const, text: 'MaxListeners 报错', error: true },
    { role: 'system' as const, text: '风格：暗黑', answers: [{ question: '风格？', answer: '暗黑' }] },
  ]
  const text = conversationAround(msgs, 2)
  assert.ok(!text.includes('任务已暂停'))
  assert.ok(text.includes('报错：MaxListeners 报错'))
  assert.ok(text.includes('风格？：暗黑'), '用户回答照样带上')
})
