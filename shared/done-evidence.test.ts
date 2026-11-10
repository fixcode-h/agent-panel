import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import { doneEvidence, isVerifyCommand, verifyGateError } from './done-evidence.ts'
import { END_REJECTED, endTurnCheck } from './end-turn.ts'
import type { Task, TaskMessage, ToolUse } from './schema.ts'

setLang('zh')

const tool = (x: Partial<ToolUse> & Pick<ToolUse, 'kind' | 'label'>): ToolUse => ({ detail: '', ...x })
const agent = (...tools: ToolUse[]): TaskMessage =>
  ({ id: 'm', role: 'agent', agentId: '', step: '', text: '', tools, at: '2026-11-10T00:00:01Z' }) as TaskMessage
const user = (): TaskMessage =>
  ({
    id: 'u',
    role: 'user',
    agentId: '',
    step: '',
    text: '改一下',
    tools: [],
    at: '2026-11-10T00:00:00Z',
  }) as TaskMessage

test('完成依据：列出改过的文件和验证命令的退出码，同一条命令只留最后一次', () => {
  const ev = doneEvidence([
    agent(
      tool({ kind: 'edit', label: 'src/a.ts' }),
      tool({ kind: 'run', label: 'npm run typecheck', exitCode: 2, failed: true }),
      tool({ kind: 'edit', label: 'src/a.ts' }),
      tool({ kind: 'run', label: 'ls -la' }),
      tool({ kind: 'run', label: 'npm run typecheck', exitCode: 0 }),
      tool({ kind: 'edit', label: 'docs/x.md' }),
    ),
  ])
  assert.deepEqual(ev.files, ['src/a.ts', 'docs/x.md'])
  assert.deepEqual(ev.commands, [{ command: 'npm run typecheck', exitCode: 0 }])
  assert.equal(ev.code, true)
  assert.equal(ev.unverified, false)
})

test('完成依据：改了代码却没跑验证命令要标出来；只改文档、改文件失败的不算', () => {
  assert.equal(doneEvidence([agent(tool({ kind: 'edit', label: 'a.ts' }))]).unverified, true)
  assert.equal(doneEvidence([agent(tool({ kind: 'edit', label: 'README.md' }))]).unverified, false)
  assert.equal(doneEvidence([agent(tool({ kind: 'edit', label: 'a.ts', failed: true }))]).unverified, false)
  // 面板自己的工具不算
  const ev = doneEvidence([agent(tool({ kind: 'run', name: 'mcp__panel__end_turn', label: 'npm test' }))])
  assert.equal(ev.commands.length, 0)
})

test('验证命令：认测试步骤和常见的测试、类型检查、编译命令，不认普通命令', () => {
  for (const c of ['npm test', 'pnpm run lint', 'npx tsc -b', 'cargo test', 'go vet ./...', 'python -m pytest -q'])
    assert.equal(isVerifyCommand(c), true, c)
  for (const c of ['ls build', 'git status', 'cat test.txt', 'npm install']) assert.equal(isVerifyCommand(c), false, c)
  assert.equal(
    isVerifyCommand('cd web && ./run-checks.sh --fast', [{ name: '检查', command: './run-checks.sh' }]),
    true,
  )
})

test('拦截：配了测试步骤只认测试步骤；没配的认常见验证命令；没改代码不拦', () => {
  const steps = [{ name: '单测', command: 'npm run test:unit' }]
  const edited = doneEvidence([agent(tool({ kind: 'edit', label: 'a.ts' }), tool({ kind: 'run', label: 'npx tsc' }))])
  assert.match(verifyGateError(edited, steps), /还没跑过项目的测试步骤.*npm run test:unit/)
  assert.equal(verifyGateError(edited, []), '')
  const ran = doneEvidence(
    [agent(tool({ kind: 'edit', label: 'a.ts' }), tool({ kind: 'run', label: 'npm run test:unit' }))],
    steps,
  )
  assert.equal(verifyGateError(ran, steps), '')
  assert.equal(verifyGateError(doneEvidence([agent(tool({ kind: 'edit', label: 'a.md' }))]), steps), '')
})

test('end_turn：记成做完时带上完成依据；打开拦截时没跑测试步骤就拒绝并说明', () => {
  const tk = {
    plans: [],
    steps: [],
    changes: [],
    messages: [agent(tool({ kind: 'edit', label: 'old.ts' })), user(), agent(tool({ kind: 'edit', label: 'a.ts' }))],
  } as unknown as Task
  const r = endTurnCheck(tk, 'done', '')
  assert.equal(r.ok, true)
  assert.deepEqual(r.end?.evidence?.files, ['a.ts'], '只算这一轮（这条输入之后）的')
  assert.equal(r.end?.evidence?.unverified, true)
  const g = endTurnCheck(tk, 'done', '', { steps: [{ name: '单测', command: 'npm test' }] })
  assert.equal(g.ok, false)
  assert.ok(g.info.startsWith(END_REJECTED))
  assert.equal(g.end, undefined)
})
