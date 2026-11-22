import assert from 'node:assert/strict'
import test from 'node:test'
import { changesText, parseStageReport, reportOutput, settleReport, type StageReportVersion } from './stage-report.ts'

const base = {
  summary: '结论',
  decisions: [
    {
      id: 'Q1',
      title: '路线',
      options: [
        { id: 'A', label: '甲' },
        { id: 'B', label: '乙' },
      ],
      pick: 'A',
    },
    {
      id: 'M1',
      title: '写法',
      options: [
        { id: 'A', label: '旧' },
        { id: 'B', label: '新' },
      ],
      pick: 'A',
      self: true,
    },
  ],
}

test('阶段报告：pick 不在选项里、编号重复都报回给 Agent', () => {
  assert.ok(parseStageReport(base).ok)
  const bad = parseStageReport({ ...base, decisions: [{ ...base.decisions[0], pick: 'C' }] })
  assert.ok(!bad.ok && /不在它的选项里/.test(bad.error))
  const dup = parseStageReport({ ...base, decisions: [base.decisions[0], base.decisions[0]] })
  assert.ok(!dup.ok && /重复/.test(dup.error))
})

test('阶段报告：没改就往下走并交最终决策；改了写清差异、标成 changed；有 next 时确认后接着做', () => {
  const r = parseStageReport(base)
  assert.ok(r.ok)
  const list = (): StageReportVersion[] => [{ report: r.report, at: '' }]
  const same = list()
  const ok = settleReport(same, { allow: true, picks: { Q1: 'A' } })
  assert.equal(ok.follow, '')
  assert.equal(same[0].result, 'confirmed')
  assert.match(ok.output ?? '', /## 用户确认的决策\n- Q1 路线：甲/)
  assert.match(ok.output ?? '', /## 按规则定的决策（用户已看过）\n- M1 写法：旧/)

  const ch = list()
  const back = settleReport(ch, { allow: true, picks: { M1: 'B' } })
  assert.equal(ch[0].result, 'changed')
  assert.match(back.follow, /M1「写法」：你推荐「旧」，用户改选「新」/)
  assert.equal(changesText(r.report, { Q1: 'X' }), '', '不在选项里的选择不算改动')

  const nx: StageReportVersion[] = [{ report: { ...r.report, next: '问 D3' }, at: '' }]
  assert.match(settleReport(nx, { allow: true }).follow, /问 D3/)
  assert.equal(nx[0].result, 'next')
  // 已经处理过的那一版不会被再处理一次
  assert.equal(settleReport(nx, { allow: true }).follow, '')
  assert.match(reportOutput(r.report, { Q1: 'B' }), /乙（用户改选，原推荐「甲」）/)
})

// 实跑 2026-11-22（DeepSeek V4.1 Flash）：每版 next 都写一句「没有待办」，决策还是那几个，方案节点确认 5 次不往下走
test('阶段报告：next 只在这一版问了新问题时才回到 Agent；同样的决策再写 next 就直接往下走', () => {
  const r = parseStageReport(base)
  assert.ok(r.ok)
  const v1: StageReportVersion = { report: { ...r.report, next: '确认后按顺序实现' }, at: '' }
  const list: StageReportVersion[] = [v1]
  assert.match(settleReport(list, { allow: true }).follow, /只接着问这些/)
  assert.equal(v1.result, 'next')
  // 第二版：决策还是 Q1、M1，next 写了一句交接的话
  const v2: StageReportVersion = { report: { ...r.report, next: '没有待办，交给父对话提交' }, at: '' }
  list.push(v2)
  const end = settleReport(list, { allow: true })
  assert.equal(end.follow, '')
  assert.equal(v2.result, 'confirmed')
  // 逐轮追问：这一版问了新的 Q2，照常接着下一轮
  const q2 = { ...r.report.decisions[0], id: 'Q2', title: '存储' }
  const v3 = { report: { ...r.report, decisions: [...r.report.decisions, q2], next: '问 Q3' }, at: '' }
  list.push(v3)
  assert.match(settleReport(list, { allow: true }).follow, /问 Q3/)
})
