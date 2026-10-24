/**
 * 测试步骤按改动范围筛选：判定只有一处（stepApplies），提示词和界面都读它。
 * 这里的用例钉住三件事：老步骤没有 appliesTo 时总是执行、合并进来的改动也算本次改动、
 * 提示词里写清了「先看改动再决定跑哪些」和「跳过要写理由」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHANGED_FILES_RULE,
  appliesToText,
  defaultTestSteps,
  matchesGlob,
  parseGlobs,
  stepApplies,
  testStepsBlock,
  verifyBlock,
} from './test-steps.ts'
import { type TestStep, ProjectInput } from './schema.ts'

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
  assert.ok(byId(node, 'node-typecheck').appliesTo.includes('**/*.tsx'))
  assert.equal(stepApplies(byId(node, 'node-typecheck'), ['docs/a.md']), false, '只改文档不跑类型检查')
  assert.equal(stepApplies(byId(node, 'node-build'), ['web/src/App.tsx']), true)
  assert.equal(stepApplies(byId(node, 'node-build'), ['docs/a.md']), false)
  // 纯 JS 项目（只有 .js / .jsx / .cjs）：改源码时单测、端到端、构建都要跑，不能被判成不适用
  for (const file of ['src/a.js', 'src/a.jsx', 'src/a.cjs'])
    for (const id of ['node-unit', 'node-build'])
      assert.equal(stepApplies(byId(node, id), [file]), true, `${id} 要覆盖 ${file}`)
  // lint 还管 prettier 检查的样式和文档（css / json / md / yml），实现要和注释一致
  for (const glob of ['**/*.css', '**/*.json', '**/*.md', '**/*.yml', '**/*.yaml'])
    assert.ok(byId(node, 'node-lint').appliesTo.includes(glob), `node-lint 要覆盖 ${glob}`)

  const rust = defaultTestSteps('rust', { windows: true })
  assert.deepEqual(byId(rust, 'rust-fmt').appliesTo, ['**/*.rs'], 'cargo fmt 只看 .rs')
  assert.ok(byId(rust, 'rust-test').appliesTo.includes('**/Cargo.toml'))
  assert.equal(stepApplies(byId(rust, 'rust-test'), ['README.md']), false)
  assert.equal(stepApplies(byId(rust, 'rust-test'), ['src/lib.rs']), true)
})
