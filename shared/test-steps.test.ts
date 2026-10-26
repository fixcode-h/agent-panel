/**
 * 测试步骤按改动范围筛选：判定只有一处（stepApplies），提示词和界面都读它。
 * 这里的用例钉住三件事：老步骤没有 appliesTo 时总是执行、合并进来的改动也算本次改动、
 * 提示词里写清了「先看改动再决定跑哪些」和「跳过要写理由」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHANGED_FILES_RULE,
  TEST_TIME_SUMMARY_RULE,
  appliesToText,
  currentTestSteps,
  defaultTestSteps,
  matchTestStep,
  matchesGlob,
  parentRunRoleOf,
  mergeTestRun,
  parentRunSteps,
  parseGlobs,
  stepApplies,
  testRunLines,
  testStepsBlock,
  testStepsText,
  verifyBlock,
} from './test-steps.ts'
import { type TaskTestRun, type TestStep, ProjectInput } from './schema.ts'

const step = (appliesTo: string[], more: Partial<TestStep> = {}) => ({
  id: 's',
  name: '编译',
  command: 'build',
  env: 'auto' as const,
  cwd: '',
  when: '',
  appliesTo,
  timeoutSec: 0,
  note: '',
  enabled: true,
  merge: false,
  // helper 的默认范围是 changed：原来「写了 appliesTo 就筛、为空就总是跑」的语义，老用例照旧
  scope: 'changed' as const,
  quick: false,
  ...more,
})
const byId = (steps: ReturnType<typeof defaultTestSteps>, id: string) => steps.find((s) => s.id === id)!

test('glob 匹配：** 跨目录、**/ 也认根目录下的文件、目录写法按目录算', () => {
  assert.ok(matchesGlob('Source/Game/Foo.cpp', '**/*.cpp'))
  assert.ok(matchesGlob('Foo.cpp', '**/*.cpp'), '**/ 要能匹配零层目录')
  assert.ok(!matchesGlob('README.md', '**/*.cpp'))
  // UE 的模块脚本叫 <模块>.Build.cs，所以要写 **/*.Build.cs 才命中；**/Build.cs 只认这个文件名
  assert.ok(matchesGlob('Source/Game/Game.Build.cs', '**/*.Build.cs'))
  assert.ok(matchesGlob('Source/Game/Build.cs', '**/Build.cs'))
  assert.ok(!matchesGlob('Source/Game/Game.Target.cs', '**/*.Build.cs'))
  // 以 / 结尾按目录算，等价于 web/**
  assert.ok(matchesGlob('web/src/a.ts', 'web/'))
  assert.ok(matchesGlob('web/a.ts', 'web/'))
  assert.ok(!matchesGlob('webby/a.ts', 'web/'))
  // 没写通配符的也按目录前缀算：项目教训里习惯写 web/src，照抄进「适用改动」不能变成永远匹配不上
  assert.ok(matchesGlob('web/src/a.ts', 'web/src'))
  assert.ok(matchesGlob('web/src', 'web/src'))
  assert.ok(!matchesGlob('web/srcs/a.ts', 'web/src'), '按完整目录名算，不能前缀糊到 web/srcs')
  // Windows 传来的反斜杠也认
  assert.ok(matchesGlob('Source\Game\Foo.cpp', '**/*.cpp'))
})

test('老步骤没有 appliesTo 时总是执行，不会因为升级漏跑', () => {
  assert.equal(stepApplies(step([]), ['README.md']), true)
  assert.equal(stepApplies(step([]), []), true)
  // 保存校验给默认值：老数据解析上来是空数组而不是 undefined
  const saved = ProjectInput.parse({
    name: '项目',
    path: '/tmp/p',
    testSteps: [{ id: 'a', name: '类型检查', command: 'npm run typecheck' }],
  })
  assert.deepEqual(saved.testSteps[0].appliesTo, [])
})

