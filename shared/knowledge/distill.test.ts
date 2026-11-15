/**
 * 四期提炼：挑哪些教训写进 AGENTS.md / 模块文档 / 面板建议、没配上的查询、教训转钩子。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { ProjectLesson } from '../schema.ts'
import { HookDef } from '../hooks/defs.ts'
import { distill, lessonHook, pickForAgents, pickForPanel, pickMisses } from './distill.ts'

const lesson = (id: string, extra: Record<string, unknown> = {}) =>
  ProjectLesson.parse({ id, title: `规则 ${id}`, rule: `做法 ${id}`, createdAt: '', ...extra })
const hit = (count: number, helped = 0, violated = 0, missed = 0) => ({
  count,
  lastAt: '',
  taskIds: [],
  helped,
  violated,
  missed,
})

test('写进 AGENTS.md：置顶或用得多的才挑，推了还犯的排前面，已提炼和停用的不挑', () => {
  const ls = [
    lesson('a'),
    lesson('b'),
    lesson('c', { status: 'pinned' }),
    lesson('d', { status: 'promoted' }),
    lesson('e', { enabled: false }),
    lesson('f'),
  ]
  const hits = { a: hit(3), b: hit(1), d: hit(9), e: hit(9), f: hit(4, 2, 3) }
  assert.deepEqual(pickForAgents(ls, hits), ['f', 'a', 'c'])
  const r = distill('agents', '项目', ls, hits, [])
  assert.ok(r.ok && r.prompt?.includes('[f] 规则 f') && r.prompt.includes('已提炼'))
  assert.equal(distill('agents', '项目', [lesson('x')], {}, []).ok, false, '挑不出时说明原因')
})

test('面板建议挑事前没推到、推了还犯的；没配上的查询只要出现两次以上的', () => {
  const ls = [lesson('a'), lesson('b'), lesson('c')]
  assert.deepEqual(pickForPanel(ls, { a: hit(1, 0, 0, 1), b: hit(5, 0, 1), c: hit(5, 0, 2) }), ['c', 'a'])
  const ms = pickMisses([
    { query: '掉落表', count: 3, convs: [], lastAt: '' },
    { query: '只一次', count: 1, convs: [], lastAt: '' },
  ])
  assert.deepEqual(
    ms.map((m) => m.query),
    ['掉落表'],
  )
  const r = distill('misses', '项目', [], {}, ms)
  assert.ok(r.ok && r.prompt?.includes('掉落表（3 次）'))
})

test('教训转钩子：命令触发键和错的做法里的命令都拦，对的做法里的命令放过', () => {
  assert.equal(lessonHook(lesson('n'), 'p1'), null, '认不出命令的转不了')
  const l = lesson('e2e', {
    title: 'e2e 在 WSL 里跑',
    rule: '用 `npm run test:e2e:wsl`',
    wrong: '在 Windows 本机直接跑 `npm run e2e:win`',
    triggers: { commands: ['npm run test:e2e'] },
  })
  const def = HookDef.parse(lessonHook(l, 'p1'))
  assert.equal(def.event, 'tool.before')
  assert.deepEqual(def.scope.projects, ['p1'])
  assert.equal(def.match.tool, 'shell')
  assert.ok(def.enabled)
  assert.equal(def.action.type, 'command')
  const script = def.action.type === 'command' ? def.action.script : ''
  const run = (command: string) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      input: JSON.stringify({ tool: { input: { command } } }),
      encoding: 'utf8',
    })
    return r.stdout ? (JSON.parse(r.stdout) as { deny?: boolean; reason?: string }) : {}
  }
  const deny = run('cd web && npm run test:e2e')
  assert.ok(deny.deny && deny.reason?.includes('对的做法'))
  assert.equal(run('npm run test:unit').deny, undefined)
  assert.equal(run('npm run e2e:win').deny, true, '错的做法里写的命令也拦')
  assert.equal(run('npm run test:e2e:wsl').deny, undefined, '对的做法不拦；前缀按整词比，test:e2e 不误伤 test:e2e:wsl')
})
