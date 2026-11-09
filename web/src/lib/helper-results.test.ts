import assert from 'node:assert/strict'
import { test } from 'node:test'
import { helperResultCount } from './helper-results.ts'

test('helperResultCount：子任务输出里自己的「### 」小标题不算进个数', () => {
  const body = [
    '### 复现问题（交了结果：做完）',
    '### 步骤\n1. 打开购物车\n### 结论\n能复现',
    '',
    '### 查找相关代码（没有用 submit_result 交结果，做没做完不确定）',
    '### 相关文件\nstore.ts',
  ].join('\n')
  assert.equal(helperResultCount({}, body), 2)
  // 没做完的那个按末尾的重试提示认
  const failed =
    '### 跑测试\n（失败：超时）\n（要重试就调用 spawn_agents，resume 写「s1」：在原来这个子任务里接着做，不要另派一个新的）'
  assert.equal(helperResultCount({}, `${body}\n\n${failed}`), 3)
  // 新数据直接按记下的子任务数
  assert.equal(helperResultCount({ results: ['a', 'b'] }, body + '\n### 多余'), 2)
  // 认不出格式的老正文退回数标题，至少 1 个
  assert.equal(helperResultCount({}, '一些结果'), 1)
})
