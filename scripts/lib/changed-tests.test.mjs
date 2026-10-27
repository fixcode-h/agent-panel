/**
 * 改动 → 增量测试的定位规则（scripts/lib/changed-tests.mjs、scripts/lib/import-graph.mjs）：
 * 反向依赖闭包、别名解析、高风险区强制全量、「映射不出来」要明确列出来、影响面过宽时建议全量。
 * 这些用例钉住的是子对话只跑受影响部分、不漏跑的口径。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  importsOf,
  moduleKey,
  parseImports,
  planChangedTests,
  planDirectTests,
  reportChangedTests,
  resolveSpec,
  shardsFor,
} from './changed-tests.mjs'
import { resolveImport } from './import-graph.mjs'

const covers = {
  '02-task': ['web/src/components/tasks/', 'web/src/lib/tasks.ts'],
  '09-summary': ['web/src/pages/SummaryPage.tsx'],
}

/** 按真实解析建 imports 表：用例同时钉住解析器和闭包 */
const parsed = (sources) =>
  Object.fromEntries(Object.entries(sources).map(([file, code]) => [file, parseImports(code)]))

test('同名测试优先：shared/foo.ts 只跑 shared/foo.test.ts', () => {
  const plan = planChangedTests({
    changed: ['shared/foo.ts'],
    testFiles: ['shared/foo.test.ts', 'server/a.test.ts'],
    covers,
  })
  assert.deepEqual(plan.tests, ['shared/foo.test.ts'])
  assert.deepEqual(plan.shards, [], '不是界面文件，不跑界面检查')
  assert.deepEqual(plan.unmapped, [])
  assert.equal(plan.full.tests.required, false)
  assert.equal(plan.commands.tests, 'node scripts/unit-tests.mjs --files shared/foo.test.ts')
  assert.equal(plan.commands.ui, '')
})