test('只有完全不匹配才跳过；合并进来的改动同样计入清单', () => {
  const build = step(['**/*.cpp', '**/*.h', '**/*.cs'])
  // 自己只改文档、但从远端合并进来 C++ 改动：改动清单里有 .cpp，编译要跑
  assert.equal(stepApplies(build, ['docs/a.md', 'Source/Game/Foo.cpp']), true)
  // 自己改了 C++、远端合并进来文档：同样要跑
  assert.equal(stepApplies(build, ['Source/Game/Foo.cpp', 'docs/a.md']), true)
  // 确实只有文档：才跳过
  assert.equal(stepApplies(build, ['docs/a.md', 'README.md']), false)
  // 清单为空表示取不到（没有版本控制、命令失败、不知道基线），未知不等于不相关：按总是执行，宁可多跑
  assert.equal(stepApplies(build, []), true, '取不到改动清单时总是执行，不能静默漏跑')
})

test('界面上那行文字怎么变回 glob：中英文逗号、换行都认', () => {
  assert.deepEqual(parseGlobs('**/*.cpp, **/Build.cs，web/'), ['**/*.cpp', '**/Build.cs', 'web/'])
  assert.deepEqual(parseGlobs('  '), [])
})

test('提示词先教看改动再决定跑哪些：含任务基线到 HEAD 的完整清单和合并口径', () => {
  const text = testStepsBlock([step(['**/*.cpp'], { merge: true })], 'win32')
  assert.match(text, /不要无脑全跑/)
  assert.match(text, /git diff --name-only <任务基线>\.\.\.HEAD/, '三点比较，含合并进来的内容')
  assert.match(text, /合并进来的文件也算本次改动/, '拉取 / 合并进来的改动同样计入')
  assert.match(text, /不能以「这部分不是我改的」为理由跳过/)
  assert.match(text, /跳过：<步骤名> — 本次及合并进来的改动都没有/)
  assert.match(text, /本次改动不涉及配置的测试步骤/)
  assert.match(text, /为了保险全部跑一遍/)
  assert.match(text, /取不到改动清单时/, '清单未知时按总是执行，提示词里要写明')
  assert.match(text, /清单未知不等于不相关/)
  assert.match(text, /名字后面标了「合并时编译」的步骤/, '步骤行会标「合并时编译」，规则不能悬空')
  assert.match(text, /合并时编译/, 'merge 的步骤行要标出来')
  assert.match(text, /git merge-base HEAD <主分支>/, '不知道任务基线时的退路')
  // 范围是「整体」时不筛：和测试角色里 {{#if scope=本次改动}} 的分支一致
  assert.match(text, /不按改动清单筛/, '整体 / 发布前验证 / 整体验收不筛，不能和范围参数矛盾')
  assert.match(text, /发布前验证、整体验收这类节点存在的意义就是不筛/)
  // 合并场景的示例，模型更容易照做
  assert.match(text, /自己只改了文档、但从远端合并进来 C\+\+ 改动 → 编译照跑/)
  assert.match(text, /适用改动（清单里一个都不匹配就跳过这一步）：\*\*\/\*\.cpp/)
  assert.match(text, /同一时间仍然只编译一次/)
})

test('没写适用范围的步骤在提示词里说明总是执行，而不是当成条件缺失', () => {
  assert.equal(appliesToText(step([])), '未设置，总是执行')
  assert.match(testStepsBlock([step([])], 'win32'), /适用改动（清单里一个都不匹配就跳过这一步）：未设置，总是执行/)
  // 对话里的验证说明也带上同一份筛选规则
  const scaled = verifyBlock([step(['**/*.cpp'])], { platform: 'win32', scaled: true })
  assert.ok(scaled.includes(CHANGED_FILES_RULE))
  const full = verifyBlock([step(['**/*.cpp'])], { platform: 'win32', scaled: false })
  assert.ok(full.includes(CHANGED_FILES_RULE))
  assert.doesNotMatch(full, /小改动/)
})

