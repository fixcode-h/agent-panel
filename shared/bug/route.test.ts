import assert from 'node:assert/strict'
import test from 'node:test'
import { bugRoutePart } from './route.ts'
import type { Task } from '../schema.ts'

/** 父对话：用户报的 Bug 用哪种方式修，跟着「提问」开关走（用户 2026-11-07 定的，ADR 0057） */
const host = (askUser: boolean, projectId = 'p') => ({ task: { askUser, projectId } as Task })

test('「提问」开着：只描述了 Bug 时先问用户选完整流程还是直接修，选项写清后果', () => {
  const s = bugRoutePart(host(true), true)
  assert.match(s, /^## 用户报的 Bug 用哪种方式修/)
  assert.match(s, /先用提问工具.*问用户用哪种方式/)
  assert.match(s, /完整 Bug 流程.*直接修/)
  assert.match(s, /选完整流程就 create_conversation 写 kind: "bug"/)
  assert.ok(!s.includes('默认直接修'))
})

test('「提问」关着：默认直接修（kind: "fix"），不问用户，也不自己改判成完整流程', () => {
  const s = bugRoutePart(host(false), true)
  assert.match(s, /默认直接修：create_conversation 写 kind: "fix"，不问用户/)
  assert.ok(!s.includes('先用提问工具'))
  // 开关改了段落内容跟着变：续接时会重发这一段
  assert.notEqual(s, bugRoutePart(host(true), true))
})

test('/bug、/fix 不看开关；已有子对话升级用 send_to_conversation 写 kind: "bug"，不另开；只给项目父对话', () => {
  for (const on of [true, false]) {
    const s = bugRoutePart(host(on), true)
    assert.match(s, /用户发了 \/bug：走完整 Bug 流程/)
    // 直接修也留简版报告（分析稿 B2 第 ③ 条）：kind 写 "fix"
    assert.match(s, /用户发了 \/fix.*kind 写 "fix".*简版报告/)
    assert.match(s, /send_to_conversation 交给那个子对话，写 kind: "bug"/)
    assert.match(s, /不要为此另开一个子对话/)
  }
  // 不是父对话、不在项目里不带这一段
  assert.equal(bugRoutePart(host(true), false), '')
  assert.equal(bugRoutePart(host(true, ''), true), '')
})