test('反向 import：测试 import 了它才跑，别名和相对路径都解析', () => {
  const sources = {
    'shared/schema.ts': '',
    'server/a.test.ts': "import { X } from '@shared/schema'\n",
    'server/b.test.ts': "import { Y } from '../shared/other.ts'\n",
    'server/c.test.ts': "const z = await import('../shared/schema.ts')\n",
  }
  const plan = planChangedTests({
    changed: ['shared/schema.ts'],
    testFiles: ['server/a.test.ts', 'server/b.test.ts', 'server/c.test.ts'],
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.deepEqual(plan.tests, ['server/a.test.ts', 'server/c.test.ts'], '静态 import 和动态 import 都认')
})

test('影响面闭包：间接依赖改动模块的测试也要跑，直接映射找不到它', () => {
  const sources = {
    'shared/base.ts': 'export const base = 1',
    'shared/mid.ts': "import { base } from './base'",
    'shared/top.ts': "import { mid } from './mid'",
    'spec/top.test.ts': "import { top } from '../shared/top'\nimport test from 'node:test'",
  }
  const imports = parsed(sources)
  const plan = planChangedTests({
    changed: ['shared/base.ts'],
    testFiles: ['spec/top.test.ts'],
    sourceFiles: Object.keys(sources),
    covers,
    imports,
  })
  assert.deepEqual(plan.tests, ['spec/top.test.ts'], '经过两层间接依赖也要算进影响面')
  assert.equal(plan.graph.closure, 4, '闭包 = base + mid + top + 测试')
  assert.equal(plan.graph.indirect, 3)
  const direct = planDirectTests({
    changed: ['shared/base.ts'],
    testFiles: ['spec/top.test.ts'],
    covers,
    imports,
  })
  assert.deepEqual(direct.tests, [], '直接映射只看同名和直接 import，找不到这条间接依赖')
})

test('没写扩展名和 @/ 别名的 import 也能解析成依赖边：界面文件间接依赖要到分片', () => {
  const sources = {
    'shared/schema.ts': '',
    'web/src/lib/tasks.ts': "import type { Task } from '@shared/schema'",
    'web/src/lib/tasks.test.ts': "import { list } from '@/lib/tasks'",
  }
  const plan = planChangedTests({
    changed: ['shared/schema.ts'],
    testFiles: ['web/src/lib/tasks.test.ts'],
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.deepEqual(plan.tests, ['web/src/lib/tasks.test.ts'])
  assert.deepEqual(plan.shards, ['02-task'], 'web/src/lib/tasks.ts 是分片覆盖的文件，间接受影响也要跑')
})

test('同名和反向都没命中才回退到同目录测试；一个都没有就明确列成映射不出来', () => {
  const plan = planChangedTests({
    changed: ['server/exec/foo.ts', 'server/exec/bar.ts'],
    testFiles: ['server/exec/foo.test.ts'],
    covers,
    imports: {},
  })
  // bar.ts 同目录只有一个测试，回退把它也带上（宁可多跑一个文件，不漏）；集合里已经有的不重复
  assert.deepEqual(plan.tests, ['server/exec/foo.test.ts'])
  const lonely = planChangedTests({ changed: ['shared/only.ts'], testFiles: ['server/x.test.ts'], covers })
  assert.deepEqual(lonely.tests, [])
  assert.equal(lonely.unmapped.length, 1)
  assert.match(lonely.unmapped[0].reason, /没有找到对应的单测文件/)
  assert.match(reportChangedTests(lonely), /映射不出来/)
  assert.match(reportChangedTests(lonely), /不要静默跳过/)
})

test('同目录回退：改了 server/exec/foo.ts，同目录的测试文件都要跑', () => {
  const plan = planChangedTests({
    changed: ['server/exec/foo.ts'],
    testFiles: ['server/exec/a.test.ts', 'server/exec/b.test.ts', 'other/c.test.ts'],
    covers,
  })
  assert.deepEqual(plan.tests, ['server/exec/a.test.ts', 'server/exec/b.test.ts'])
})

test('界面分片：目录前缀和精确文件都认，一个文件可以命中多个分片', () => {
  assert.deepEqual(shardsFor('web/src/components/tasks/TaskView.tsx', covers), ['02-task'])
  assert.deepEqual(shardsFor('web/src/pages/SummaryPage.tsx', covers), ['09-summary'])
  assert.deepEqual(shardsFor('web/src/lib/tasks.ts', covers), ['02-task'])
  assert.deepEqual(shardsFor('web/src/components/tasks/deep/X.tsx', covers), ['02-task'], '目录前缀按层级算')
  const plan = planChangedTests({
    changed: ['web/src/components/tasks/TaskView.tsx', 'web/src/pages/SummaryPage.tsx'],
    testFiles: [],
    covers,
  })
  assert.deepEqual(plan.shards, ['02-task', '09-summary'])
  // 按完整分片名筛选：只写 09 会同时跑 09-hint / 09-plans / 09-summary
  assert.equal(plan.commands.ui, 'npx vite build --mode demo && node scripts/ui-check.mjs 02-task 09-summary')
})

test('改动只命中界面时不算映射不出来；命中单测和分片时两样都跑', () => {
  const plan = planChangedTests({
    changed: ['web/src/lib/tasks.ts'],
    testFiles: ['web/src/lib/tasks.test.ts'],
    covers,
  })
  assert.deepEqual(plan.tests, ['web/src/lib/tasks.test.ts'])
  assert.deepEqual(plan.shards, ['02-task'])
  assert.deepEqual(plan.unmapped, [])
})

test('通用组件映射不出来：明确说跑全量界面检查', () => {
  const plan = planChangedTests({ changed: ['web/src/components/ui/button.tsx'], testFiles: [], covers })
  assert.deepEqual(plan.shards, [])
  assert.equal(plan.unmapped.length, 1)
  assert.match(plan.unmapped[0].reason, /跑全量的界面检查/)
  assert.match(reportChangedTests(plan), /web\/src\/components\/ui\/button\.tsx/)
})

test('文档和配置不算「映射不出来」，单独列出来', () => {
  const plan = planChangedTests({
    changed: ['docs/agent-test-steps.md', 'package-lock.json', 'web/public/logo.png'],
    testFiles: ['shared/foo.test.ts'],
    covers,
  })
  assert.deepEqual(plan.unmapped, [])
  assert.deepEqual(plan.ignored, ['docs/agent-test-steps.md', 'package-lock.json', 'web/public/logo.png'])
  assert.deepEqual(plan.tests, [])
  assert.equal(plan.full.tests.required, false)
  assert.match(reportChangedTests(plan), /没有匹配到增量测试/)
})

test('界面检查脚本自身：改哪个分片跑哪个，改 harness / 总入口跑全部分片', () => {
  const one = planChangedTests({ changed: ['scripts/ui/09-summary.mjs'], testFiles: [], covers })
  assert.deepEqual(one.shards, ['09-summary'])
  const all = planChangedTests({ changed: ['scripts/ui/harness.mjs'], testFiles: [], covers })
  assert.deepEqual(all.shards, ['02-task', '09-summary'])
  const runner = planChangedTests({ changed: ['scripts/ui-check.mjs'], testFiles: [], covers })
  assert.deepEqual(runner.shards, ['02-task', '09-summary'])
})

test('spec 解析：@shared / @ / 相对路径 / 包名，扩展名和 index 归一', () => {
  assert.equal(resolveSpec('@shared/schema.ts', 'x.test.ts'), 'shared/schema.ts')
  assert.equal(resolveSpec('@/lib/api', 'x.test.ts'), 'web/src/lib/api')
  assert.equal(resolveSpec('../shared/foo.ts', 'server/a.test.ts'), 'shared/foo.ts')
  assert.equal(resolveSpec('node:fs', 'a.test.ts'), '')
  assert.equal(resolveSpec('react', 'a.test.ts'), '')
  assert.equal(moduleKey('shared/foo.ts'), 'shared/foo')
  assert.equal(moduleKey('web/src/lib/api/index.ts'), 'web/src/lib/api')
  assert.deepEqual(importsOf("import a from './x.ts'\nconst b = require('./y')\n"), ['./x.ts', './y'])
  // 落到仓库文件：补扩展名、目录 index、css 这类不算依赖
  const files = new Set(['shared/task.ts', 'web/src/lib/api/index.ts'])
  assert.deepEqual(resolveImport('@shared/task', 'x.ts', files), { kind: 'file', file: 'shared/task.ts' })
  assert.deepEqual(resolveImport('@/lib/api', 'x.ts', files), { kind: 'file', file: 'web/src/lib/api/index.ts' })
  assert.deepEqual(resolveImport('./index.css', 'web/src/main.tsx', files), { kind: 'external' })
  assert.equal(resolveImport('@shared/gone', 'x.ts', files).kind, 'unresolved')
})

test('演示数据和提示词里的示例 import 不算依赖（否则会误报「解析不出来」并强制全量）', () => {
  const demo = `const demo = "import { Login } from './pages/Login'\\nimport x from 'y'"`
  assert.deepEqual(parseImports(demo).specs, [])
  // 真实的 import 仍然认：跨行的、副作用 import、export … from
  assert.deepEqual(
    parseImports(
      "import {\n  a,\n  b,\n} from './multi'\nimport './side-effect.ts'\nexport { c } from './re-export'\n",
    ).specs.sort(),
    ['./multi', './re-export', './side-effect.ts'],
  )
})

test('高风险区：执行链路 / CLI 解析 / 内置模板 / 数据 schema 直接建议全量 + e2e', () => {
  for (const file of [
    'shared/engine.ts',
    'shared/schema.ts',
    'server/exec/parsers.ts',
    'shared/clis/pi.json',
    'shared/builtin/agents.ts',
  ]) {
    const plan = planChangedTests({
      changed: [file],
      testFiles: ['shared/other.test.ts'],
      covers,
      imports: {},
    })
    assert.equal(plan.full.tests.required, true, `${file} 应该建议全量单测`)
    assert.equal(plan.e2e, true, `${file} 应该建议 e2e`)
    assert.match(reportChangedTests(plan), /高风险区/)
  }
  // json 这种不是源码的文件也算高风险，但仍然要列进「不涉及单测的改动」
  const jsonPlan = planChangedTests({ changed: ['shared/clis/pi.json'], testFiles: [], covers })
  assert.deepEqual(jsonPlan.ignored, ['shared/clis/pi.json'])
  assert.equal(jsonPlan.full.tests.required, true)
})

test('import 解析不出来时报「映射不出来」并建议全量：不许静默少跑', () => {
  const sources = {
    'server/thing.ts': "import { x } from './missing'",
    'server/thing.test.ts': "import { thing } from './thing'",
  }
  const plan = planChangedTests({
    changed: ['server/thing.ts'],
    testFiles: ['server/thing.test.ts'],
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.deepEqual(plan.tests, ['server/thing.test.ts'])
  assert.equal(plan.full.tests.required, true)
  assert.equal(plan.graph.unresolved, 1)
  assert.match(reportChangedTests(plan), /解析不出来/)
})

test('无关文件里的解析失败不影响结论：只有影响面里的解析失败才建议全量', () => {
  const sources = {
    'shared/foo.ts': 'export const foo = 1',
    'shared/foo.test.ts': "import { foo } from '@shared/foo'",
    'server/unrelated.ts': "import { x } from './gone'",
  }
  const plan = planChangedTests({
    changed: ['shared/foo.ts'],
    testFiles: ['shared/foo.test.ts'],
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.equal(plan.full.tests.required, false)
  assert.equal(plan.graph.unresolved, 1, '图里仍然记着这条，只是它不在影响面里')
})

test('影响面过宽时建议全量；总量太小（1 个测试）不看比例', () => {
  const sources = { 'shared/base.ts': '' }
  const testFiles = []
  for (let i = 0; i < 25; i++) {
    sources[`server/t${i}.ts`] = "import { base } from '@shared/base'"
    sources[`server/t${i}.test.ts`] = `import { t } from './t${i}'`
    testFiles.push(`server/t${i}.test.ts`)
  }
  const wide = planChangedTests({
    changed: ['shared/base.ts'],
    testFiles,
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.equal(wide.tests.length, 25)
  assert.equal(wide.full.tests.required, true)
  assert.match(reportChangedTests(wide), /接近全量/)

  const small = planChangedTests({
    changed: ['shared/base.ts'],
    testFiles: ['server/t0.test.ts'],
    sourceFiles: ['shared/base.ts', 'server/t0.ts', 'server/t0.test.ts'],
    covers,
    imports: parsed({
      'shared/base.ts': '',
      'server/t0.ts': "import '@shared/base'",
      'server/t0.test.ts': "import './t0'",
    }),
  })
  assert.equal(small.full.tests.required, false, '1/1 也是 100%，但不能因此建议全量')
})

test('新加的分片没登记进 covers：报「映射不出来」，不能当成不涉及测试静默跳过', () => {
  const plan = planChangedTests({ changed: ['scripts/ui/11-new.mjs'], testFiles: [], covers })
  assert.deepEqual(plan.shards, [])
  assert.equal(plan.unmapped.length, 1)
  assert.match(plan.unmapped[0].reason, /没有登记到 scripts\/ui\/covers\.mjs/)
  assert.deepEqual(plan.ignored, [], '不能进 ignored（那会被读成「这批改动不涉及测试」）')
})

test('通用组件有同名测试也照样提示界面检查要跑全量：单测覆盖不等于界面被分片覆盖', () => {
  const plan = planChangedTests({
    changed: ['web/src/components/ui/button.tsx'],
    testFiles: ['web/src/components/ui/button.test.ts'],
    covers,
  })
  assert.deepEqual(plan.tests, ['web/src/components/ui/button.test.ts'])
  assert.equal(plan.unmapped.length, 1, '单测命中了也要提示界面没有分片映射')
  assert.match(plan.unmapped[0].reason, /跑全量的界面检查/)
})

test('改动清单去重，空清单时不崩', () => {
  const plan = planChangedTests({ changed: ['shared/foo.ts', 'shared/foo.ts'], testFiles: ['shared/foo.test.ts'] })
  assert.deepEqual(plan.changed, ['shared/foo.ts'])
  const empty = planChangedTests({ changed: [], testFiles: [] })
  assert.deepEqual(empty.tests, [])
  assert.deepEqual(empty.unmapped, [])
  assert.equal(empty.full.tests.required, false)
  assert.match(reportChangedTests(empty), /改动清单为空/)
  assert.match(reportChangedTests(empty), /--since/)
})

test('目录外的源码（extension/、vite.config.ts）不参与单测，不因此强制全量', () => {
  const plan = planChangedTests({
    changed: ['extension/popup.js', 'vite.config.ts'],
    testFiles: ['shared/foo.test.ts'],
    sourceFiles: ['shared/foo.ts', 'shared/foo.test.ts'],
    covers,
    imports: {},
  })
  assert.deepEqual(plan.ignored, ['extension/popup.js', 'vite.config.ts'])
  assert.deepEqual(plan.tests, [])
  assert.equal(plan.full.tests.required, false, '目录外源码不会被当成「已删除」，不该触发全量')
  assert.match(reportChangedTests(plan), /不涉及测试的改动/)
})

test('改动清单为空时只提示一次，不再重复「没有匹配到增量测试」和「交给父对话全量」', () => {
  const text = reportChangedTests(planChangedTests({ changed: [], testFiles: [] }))
  assert.equal(text.match(/改动清单为空/g)?.length, 1)
  assert.doesNotMatch(text, /没有匹配到增量测试/)
  assert.doesNotMatch(text, /交给父对话合并后跑全量/)
})

test('报告里给出直接映射和影响面的对比（数量能看出多了什么）', () => {
  const sources = {
    'shared/base.ts': '',
    'shared/mid.ts': "import './base'",
    'spec/mid.test.ts': "import '../shared/mid'",
  }
  const plan = planChangedTests({
    changed: ['shared/base.ts'],
    testFiles: ['spec/mid.test.ts'],
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.equal(plan.direct.tests.length, 0)
  assert.equal(plan.tests.length, 1)
  const text = reportChangedTests(plan)
  assert.match(text, /直接映射 vs 影响面分析/)
  assert.match(text, /影响面分析（含间接依赖）：1 个单测文件/)
})

test('改动清单为空时提示可能已经提交、要带任务基线（test:affected 提交后跑不能静默通过）', () => {
  const empty = planChangedTests({ changed: [], testFiles: [] })
  assert.match(reportChangedTests(empty), /改动清单为空/)
  assert.match(reportChangedTests(empty), /--since/)
})

test('删除 / 改名文件时直接建议全量：依赖它的文件无法从 import 图反查', () => {
  const sources = {
    'shared/keep.ts': "import { gone } from './gone'",
    'spec/keep.test.ts': "import '../shared/keep'",
  }
  const plan = planChangedTests({
    changed: ['shared/gone.ts'],
    testFiles: ['spec/keep.test.ts'],
    // 已删除的文件不在扫描到的源文件里，图里没有它
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.equal(plan.full.tests.required, true)
  assert.match(reportChangedTests(plan), /已删除/)
  assert.equal(plan.commands.tests, 'npm run test:unit', '必须全量时给全量命令')
})

test('必须全量时给的是全量命令，不再给增量命令（照抄增量会漏跑）', () => {
  const sources = {
    'shared/engine.ts': '',
    'server/thing.ts': "import '@shared/engine'",
    'server/thing.test.ts': "import './thing'",
  }
  const plan = planChangedTests({
    changed: ['shared/engine.ts'],
    testFiles: ['server/thing.test.ts'],
    sourceFiles: Object.keys(sources),
    covers,
    imports: parsed(sources),
  })
  assert.equal(plan.full.tests.required, true)
  assert.deepEqual(plan.tests, ['server/thing.test.ts'])
  assert.equal(plan.commands.tests, 'npm run test:unit')
  assert.match(reportChangedTests(plan), /单测命令（必须全量）：/)
})

test('界面影响面过宽时给全量界面检查命令，不再按分片拼一长串', () => {
  const wideCovers = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, [`web/src/p${i}/`]]))
  const changed = Object.keys(wideCovers).map((_, i) => `web/src/p${i}/a.tsx`)
  const plan = planChangedTests({ changed, testFiles: [], covers: wideCovers })
  assert.equal(plan.full.ui.required, true)
  assert.equal(plan.commands.ui, 'npx vite build --mode demo && node scripts/ui-check.mjs')
  assert.match(reportChangedTests(plan), /界面检查命令（必须全量）：/)
})