test('默认步骤按技术栈带上适用范围：改 Build.cs / .uproject 也要重编，只改资源和文档不编', () => {
  const ue = defaultTestSteps('ue', { windows: true })
  const build = byId(ue, 'ue-build')
  // UBT 按 Build.cs / Target.cs 生成编译规则，按 .uproject 找模块，改了必须重编
  for (const glob of ['**/*.cpp', '**/*.h', '**/*.cs', '**/*.uproject', '**/*.uplugin'])
    assert.ok(build.appliesTo.includes(glob), `ue-build 要覆盖 ${glob}`)
  assert.equal(stepApplies(build, ['Content/Hero.uasset']), false, '只改资源不编译')
  assert.equal(stepApplies(build, ['Config/DefaultEngine.ini']), false, '只改配置不编译')
  assert.equal(stepApplies(build, ['Source/Game/Game.Build.cs']), true)
  assert.equal(stepApplies(build, ['Game.uproject']), true)
  assert.deepEqual(byId(ue, 'ue-lua').appliesTo, ['**/*.lua'])
  assert.equal(stepApplies(byId(ue, 'ue-lua'), ['Script/Game/UI.lua']), true)
  assert.equal(stepApplies(byId(ue, 'ue-lua'), ['Source/Game/Foo.cpp']), false)

  const node = defaultTestSteps('node', {
    windows: true,
    scripts: { typecheck: 'tsc', lint: 'oxlint', 'test:unit': 'tsx', build: 'vite build' },
  })
  // 类型检查 / lint 是「总是跑」：不配适用改动，每次改动都跑（always 不再按 glob 筛，两处规则不打架）
  assert.equal(byId(node, 'node-typecheck').scope, 'always')
  assert.deepEqual(byId(node, 'node-typecheck').appliesTo, [])
  assert.equal(stepApplies(byId(node, 'node-typecheck'), ['docs/a.md']), true, 'always 的步骤每次改动都跑')
  assert.equal(stepApplies(byId(node, 'node-build'), ['web/src/App.tsx']), true)
  assert.equal(stepApplies(byId(node, 'node-build'), ['docs/a.md']), false)
  // 纯 JS 项目（只有 .js / .jsx / .cjs）：改源码时单测、端到端、构建都要跑，不能被判成不适用
  for (const file of ['src/a.js', 'src/a.jsx', 'src/a.cjs'])
    for (const id of ['node-unit', 'node-build'])
      assert.equal(stepApplies(byId(node, id), [file]), true, `${id} 要覆盖 ${file}`)
  assert.equal(byId(node, 'node-lint').scope, 'always', 'lint 每次改动都跑（含文档和样式）')

  const rust = defaultTestSteps('rust', { windows: true })
  assert.deepEqual(byId(rust, 'rust-fmt').appliesTo, ['**/*.rs'], 'cargo fmt 只看 .rs')
  assert.ok(byId(rust, 'rust-test').appliesTo.includes('**/Cargo.toml'))
  assert.equal(stepApplies(byId(rust, 'rust-test'), ['README.md']), false)
  assert.equal(stepApplies(byId(rust, 'rust-test'), ['src/lib.rs']), true)
})

test('「禁止子对话执行」的步骤：子对话跳过，合并时编译的步骤不算在内', () => {
  const e2e = step([], { id: 'e2e', name: '端到端测试', command: 'npm run test:e2e', scope: 'parent' as const })
  const typecheck = step([], { id: 'tc', name: '类型检查', command: 'npm run typecheck' })
  const off = step([], { id: 'off', name: '已停用', command: 'x', scope: 'parent' as const, enabled: false })
  const merge = step([], { id: 'build', name: '编译', command: 'npm run build', scope: 'parent' as const, merge: true })
  assert.deepEqual(
    parentRunSteps([e2e, typecheck, off, merge]).map((s) => s.id),
    ['e2e'],
    '只取启用的、勾了「禁止子对话执行」的；合并时编译的仍走父对话 request_build，不重复跑',
  )
  // 老步骤没有这个字段：解析上来是 false，升级后行为不变
  const saved = ProjectInput.parse({
    name: '项目',
    path: '/tmp/p',
    testSteps: [{ id: 'a', name: '类型检查', command: 'npm run typecheck' }],
  })
  assert.equal(saved.testSteps[0].scope, 'always')
})

