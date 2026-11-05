/**
 * 诊断报告里一段文字怎么拆行（bug-prose.ts）：①②、1) 2)、← 链、标签、分号串拆成一行一条，别的原样。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { prose, shortFile } from './bug-prose.ts'

test('写在一行里的几条拆成一行一条，已经换行的和短句原样', () => {
  assert.equal(
    prose('① A 不可见 → H6；② Scale=0 → H5；③ 都正常 → 渲染层'),
    '1. A 不可见 → H6\n2. Scale=0 → H5\n3. 都正常 → 渲染层',
  )
  assert.equal(
    prose('1) 靠近停留 15 秒：持续显示；2) 走远：隐藏；3) 再次靠近：重新显示'),
    '1. 靠近停留 15 秒：持续显示\n2. 走远：隐藏\n3. 再次靠近：重新显示',
  )
  assert.equal(prose('现象 ← 日志 :90814 ← 代码 a.lua:102'), '- 现象\n- ← 日志 :90814\n- ← 代码 a.lua:102')
  assert.equal(
    prose('期望：面板持续显示。实际：3 秒后隐藏。环境：PIE'),
    '- **期望**：面板持续显示\n- **实际**：3 秒后隐藏\n- **环境**：PIE',
  )
  assert.equal(prose('只有一句话：max 用的是秒'), '只有一句话：max 用的是秒')
  assert.equal(prose('第一行\n② 第二行 ③ 第三行'), '第一行\n② 第二行 ③ 第三行')
  assert.equal(shortFile('Project/Content/Script/a_b.lua'), 'a_b.lua')
})
