import assert from 'node:assert/strict'
import test from 'node:test'
import { briefOf, describeTool, paramsOf } from './describe.ts'
import { PANEL_TOOL_GUIDE } from './panel-guides.ts'
import { PANEL_TOOL_NAMES } from '../panel-tools.ts'

test('交给 Agent 的说明：原文不动，后面补「什么时候用 / 不要用」，原文里写过的不重复', () => {
  const g = { useWhen: '要跑很久的命令', avoidWhen: '几秒就完的' }
  assert.equal(describeTool('跑命令。', g), '跑命令。\n什么时候用：要跑很久的命令\n不要用：几秒就完的')
  assert.equal(describeTool('跑命令。', undefined), '跑命令。')
  // 插件作者已经把时机写进原文：不再补一遍
  assert.equal(
    describeTool('跑命令，要跑很久的命令才用。', { useWhen: '要跑很久的命令' }),
    '跑命令，要跑很久的命令才用。',
  )
})

test('more_tools 的简介：有声明用「显示名：作用」，没有取第一句', () => {
  assert.equal(briefOf({ description: '第一句。第二句。' }), '第一句。')
  assert.equal(briefOf({ title: 'x' }, { title: '记下教训', summary: '写成规则。' }), '记下教训：写成规则。')
})

test('参数表从 inputSchema 生成：枚举列出取值，数组写成 T[]，标出必填', () => {
  const rows = paramsOf({
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['run', 'set'], description: '做什么' },
      ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['action'],
  })
  assert.deepEqual(rows, [
    { name: 'action', type: 'run | set', description: '做什么', required: true },
    { name: 'ids', type: 'string[]', description: '', required: false },
  ])
})

test('面板工具的声明：每个都写了作用和什么时候用', () => {
  for (const n of PANEL_TOOL_NAMES) {
    const g = PANEL_TOOL_GUIDE[n]
    assert.ok(g.title && g.summary && g.useWhen && g.effects.length, `${n} 的声明不全`)
  }
})
