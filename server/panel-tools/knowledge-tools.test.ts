/**
 * knowledge_lookup / knowledge_record（ADR 0066）：一个入口查教训和经验、没配上记一次；记教训带上入库校验标记，
 * 子任务记的进候选。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callOrchTool, orchTools } from '../orch-mcp.ts'

type O = Parameters<typeof orchTools>[0]

test('knowledge_lookup：教训和经验合在一起给，两边都没配上时记一次没配上的查询', async () => {
  const misses: string[] = []
  const o = {
    self: 'n1',
    common: [],
    lessons: {
      find: async (_f: string[], q: { query?: string }) =>
        q.query === 'e2e' ? '### 跑 e2e 去掉代理' : '没有符合条件的教训。',
    },
    experience: {
      find: async (q: string) => (q === 'e2e' ? '- e2e 的脚本在 scripts/e2e' : '没有相关的经验，按正常的办法找。'),
      list: async () => [],
      miss: (q: string) => misses.push(q),
    },
  } as unknown as O
  assert.ok(orchTools(o).some((x) => x.name === 'knowledge_lookup'))
  const hit = (await callOrchTool(o, 'knowledge_lookup', { query: 'e2e' })).content[0].text
  assert.match(hit, /## 教训\n### 跑 e2e/)
  assert.match(hit, /## 经验\n- e2e 的脚本/)
  const none = await callOrchTool(o, 'knowledge_lookup', { query: '掉落表' })
  assert.match(none.content[0].text, /没有相关的教训和经验/)
  assert.deepEqual(misses, ['掉落表'])
})

test('knowledge_record：教训带 strict 交给宿主校验；子任务的进候选；kind 不对报错', async () => {
  const got: unknown[] = []
  const proposed: unknown[] = []
  const o = {
    self: 'n1',
    common: [],
    lessons: {
      find: async () => '',
      record: async (x: unknown) => (got.push(x), { ok: true, info: '已记下' }),
    },
  } as unknown as O
  await callOrchTool(o, 'knowledge_record', {
    kind: 'lesson',
    title: '跑 e2e 前去掉代理变量',
    rule: '用 env -u',
    commands: ['npm run test:e2e'],
    episode: 'k1',
  })
  assert.deepEqual(got[0], {
    title: '跑 e2e 前去掉代理变量',
    rule: '用 env -u',
    cause: '',
    wrong: '',
    paths: [],
    commands: ['npm run test:e2e'],
    tags: [],
    episode: 'k1',
    global: false,
    strict: true,
  })
  assert.equal((await callOrchTool(o, 'knowledge_record', { kind: 'x', title: 'a' })).isError, true)
  const helper = {
    ...o,
    lessons: {
      find: async () => '',
      propose: async (x: unknown) => (proposed.push(x), { ok: true, info: '已放进候选' }),
    },
  } as unknown as O
  const r = await callOrchTool(helper, 'knowledge_record', { kind: 'lesson', title: '改表格先读表头', rule: 'r' })
  assert.equal(r.content[0].text, '已放进候选')
  assert.equal((proposed[0] as { kind: string }).kind, 'lesson')
})
