import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import { doneEvidence, isVerifyCommand, verifyGateError } from './done-evidence.ts'
import { END_REJECTED, endTurnCheck, gateApplies } from './end-turn.ts'
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

test('验证门禁：适用的步骤最后一次跑失败不算过，修好重跑通过才放行', () => {
  const steps = [{ name: '单测', command: 'npm run test:unit' }]
  const red = doneEvidence(
    [
      agent(
        tool({ kind: 'edit', label: 'a.ts' }),
        tool({ kind: 'run', label: 'npm run test:unit', exitCode: 1, failed: true }),
      ),
    ],
    steps,
  )
  assert.match(verifyGateError(red, steps), /「单测」最后一次没通过，退出码 1.*blocked/)
  const fixed = doneEvidence(
    [
      agent(
        tool({ kind: 'edit', label: 'a.ts' }),
        tool({ kind: 'run', label: 'npm run test:unit', exitCode: 1, failed: true }),
        tool({ kind: 'run', label: 'npm run test:unit -- a.test.ts', exitCode: 0 }),
      ),
    ],
    steps,
  )
  assert.equal(verifyGateError(fixed, steps), '', '同一条步骤以最后一次为准')
  // 没配步骤时看最后一次验证命令
  const generic = doneEvidence([
    agent(tool({ kind: 'edit', label: 'a.ts' }), tool({ kind: 'run', label: 'npx tsc', exitCode: 2 })),
  ])
  assert.match(verifyGateError(generic, []), /最后一次验证命令（npx tsc）没通过，退出码 2/)
})

test('验证门禁：只看适用的步骤，关掉的和改动不涉及的不逼它跑', () => {
  const ue = {
    name: '编译 UE',
    command: 'Build.bat MyGameEditor Win64 Development',
    appliesTo: ['**/*.cpp', '**/*.h'],
    scope: 'changed' as const,
  }
  const off = { name: '单测', command: 'npm test', enabled: false }
  const lua = doneEvidence([agent(tool({ kind: 'edit', label: 'Content/Script/ui.lua' }))])
  assert.equal(
    verifyGateError(lua, [ue, off], { applies: gateApplies }),
    '',
    '只改了 Lua：编译 C++ 不适用，关掉的单测也不算',
  )
  const cpp = doneEvidence([agent(tool({ kind: 'edit', label: 'Source/Game/A.cpp' }))])
  assert.match(verifyGateError(cpp, [ue, off], { applies: gateApplies }), /还没跑过项目的测试步骤.*「编译 UE」/)
  assert.doesNotMatch(verifyGateError(cpp, [ue, off], { applies: gateApplies }), /单测/)
})

test('验证门禁：命令改的文件（快照差）也算改了代码', () => {
  const steps = [{ name: '单测', command: 'npm test' }]
  const msgs = [agent(tool({ kind: 'run', label: "sed -i 's/a/b/' src/a.ts" }))]
  const ev = doneEvidence(msgs, steps, { files: ['src/a.ts'] })
  assert.deepEqual(ev.files, ['src/a.ts'])
  assert.equal(ev.code, true)
  assert.match(verifyGateError(ev, steps), /还没跑过项目的测试步骤/)
  // 工具调用点名过的不重复列（一个写 ./ 开头）
  assert.deepEqual(
    doneEvidence([agent(tool({ kind: 'edit', label: './src/a.ts' }))], [], { files: ['src/a.ts'] }).files,
    ['./src/a.ts'],
  )
})

test('验证门禁：插件验证通过的资产不再要求项目步骤，插件验证失败拒绝', () => {
  const steps = [
    { name: '编译 UE', command: 'Build.bat', appliesTo: ['**/*.cpp'], scope: 'changed' as const },
    { name: '类型检查', command: 'npm run typecheck' },
  ]
  const passed = { command: '蓝图编译', plugin: true }
  const extra = { files: ['Content/BP_Hero.uasset'], commands: [passed], covered: ['Content/BP_Hero.uasset'] }
  const ev = doneEvidence([], steps, extra)
  assert.equal(ev.code, true)
  assert.deepEqual(ev.commands, [passed])
  assert.equal(
    verifyGateError(ev, steps, { covered: extra.covered, applies: gateApplies }),
    '',
    '资产由插件验证过，类型检查这条「总是执行」的步骤不用为它跑',
  )
  assert.match(verifyGateError(ev, steps), /还没跑过项目的测试步骤.*类型检查/, '没验证过的资产照常要求')
  const bad = doneEvidence([], steps, { ...extra, commands: [{ ...passed, failed: true }], covered: [] })
  assert.match(verifyGateError(bad, steps), /插件的验证「蓝图编译」最后一次没通过/)
})
