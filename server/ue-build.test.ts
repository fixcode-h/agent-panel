import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TestStep } from '../shared/schema.ts'
import { buildSteps, isUeBuildCommand } from '../shared/test-steps.ts'
import { fillSkills } from '../shared/expose.ts'
import { RETIRED_SKILLS } from '../shared/skill-guide.ts'
import { BUILTIN_AGENTS } from '../shared/builtin/agents.ts'
import type { Orchestra } from '../shared/engine.ts'
import { createBackground } from './background.ts'
import { RETIRED_BUNDLED, retireBundled } from './bundled-skills.ts'
import { callOrchTool, orchHint, orchTools } from './orch-mcp.ts'

/**
 * UE 项目的编译归父对话：子对话不编译、向父对话申请，父对话按申请向面板占位编译，
 * 面板按编译目录排队（各自 worktree 的目录互不占位）；父对话之间能互相传话
 */

const step = (x: Partial<TestStep>) => TestStep.parse({ id: 's', name: '步骤', command: 'x', ...x })

test('申请编译跑哪些步骤：先认「合并时编译」，没有再按名字认编译，停用的不跑', () => {
  const steps = [
    step({ id: 'lua', name: 'Lua 语法检查', command: 'luac -p a.lua' }),
    step({ id: 'ue-build', name: '编译', command: 'Build.bat X', merge: true }),
    step({ id: 'off', name: '编译 Server', command: 'Build.bat S', merge: true, enabled: false }),
  ]
  assert.deepEqual(
    buildSteps(steps).map((s) => s.id),
    ['ue-build'],
  )
  assert.deepEqual(
    buildSteps([step({ id: 'b', name: 'Build Editor', command: 'Build.bat E' }), step({ id: 'l', name: 'Lua' })]).map(
      (s) => s.id,
    ),
    ['b'],
  )
  assert.deepEqual(buildSteps([step({ name: 'Lua 检查' })]), [])
})

test('认得出 UE 的编译命令，普通命令不误伤', () => {
  for (const c of [
    'Build.bat GameEditor Win64 Development -Project=D:/G/G.uproject -WaitMutex',
    '"C:\\UE_5.4\\Engine\\Build\\BatchFiles\\Build.bat" GameEditor Win64 Development',
    'cmd.exe /d /c "Build.bat X Win64 Development"',
    'RunUAT.bat BuildCookRun -project=G.uproject',
    'UnrealEditor-Cmd.exe G.uproject -run=Automation',
    'dotnet UnrealBuildTool.dll GameEditor Win64 Development',
  ])
    assert.ok(isUeBuildCommand(c), c)
  for (const c of [
    'npm run build',
    'luac -p a.lua',
    'git log --oneline',
    'node scripts/build.mjs',
    'cat Build.batch.txt',
  ])
    assert.ok(!isUeBuildCommand(c), c)
})

