import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGate, buildKids, buildSig, settleBuildJob, type BuildAsk } from './build-ask.ts'

/** UE 子对话申请的编译由面板记账（用户 2026-11-04 报：父对话编完不告诉子对话，子对话一直待收尾） */

const ask = (over: Partial<BuildAsk> = {}): BuildAsk => ({
  state: 'asked',
  at: '',
  note: '',
  sig: 'a',
  jobs: [],
  info: '',
  ...over,
})

test('替谁编：父对话写了 children 按它（只认自己名下的）；一个都没写时补上申请过、还没开编的', () => {
  const kids = [
    { id: 'k1', parentTaskId: 'p', buildAsk: ask() },
    { id: 'k2', parentTaskId: 'p', buildAsk: ask({ state: 'building' }) },
    { id: 'k3', parentTaskId: 'p' },
    { id: 'k4', parentTaskId: 'other', buildAsk: ask() },
    { id: 'k5', parentTaskId: 'p', buildAsk: ask(), resolved: true },
  ]
  assert.deepEqual(buildKids(kids, 'p', ['k3', 'k4', ' k3 ']), [['k3'], []], '写了就按写的，别人名下的不认')
  assert.deepEqual(buildKids(kids, 'p', []), [['k1'], ['k1']], '漏写时按申请补上：已在编的、已完成的、没申请的都不补')
})

test('一次编译分几条命令：全部通过才算通过，有一条失败就整次失败；不是这次的命令不动', () => {
  const a = ask({ state: 'building', jobs: ['j1', 'j2'] })
  const one = settleBuildJob(a, 'j1', true, 'ok', 't1')
  assert.equal(one.result, undefined, '还有没跑完的，先不推')
  assert.deepEqual(one.ask.jobs, ['j2'])
  const two = settleBuildJob(one.ask, 'j2', true, '编译成功', 't2')
  assert.equal(two.result, 'passed')
  assert.equal(two.ask.state, 'passed')
  const bad = settleBuildJob(a, 'j2', false, '链接失败', 't3')
  assert.equal(bad.result, 'failed')
  assert.equal(bad.ask.info, '链接失败')
  assert.equal(settleBuildJob(a, 'j9', true, '', 't').result, undefined)
})

test('请父对话验收前的核对：改了要编译的文件就要有这次改动的编译通过；通过后又改了要重编', () => {
  const sig = buildSig([
    { path: 'Source/A.cpp', add: 3, del: 1 },
    { path: 'Source/B.h', add: 1, del: 0 },
  ])
  assert.equal(
    sig,
    buildSig([
      { path: 'Source/B.h', add: 1, del: 0 },
      { path: 'Source/A.cpp', add: 3, del: 1 },
    ]),
    '顺序无关',
  )
  assert.equal(buildGate(undefined, ''), '', '没改要编译的文件不核对')
  assert.match(buildGate(undefined, sig), /还没申请过编译/)
  assert.match(buildGate(ask({ sig }), sig), /编译还没出结果/)
  assert.match(buildGate(ask({ state: 'building', sig }), sig), /编译还没出结果/)
  assert.match(buildGate(ask({ state: 'failed', sig, info: 'C2065' }), sig), /上次编译没通过（C2065）/)
  assert.equal(buildGate(ask({ state: 'passed', sig }), sig), '')
  assert.match(buildGate(ask({ state: 'passed', sig }), `${sig}|Source/C.cpp:+1-0`), /编译通过之后又改了要编译的文件/)
})
