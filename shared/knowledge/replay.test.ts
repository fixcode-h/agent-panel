/**
 * 回放评测：按时间顺序重放推送规则，数推送、复发、失败后改对和绕路步数。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectLesson, type ToolUse } from '../schema.ts'
import { ProjectExperience } from '../experience.ts'
import { replay } from './replay.ts'

const run = (cmd: string, failed = false, output = ''): ToolUse => ({
  kind: 'run',
  label: cmd,
  input: cmd,
  detail: '',
  failed,
  output,
})
const tool = (kind: ToolUse['kind'], label: string): ToolUse => ({ kind, label, detail: '' })
const ERR = 'src/a.ts(1,1): error TS2589: Type instantiation is excessively deep and possibly infinite.'

test('回放：推送按对话去重，数复发、失败后改对和第一次改文件前的步数', () => {
  const lessons = [
    ProjectLesson.parse({
      id: 'e2e',
      title: 'e2e 在 WSL 里跑',
      rule: '`npm run test:e2e` 放到 WSL 里跑',
      createdAt: '',
    }),
  ]
  const exps = [ProjectExperience.parse({ id: 'drop', title: '掉落表在哪', keywords: ['UDropTable'], createdAt: '' })]
  const s = replay(
    [
      {
        id: 'a',
        title: '',
        at: '2026-11-01',
        tools: [
          tool('search', 'UDropTable · Source'),
          tool('read', '/p/Source/a.h'),
          run('npm run test:e2e'),
          run('npm run test:e2e'),
          run('npx tsc', true, ERR),
          run('npx tsc -p tsconfig.app.json'),
          tool('edit', '/p/src/a.ts'),
        ],
      },
      { id: 'b', title: '', at: '2026-11-02', tools: [run('npx tsc', true, ERR)] },
    ],
    lessons,
    exps,
    ['/p'],
  )
  assert.equal(s.conversations, 2)
  assert.equal(s.pushes.command, 1, '同一个对话里同一条只推一次')
  assert.equal(s.pushes.search, 1)
  assert.equal(s.failures, 2)
  assert.equal(s.fixAfterFail, 1, 'tsc 失败后换了参数成功')
  assert.equal(s.recurUncovered, 1, '同一个报错在第二个对话又出现，没有教训覆盖')
  assert.equal(s.detourMedian, 2)
  assert.deepEqual(s.topHits.map((h) => h.id).sort(), ['drop', 'e2e'])
  assert.ok(s.pushChars > 0 && s.convWithPush === 1)
})