test('项目设置以项目当前为准，任务快照只在读不到项目时兜底', () => {
  const snapshot = [step([], { id: 'e2e', name: '端到端测试', command: 'npm run test:e2e', scope: 'always' as const })]
  const latest = [{ ...snapshot[0], scope: 'parent' as const }]
  // 用户报的那个场景：快照里没勾，项目设置里勾上了 → 子对话下次合并要转父对话
  assert.deepEqual(
    parentRunSteps(currentTestSteps(snapshot, { testSteps: latest })).map((s) => s.id),
    ['e2e'],
    '项目设置里勾上了就按勾上算，不看快照',
  )
  // 反向：快照里勾了，项目设置里取消 → 子对话自己跑
  assert.deepEqual(parentRunSteps(currentTestSteps(latest, { testSteps: snapshot })), [], '项目设置里取消就按取消算')
  // 项目读不到 / 被删：快照兜底，不会突然一条步骤都没有
  assert.deepEqual(currentTestSteps(snapshot, undefined), snapshot)
  assert.deepEqual(currentTestSteps(snapshot, null), snapshot)
  // 项目里把步骤删光：就是不跑，不能退回快照（否则用户会以为删除没生效）
  assert.deepEqual(currentTestSteps(snapshot, { testSteps: [] }), [])
  // 内容和策略位一并以项目为准：改命令、停用也是下一次判断就生效
  const changed = [{ ...latest[0], command: 'npm run test:e2e:ci', enabled: false }]
  const now = currentTestSteps(snapshot, { testSteps: changed })
  assert.equal(now[0].command, 'npm run test:e2e:ci')
  assert.deepEqual(parentRunSteps(now), [], '停用后父对话也不跑这条')
})

test('提示词写清谁跑这一步：子对话不跑、父对话不用自己跑', () => {
  const inParent = step([], { name: '端到端测试', command: 'npm run test:e2e', scope: 'parent' as const })
  const self = step([], { name: '类型检查', command: 'npm run typecheck' })
  const child = verifyBlock([inParent, self], { platform: 'win32', scaled: true, parentRun: 'child' })
  assert.match(child, /禁止子对话执行/, '步骤行要标出来')
  assert.match(child, /你不要跑它们/)
  assert.match(child, /完成条件是「改动已合回父对话所在的分支 \+ 父对话测试通过」/)
  assert.match(child, /父对话测试失败时面板会把报错原文推回来/)
  const parent = verifyBlock([inParent, self], { platform: 'win32', scaled: true, parentRun: 'parent' })
  assert.match(parent, /合并成功后由面板在你的目录里自动跑/)
  assert.match(parent, /你自己改代码时没人替你跑/)
  // 没勾的场合（工作流节点、共用目录的子对话）不出现这段
  assert.doesNotMatch(verifyBlock([self], { platform: 'win32', scaled: true }), /禁止子对话执行/)
  // 步骤行本身也带「由谁执行」，两边看到的说法一致
  assert.match(
    testStepsText([inParent], 'win32', '', 'child'),
    /由谁执行：父对话（合并后自动跑，结果回传给你；你不要跑）/,
  )
  assert.match(testStepsText([inParent], 'win32', '', 'parent'), /由谁执行：子对话合并后由面板在你的目录里自动跑/)
})