test('编译按目录占位：同一目录排队、能查到谁占着，各自 worktree 的目录互不占位', async () => {
  const a = mkdtempSync(path.join(tmpdir(), 'ue-a-'))
  const b = mkdtempSync(path.join(tmpdir(), 'ue-b-'))
  writeFileSync(path.join(a, 'wait.cjs'), 'setTimeout(() => {}, 300)\n')
  let left = 3
  let done: () => void = () => {}
  const all = new Promise<void>((r) => (done = r))
  const bg = createBackground(() => --left === 0 && done())
  try {
    bg.start({ taskId: 'p1', name: 'UE 编译：编译', command: 'node wait.cjs', cwd: '', root: a, exclusive: true })
    const second = bg.start({
      taskId: 'p2',
      name: 'UE 编译：编译',
      command: 'echo 2',
      cwd: '',
      root: a,
      exclusive: true,
    })
    assert.match(second.info, /前面还有 1 条/)
    assert.deepEqual(
      bg.occupants(a).map((j) => j.taskId),
      ['p1', 'p2'],
    )
    // 另一个 worktree：自己一队，不被 a 的编译占着
    assert.deepEqual(bg.occupants(b), [])
    const other = bg.start({
      taskId: 'p3',
      name: 'UE 编译：编译',
      command: 'echo 3',
      cwd: '',
      root: b,
      exclusive: true,
    })
    assert.doesNotMatch(other.info, /前面还有/)
    await all
    assert.deepEqual(bg.occupants(a), [], '跑完就释放占位')
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

const orch = (x: Partial<Orchestra>) => ({ self: 'chat', hasMain: false, common: [], ...x }) as unknown as Orchestra
const names = (o: Orchestra) => (orchTools(o) as { name: string }[]).map((x) => x.name)

test('子对话：有独立分支的用 submit_merge 带 build 申请，没有的用 request_build；不是 UE 项目时都没有', async () => {
  const merged: unknown[] = []
  const asked: string[] = []
  const branch = orch({
    child: true,
    canSubmit: true,
    isolated: true,
    ueBuild: 'child',
    submitMerge: async (_n: string, _t: string, build?: boolean) => {
      merged.push(build)
      return { ok: true, info: 'ok' }
    },
  })
  const tool = (orchTools(branch) as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find(
    (x) => x.name === 'submit_merge',
  )!
  assert.ok('build' in tool.inputSchema.properties)
  assert.ok(!names(branch).includes('request_build'), '独立分支要先合回去才编得到，不给 request_build')
  assert.match(orchHint(branch), /申请编译/)
  await callOrchTool(branch, 'submit_merge', { note: 'n', tests: 'Lua 语法检查通过' })
  await callOrchTool(branch, 'submit_merge', { note: 'n', tests: '只改注释', build: false })
  assert.deepEqual(merged, [true, false], '默认申请编译，只改文档时可以不申请')

  const shared = orch({
    child: true,
    ueBuild: 'child',
    requestBuild: async (note: string) => {
      asked.push(note)
      return { ok: true, info: '已向父对话申请编译' }
    },
  })
  assert.ok(names(shared).includes('request_build'))
  await callOrchTool(shared, 'request_build', { note: '改了 Inventory 模块' })
  assert.deepEqual(asked, ['改了 Inventory 模块'])
  // 共用目录的子对话（P4 等）也能请父对话验收：编译走 request_build，submit_merge 不带 build
  const sharedSubmit = orch({ child: true, canSubmit: true, ueBuild: 'child' })
  assert.ok(names(sharedSubmit).includes('request_build'))
  const sharedTool = (
    orchTools(sharedSubmit) as { name: string; inputSchema: { properties: Record<string, unknown> } }[]
  ).find((x) => x.name === 'submit_merge')!
  assert.ok(!('build' in sharedTool.inputSchema.properties))

  const plain = orch({ child: true, canSubmit: true, ueBuild: '' })
  assert.ok(!names(plain).includes('request_build'))
  const plainTool = (orchTools(plain) as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find(
    (x) => x.name === 'submit_merge',
  )!
  assert.ok(!('build' in plainTool.inputSchema.properties))
})

test('父对话：申请编译、查看其他父对话、给它们传话', async () => {
  const sent: [string, string][] = []
  const o = orch({
    coordinator: true,
    ueBuild: 'parent',
    peers: true,
    requestBuild: async (note: string, step?: string) => ({ ok: true, info: `排上了：${note}${step ?? ''}` }),
    listPeers: async () => '- p2｜另一个父对话｜执行中｜占着编译：UE 编译：编译（正在跑）',
    messagePeer: async (id: string, text: string) => {
      sent.push([id, text])
      return { ok: true, info: '已交给父对话' }
    },
  })
  assert.deepEqual(
    names(o).filter((n) => ['request_build', 'list_peers', 'message_peer'].includes(n)),
    ['request_build', 'list_peers', 'message_peer'],
  )
  assert.match(orchHint(o), /request_build/)
  assert.match(orchHint(o), /message_peer/)
  const r = await callOrchTool(o, 'request_build', { note: '子对话 A、B 的申请' })
  assert.match(r.content[0].text, /排上了：子对话 A、B 的申请/)
  assert.match((await callOrchTool(o, 'list_peers', {})).content[0].text, /占着编译/)
  await callOrchTool(o, 'message_peer', { id: 'p2', text: '我等你编完再申请' })
  assert.deepEqual(sent, [['p2', '我等你编完再申请']])
  // 不是 UE 项目的父对话：没有申请编译，照样能和别的父对话传话
  const plain = orch({ coordinator: true, ueBuild: '', peers: true })
  assert.ok(!names(plain).includes('request_build'))
  assert.ok(names(plain).includes('message_peer'))
})

test('下线的 UE 技能：内置角色不再点名，已装副本里留着的名字拼提示词时跳过', () => {
  for (const b of BUILTIN_AGENTS)
    for (const s of b.agent.skills) assert.ok(!RETIRED_SKILLS.has(s), `${b.key} 还在用 ${s}`)
  assert.deepEqual(fillSkills(['project-testing', 'ue-multi-agent-coordination', 'lua-luac-compiler'], {}), [
    'project-testing',
  ])
  assert.ok(!existsSync(path.resolve(import.meta.dirname, '../skills/ue/ue-multi-agent-coordination')))
  assert.ok(!existsSync(path.resolve(import.meta.dirname, '../skills/ue/lua-luac-compiler')))
})

test('部署目录里下线技能的旧副本：按「分类/名字」找到，和当初部署的一致才删', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skills-'))
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  try {
    const dir = path.join(root, 'ue', 'old')
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    writeFileSync(path.join(dir, 'SKILL.md'), '旧')
    writeFileSync(path.join(dir, 'scripts', 'x.py'), 'print(1)')
    const kept = path.join(root, 'ue', 'kept')
    mkdirSync(kept, { recursive: true })
    writeFileSync(path.join(kept, 'SKILL.md'), '用户改过')
    const retired = {
      'ue/old': { 'SKILL.md': sha('旧'), 'scripts/x.py': sha('print(1)') },
      'ue/kept': { 'SKILL.md': sha('旧') },
    }
    assert.deepEqual(await retireBundled(root, retired), ['ue/old'])
    assert.deepEqual(readdirSync(path.join(root, 'ue')), ['kept'])
    assert.equal(readFileSync(path.join(kept, 'SKILL.md'), 'utf8'), '用户改过')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // 登记的就是这次下线的两个
  assert.ok('ue/ue-multi-agent-coordination' in RETIRED_BUNDLED)
  assert.ok('ue/lua-luac-compiler' in RETIRED_BUNDLED)
})
