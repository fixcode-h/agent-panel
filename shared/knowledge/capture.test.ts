/**
 * 二、三期的纯函数：触发键匹配、拦截、当场捕获、复发、没配上的查询、入库校验、升降级建议。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectLesson } from '../schema.ts'
import { ProjectKnowledgeState } from './candidate.ts'
import { addEpisode, addMiss, addSubtaskCandidate, candidateLesson, purposeOf } from './capture.ts'
import { admitLesson } from './admission.ts'
import { lessonSuggestions } from './lifecycle.ts'
import { blockingLesson, commandLessons, errorLessons, pushable } from './push.ts'
import { errorPrint } from './match/fingerprint.ts'

const ERR = 'src/a.ts(1,1): error TS2589: Type instantiation is excessively deep and possibly infinite.'
const L = (o: Record<string, unknown>) => ProjectLesson.parse({ id: 'x', title: '规则', createdAt: '', ...o })

test('触发键：命令触发键和存下的报错指纹都能匹配；hint、promoted 不推，pinned 排前', () => {
  const byCmd = L({ id: 'c', title: '跑 e2e 先去掉代理变量', triggers: { commands: ['npm run test:e2e'] } })
  const byErr = L({ id: 'e', title: '类型太深就拆类型', triggers: { errors: [errorPrint(ERR)] } })
  assert.deepEqual(
    commandLessons([byCmd], 'cd web && npm run test:e2e -- --failed').map((h) => h.id),
    ['c'],
  )
  assert.deepEqual(
    errorLessons([byErr], `x\n${ERR}\n`).map((h) => h.id),
    ['e'],
  )
  const hint = { ...byCmd, id: 'h', severity: 'hint' as const }
  const done = { ...byCmd, id: 'p', status: 'promoted' as const }
  const pin = { ...byCmd, id: 'pin', status: 'pinned' as const }
  assert.deepEqual(
    pushable([byCmd, hint, done, pin]).map((l) => l.id),
    ['pin', 'c'],
  )
})

test('拦截档：只有 block 的教训拦对得上的命令', () => {
  const warn = L({ id: 'w', title: '别直接跑 e2e', triggers: { commands: ['npm run test:e2e'] } })
  assert.equal(blockingLesson([warn], 'npm run test:e2e'), undefined)
  const block = { ...warn, severity: 'block' as const }
  assert.equal(blockingLesson([block], 'npm run test:e2e')?.id, 'w')
  assert.equal(blockingLesson([block], 'npm run lint'), undefined)
})

test('当场捕获：同一个坑合并，换了对话再出现算复发；候选转教训带触发键', () => {
  const ep = {
    failed: 'npx tsc',
    fixed: 'npx tsc -p tsconfig.app.json',
    purpose: purposeOf('npx tsc'),
    print: errorPrint(ERR),
  }
  assert.equal(ep.purpose, 'tsc', 'npx 这类启动器不算目的')
  let s = ProjectKnowledgeState.parse({})
  const a = addEpisode(s, ep, 'conv1', '2026-11-15T00:00:00Z')
  assert.equal(a.recurred, false)
  s = a.next
  const b = addEpisode(s, ep, 'conv1', '2026-11-15T00:01:00Z')
  assert.equal(b.recurred, false, '同一个对话里再踩不算复发')
  assert.equal(b.next.candidates.length, 1)
  const c = addEpisode(b.next, ep, 'conv2', '2026-11-15T00:02:00Z')
  assert.equal(c.recurred, true)
  const draft = candidateLesson(c.cand)
  assert.deepEqual(draft.triggers.commands, ['tsc'])
  assert.equal(draft.wrong, 'npx tsc')
  assert.match(draft.rule, /tsconfig\.app\.json/)
})

test('子任务候选按标题合并；没配上的查询按次数记', () => {
  let s = ProjectKnowledgeState.parse({})
  s = addSubtaskCandidate(s, { kind: 'lesson', title: '改表格先读表头' }, 'a', 't1').next
  s = addSubtaskCandidate(s, { kind: 'lesson', title: '改表格 先读表头', rule: '读 header' }, 'b', 't2').next
  assert.equal(s.candidates.length, 1)
  assert.equal(s.candidates[0].rule, '读 header')
  assert.equal(s.candidates[0].origin, 'subtask')
  s = addMiss(s, '掉落表', 'a', 't1')
  s = addMiss(s, '掉落表', 'a', 't2')
  s = addMiss(s, '掉落表 ', 'b', 't3')
  assert.equal(s.misses[0].count, 2, '同一个对话里重复查只算一次')
})

test('入库校验：经过、太空、没有触发键、和已有的几乎一样都退回', () => {
  const base = {
    title: '跑 e2e 前先去掉代理变量',
    rule: '`env -u ANTHROPIC_BASE_URL npm run test:e2e`',
    cause: '',
    paths: [],
  }
  assert.equal(admitLesson(base, []).ok, true)
  assert.match(admitLesson({ ...base, title: '刚才 e2e 跑挂了' }, []).problems.join(), /经过/)
  assert.match(admitLesson({ ...base, rule: '要按规范做' }, []).problems.join(), /触发键/)
  assert.equal(admitLesson({ ...base, rule: '要按规范做' }, [], true).ok, true, 'global 的不要求触发键')
  assert.equal(admitLesson({ ...base, rule: '', episode: 'k1' }, []).ok, true, '当场捕获的自带触发键')
  const old = L({ id: 'old', title: base.title, rule: base.rule })
  assert.equal(admitLesson(base, [old]).similar?.id, 'old')
  assert.equal(admitLesson({ ...base, replaces: 'old' }, [old]).ok, true)
})

test('升降级建议：推了还犯建议拦截，很久没用上建议过时，常帮上建议提炼', () => {
  const now = Date.parse('2026-11-15T00:00:00Z')
  const ls = ['v', 's', 'p'].map((id) => L({ id, createdAt: '2026-08-01T00:00:00Z' }))
  const hit = (o: Record<string, unknown>) => ({
    count: 1,
    lastAt: '2026-11-14T00:00:00Z',
    taskIds: [],
    helped: 0,
    violated: 0,
    missed: 0,
    ...o,
  })
  const out = lessonSuggestions(
    ls,
    { v: hit({ violated: 2 }), p: hit({ helped: 3, taskIds: ['a', 'b', 'c'] }) },
    {},
    now,
  )
  assert.deepEqual(
    out.map((x) => `${x.id}:${x.action}`),
    ['v:upgrade', 's:stale', 'p:promote'],
  )
})