test('勾了「禁止子对话执行」只影响子对话：父对话自己验证时照常跑这些步骤', () => {
  const inParent = step([], { id: 'e2e', name: '端到端测试', command: 'npm run test:e2e', scope: 'parent' as const })
  const self = step([], { id: 'tc', name: '类型检查', command: 'npm run typecheck' })
  // 父对话侧取「全部启用的步骤」（只按 enabled 筛；appliesTo 是写在提示词里由 Agent 按改动清单自己判断），
  // 不读 parentRunSteps：勾了这项只是禁止子对话跑，父对话自己改代码验证时不能因此漏掉这一步
  for (const scaled of [true, false]) {
    const parent = verifyBlock([inParent, self], { platform: 'win32', scaled, parentRun: 'parent' })
    assert.match(parent, /npm run test:e2e/, `父对话自己验证时要跑这一步（scaled=${scaled}）`)
    assert.match(parent, /npm run typecheck/, `没勾的步骤照常在（scaled=${scaled}）`)
    assert.doesNotMatch(parent, /你不要跑它们/, '父对话侧不能出现「你不要跑」这类子对话的说法')
  }
  // 停用的步骤两边都不跑
  const off = step([], { id: 'off', name: '已停用', command: 'npm run gone', scope: 'parent' as const, enabled: false })
  assert.doesNotMatch(
    verifyBlock([inParent, off], { platform: 'win32', scaled: true, parentRun: 'parent' }),
    /npm run gone/,
  )
  // 子对话侧才跳过：这是这个参数唯一的作用范围
  assert.match(verifyBlock([inParent, self], { platform: 'win32', scaled: true, parentRun: 'child' }), /你不要跑它们/)
})

test('后台命令能认出是哪条测试步骤：命令原文和按环境拼出来的整行都认', () => {
  const e2e = step([], {
    id: 'e2e',
    name: '端到端测试',
    command: 'npm run test:e2e',
    env: 'wsl',
    scope: 'parent' as const,
  })
  const tc = step([], { id: 'tc', name: '类型检查', command: 'npm run typecheck' })
  const steps = [e2e, tc]
  assert.equal(matchTestStep(steps, 'npm run typecheck', 'win32')?.id, 'tc')
  assert.equal(matchTestStep(steps, '  npm   run test:e2e ', 'win32')?.id, 'e2e', '空白差异不影响')
  assert.equal(
    matchTestStep(steps, 'wsl.exe -d Ubuntu-24.04 -- bash -lc "npm run test:e2e"', 'win32')?.id,
    'e2e',
    '按环境拼出来的整行也认',
  )
  assert.equal(matchTestStep(steps, 'git status', 'win32'), undefined, '不是测试步骤的命令不记耗时')
  assert.equal(matchTestStep([{ ...tc, enabled: false }], 'npm run typecheck', 'win32'), undefined)
})

test('耗时只留最后一次，tries 记跑了几次；自己跑的和父对话跑的分开记', () => {
  const base = { stepId: 'e2e', stepName: '端到端测试', durationMs: 1_000, ok: false, at: '1' }
  let runs: TaskTestRun[] = mergeTestRun([], { ...base, by: 'parent' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].tries, 1)
  // 失败后父对话重跑成功：覆盖成最后一次的耗时，tries 累加
  runs = mergeTestRun(runs, { ...base, durationMs: 2_500, ok: true, at: '2', by: 'parent' })
  assert.deepEqual(
    runs.map((r) => [r.ok, r.durationMs, r.tries]),
    [[true, 2_500, 2]],
    '重跑成功后总结里显示最后一次的耗时',
  )
  // 子对话自己也跑了同一条（例如它先自己试过）：执行方不同，各留一行
  runs = mergeTestRun(runs, { ...base, durationMs: 900, ok: true, at: '3', by: 'self' })
  assert.equal(runs.length, 2)
  // 两条不同的步骤：各一行
  runs = mergeTestRun(runs, { stepId: 'tc', stepName: '类型检查', durationMs: 400, ok: true, at: '4', by: 'self' })
  assert.equal(runs.length, 3)
})

