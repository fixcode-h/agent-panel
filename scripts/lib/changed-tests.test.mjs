/**
 * 改动 → 增量测试的定位规则（scripts/lib/changed-tests.mjs）：
 * 同名测试、反向 import、同目录回退、界面检查分片，以及「映射不出来」要明确列出来。
 * 这些用例钉住的是子对话只跑命中部分、不漏跑的口径。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { importsOf, moduleKey, planChangedTests, reportChangedTests, resolveSpec, shardsFor } from './changed-tests.mjs'

const covers = {
  '02-task': ['web/src/components/tasks/', 'web/src/lib/tasks.ts'],
  '09-summary': ['web/src/pages/SummaryPage.tsx'],
}

test('同名测试优先：shared/foo.ts 只跑 shared/foo.test.ts', () => {
  const plan = planChangedTests({
    changed: ['shared/foo.ts'],
    testFiles: ['shared/foo.test.ts', 'server/a.test.ts'],
    covers,
  })
  assert.deepEqual(plan.tests, ['shared/foo.test.ts'])
  assert.deepEqual(plan.shards, [], '不是界面文件，不跑界面检查')
  assert.deepEqual(plan.unmapped, [])
  assert.equal(plan.commands.tests, 'npx tsx --test shared/foo.test.ts')
  assert.equal(plan.commands.ui, '')
})

test('反向 import：测试 import 了它才跑，别名和相对路径都解析', () => {
  const plan = planChangedTests({
    changed: ['shared/schema.ts'],
    testFiles: ['server/a.test.ts', 'server/b.test.ts', 'server/c.test.ts'],
    covers,
    readFile: (f) =>
      ({
        'server/a.test.ts': "import { X } from '@shared/schema'\n",
        'server/b.test.ts': "import { Y } from '../shared/other.ts'\n",
        'server/c.test.ts': "const z = await import('../shared/schema.ts')\n",
      })[f] ?? '',
  })
  assert.deepEqual(plan.tests, ['server/a.test.ts', 'server/c.test.ts'], '静态 import 和动态 import 都认')
})

test('同名和反向都没命中才回退到同目录测试；一个都没有就明确列成映射不出来', () => {
  const plan = planChangedTests({
    changed: ['server/exec/foo.ts', 'server/exec/bar.ts'],
    testFiles: ['server/exec/foo.test.ts'],
    covers,
    readFile: () => '',
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

test('spec 解析：@shared / @ / 相对路径 / 包名', () => {
  assert.equal(resolveSpec('@shared/schema.ts', 'x.test.ts'), 'shared/schema.ts')
  assert.equal(resolveSpec('@/lib/api', 'x.test.ts'), 'web/src/lib/api')
  assert.equal(resolveSpec('../shared/foo.ts', 'server/a.test.ts'), 'shared/foo.ts')
  assert.equal(resolveSpec('node:fs', 'a.test.ts'), '')
  assert.equal(resolveSpec('react', 'a.test.ts'), '')
  // 扩展名和 index 归一到同一个键
  assert.equal(moduleKey('shared/foo.ts'), 'shared/foo')
  assert.equal(moduleKey('web/src/lib/api/index.ts'), 'web/src/lib/api')
  assert.deepEqual(importsOf("import a from './x.ts'\nconst b = require('./y')\n"), ['./x.ts', './y'])
})

test('改动清单去重，空清单时不崩', () => {
  const plan = planChangedTests({ changed: ['shared/foo.ts', 'shared/foo.ts'], testFiles: ['shared/foo.test.ts'] })
  assert.deepEqual(plan.changed, ['shared/foo.ts'])
  const empty = planChangedTests({ changed: [], testFiles: [] })
  assert.deepEqual(empty.tests, [])
  assert.deepEqual(empty.unmapped, [])
  assert.match(reportChangedTests(empty), /交给父对话合并后跑全量/)
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
