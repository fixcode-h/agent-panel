/**
 * 面板代答的结果（钩子拒绝里带结果）不算出错：去掉 CLI 加的前缀（用户 2026-11-27 截图里标红的「PreToolUse:Grep hook error」）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { getCli } from '../clis.ts'
import { servedResult, SERVED_HEAD } from './takeover-spec.ts'

const mark = getCli('claude')!.takeover!.denyMark

test('Claude Code 的拒绝前缀去掉、按正常输出给', () => {
  const out = `PreToolUse:Grep hook error: ${SERVED_HEAD}\na.json:3: "Foo": 1`
  assert.equal(servedResult(out, mark), `${SERVED_HEAD}\na.json:3: "Foo": 1`)
})

test('守卫真拦下的照样算出错；没有前缀的 CLI 只认开头', () => {
  assert.equal(servedResult('PreToolUse:Bash hook error: 【面板】不要这样做', mark), undefined)
  assert.equal(servedResult(`${SERVED_HEAD}：x`, ''), `${SERVED_HEAD}：x`)
  assert.equal(servedResult('出错了', ''), undefined)
})