test('耗时统计的文字：一行一步，带执行方、结果和耗时', () => {
  const runs: TaskTestRun[] = [
    { stepId: 'e2e', stepName: '端到端测试', by: 'parent', ok: true, durationMs: 94_000, tries: 1, at: '' },
    { stepId: 'tc', stepName: '类型检查', by: 'self', ok: false, durationMs: 1_200, tries: 2, at: '' },
  ]
  const text = testRunLines(runs).join('\n')
  assert.match(text, /- 端到端测试：父对话跑，通过，1m 34s/)
  assert.match(text, /- 类型检查：自己跑，失败，1\.2s（第 2 次，按最后一次算）/)
  // 收尾总结的要求本身：要写执行方和耗时，没有记录时不编数字
  assert.match(TEST_TIME_SUMMARY_RULE, /谁跑的（父对话 \/ 自己）/)
  assert.match(TEST_TIME_SUMMARY_RULE, /未记录/)
  assert.match(TEST_TIME_SUMMARY_RULE, /不要编数字/)
})

test('「禁止子对话执行」由谁跑：子对话要有独立分支，顶层对话自己改代码时自己跑', () => {
  const steps = [step([], { scope: 'parent' as const })]
  assert.equal(parentRunRoleOf({ child: true, isolated: true, git: true, steps }), 'child')
  assert.equal(parentRunRoleOf({ child: true, isolated: false, git: true, steps }), '', '共用目录的子对话没得合回')
  assert.equal(parentRunRoleOf({ child: false, isolated: false, git: true, steps }), 'parent')
  // 顶层对话自己开了独立分支也没有「合回后父对话跑」这一步：仍算 parent，提示词要求它自己跑
  assert.equal(parentRunRoleOf({ child: false, isolated: true, git: true, steps }), 'parent')
  assert.equal(parentRunRoleOf({ child: false, isolated: false, git: false, steps }), '', '非 Git 项目不生效')
  assert.equal(parentRunRoleOf({ child: false, isolated: false, git: true, steps: [step([])] }), '', '没勾这种步骤')
  // 父对话的提示词要说清自己改代码时没人替它跑（评审 R2）
  const text = verifyBlock(steps, { platform: 'win32', scaled: true, parentRun: 'parent' })
  assert.match(text, /你自己改代码时没人替你跑/)
})

test('scope 三档：always 不看 globs、changed 命中才跑、parent 一律算适用（父对话侧）', () => {
  const always = step(['**/*.cpp'], { scope: 'always' })
  const changed = step(['**/*.cpp'], { scope: 'changed' })
  const parent = step([], { scope: 'parent' })
  assert.equal(stepApplies(always, ['docs/a.md']), true, 'always 的步骤每次改动都跑，不按 glob 筛')
  assert.equal(stepApplies(changed, ['docs/a.md']), false)
  assert.equal(stepApplies(changed, ['src/a.cpp']), true)
  assert.equal(stepApplies(changed, []), true, '取不到改动清单时按总是执行')
  assert.equal(stepApplies(parent, ['docs/a.md']), true, 'parent 的步骤在父对话侧照常跑')
  assert.equal(stepApplies(step([], { scope: 'changed' }), ['docs/a.md']), true, 'changed 没写 globs 时按总是执行')
})

test('老数据的 runInParent 迁成 scope：勾了的转 parent，没勾的按原筛选语义还原', () => {
  const saved = ProjectInput.parse({
    name: '项目',
    path: '/tmp/p',
    testSteps: [
      // 勾了「禁止子对话执行」→ parent
      { id: 'a', name: '端到端测试', command: 'npm run test:e2e', runInParent: true },
      // 没勾、写了适用改动 → changed（原来就会按 glob 筛）
      { id: 'b', name: '编译', command: 'npm run build', runInParent: false, appliesTo: ['**/*.ts'] },
      // 没勾、命令是全量单测 → parent（子对话不再整个跑一遍）
      { id: 'c', name: '单元测试', command: 'npm run test:unit' },
      // 老默认步骤是「全量命令 + 适用改动」：全量命令优先判 parent，否则存量项目照旧每个子对话跑全量
      { id: 'c2', name: '单元测试', command: 'npm run test:unit', appliesTo: ['**/*.ts', '**/*.tsx'] },
      // 没勾、没写适用改动、普通命令 → always
      { id: 'd', name: '类型检查', command: 'npm run typecheck' },
      // 已经写了 scope 的不动
      { id: 'e', name: '格式检查', command: 'npx prettier --check .', scope: 'changed' },
    ],
  })
  const byId = Object.fromEntries(saved.testSteps.map((s) => [s.id, s]))
  assert.equal(byId.a.scope, 'parent')
  assert.equal(byId.b.scope, 'changed')
  assert.equal(byId.c.scope, 'parent')
  assert.equal(byId.c2.scope, 'parent', '全量命令 + 适用改动也判 parent（存量项目的全量步骤才会真的延后）')
  assert.equal(byId.d.scope, 'always')
  assert.equal(byId.e.scope, 'changed', '写了 scope 的老数据不重新推断')
  // 迁移后不保留旧字段：同一份数据里不能再有两套「谁来跑」的说法
  for (const s of saved.testSteps) assert.equal('runInParent' in s, false)
  // 旧字段不走迁移函数也照样能读（服务端可能直接解析旧步骤）：默认 always，不会漏跑
  assert.equal(
    ProjectInput.parse({ name: 'p', path: '/tmp/p', testSteps: [{ id: 'x', name: 'x', command: 'x' }] }).testSteps[0]
      .scope,
    'always',
  )
})

test('子对话提示词只跑增量：不跑全量、定位命中的部分、抖动单跑失败文件', () => {
  const steps = [
    step([], { id: 'tc', name: '类型检查', command: 'npm run typecheck', scope: 'always' }),
    step(['**/*.ts'], { id: 'unit', name: '单元测试', command: 'npm run test:unit', scope: 'changed' }),
    step([], { id: 'e2e', name: '端到端测试', command: 'npm run test:e2e', scope: 'parent' }),
  ]
  const child = verifyBlock(steps, { platform: 'win32', scaled: true, parentRun: 'child' })
  assert.match(child, /子对话只跑增量测试/)
  assert.match(child, /不要跑全量单测、不要跑全量界面检查、不要跑端到端测试/)
  assert.match(child, /node scripts\/changed-tests\.mjs/)
  assert.match(child, /增量命令覆盖命中的/, '全量步骤由增量命令替代，不能因为「范围是全量」一条都不跑')
  assert.match(child, /node scripts\/ui-check\.mjs 09-summary/, '分片示例用完整分片名')
  assert.doesNotMatch(child, /ui-check\.mjs 09[^\w-]/, '不能给只写 09 的示例：会多跑 09-hint / 09-plans')
  assert.match(child, /单跑失败的那个测试文件.*最多 3 次/)
  assert.match(child, /不要为了保险跑全量/)
  assert.match(child, /范围：总是跑/)
  assert.match(child, /范围：命中适用改动才跑/)
  assert.match(child, /范围：全量，合并后由父对话跑/)
  // 项目关掉「按改动大小决定验证范围」时：子对话仍然不能和增量规则打架（评审 R3）
  const childFull = verifyBlock(steps, { platform: 'win32', scaled: false, parentRun: 'child' })
  assert.match(childFull, /每次改动都把适用的步骤跑完/)
  assert.doesNotMatch(childFull, /每次改动都跑完整的测试步骤/)
  assert.match(childFull, /增量命令覆盖命中的/)
  // 父对话侧没有「只跑增量」这一段，但抖动怎么重跑照样要写
  const parent = verifyBlock(steps, { platform: 'win32', scaled: true, parentRun: 'parent' })
  assert.doesNotMatch(parent, /子对话只跑增量测试/)
  assert.match(parent, /单跑失败的那个测试文件.*最多 3 次/)
  // 没有父对话代跑时不能说「合并后由父对话跑」，否则 Agent 会把没人跑的步骤跳掉
  const shared = verifyBlock([steps[2]], { platform: 'win32', scaled: true })
  assert.match(shared, /全量（当前没有父对话代跑，你自己跑）/)
})
