import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { format, resolveConfig } from 'prettier'
import {
  BUG_ANALYSIS_TEXT,
  BUG_FULL_TEXT,
  BUG_REPORT_TEXT,
  BUG_SIMPLE_TEXT,
  debugSkillMd,
  HYPOTHESIS_KINDS_TEXT,
  LOG_SCOPE_TEXT,
} from './bug-method.ts'

/** 找 Bug 的方法只写一处（ADR 0046）：用户报的走完整流程，自己发现的走简易版 */

test('完整流程：八个阶段按顺序，时间线分现象和变更两条，归因要引入点和一致性检查，修法比较候选方案', () => {
  const heads = [
    '### 1. 立案',
    '### 2. 定位',
    '### 3. 时间线',
    '### 4. 归因',
    '### 5. 修复设计',
    '### 6. 分阶段交报告',
    '### 7. 修复与验证',
    '### 8. 防复发与归档',
  ]
  const at = heads.map((h) => BUG_FULL_TEXT.indexOf(h))
  assert.ok(
    at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])),
    `阶段缺了或顺序乱了：${at.join(',')}`,
  )
  assert.match(BUG_FULL_TEXT, /### 级别：按难度定要求/)
  assert.match(BUG_FULL_TEXT, /#### 变更时间线/)
  assert.match(BUG_FULL_TEXT, /git blame -w -C/)
  assert.match(BUG_FULL_TEXT, /p4 annotate -c -i/)
  assert.match(BUG_FULL_TEXT, /svn blame/)
  assert.match(BUG_FULL_TEXT, /P4 不 sync、不 revert，SVN 不 update，Git 不在用户的工作区里 checkout/)
  assert.match(BUG_FULL_TEXT, /责任类别：本次改动.*近期变更.*历史遗留.*外部依赖.*环境配置.*数据.*用户操作.*未确定/)
  assert.match(BUG_FULL_TEXT, /一致性检查：根因要能解释现象卡里的每一条/)
  // 用户要求：修改面最小、修复全面、最合适没有固定优先级，比较之后选最优
  assert.match(BUG_FULL_TEXT, /至少两个有实质区别的修法/)
  assert.match(BUG_FULL_TEXT, /满足底线的方案之间没有固定优先级/)
  assert.match(BUG_FULL_TEXT, /选 A 因为……；不选 B 因为……/)
  assert.ok(BUG_FULL_TEXT.includes(BUG_REPORT_TEXT))
  assert.match(BUG_REPORT_TEXT, /归因：根因（一两句）；引入点/)
})

test('简易版：不交报告、不用确认，省掉归因和方案对比，底线不省；用户报的 Bug 指到完整流程', () => {
  assert.match(BUG_SIMPLE_TEXT, /不交诊断报告、不用用户确认/)
  assert.match(BUG_SIMPLE_TEXT, /父对话派单写了 kind: "bug".*或者用户发了 \/bug，面板会另给完整流程/)
  assert.match(BUG_SIMPLE_TEXT, /证据链三环.*齐了才动手/)
  assert.match(BUG_SIMPLE_TEXT, /都不算修/)
  assert.match(BUG_SIMPLE_TEXT, /修了三次还不对，停下来/)
  assert.match(BUG_SIMPLE_TEXT, /临时日志修完删掉/)
  assert.doesNotMatch(BUG_SIMPLE_TEXT, /submit_diagnosis 交|git blame|候选方案/)
  assert.doesNotMatch(BUG_SIMPLE_TEXT, /git stash|checkout/, '不动用户的工作区')
})

test('分析角色：只读，前五个阶段，修复写成建议', () => {
  assert.match(BUG_ANALYSIS_TEXT, /你只读不改/)
  assert.match(BUG_ANALYSIS_TEXT, /变更时间线和版本归因/)
  assert.match(BUG_ANALYSIS_TEXT, /修复建议按「修复设计」写/)
  assert.doesNotMatch(BUG_ANALYSIS_TEXT, /submit_diagnosis/)
})

test('systematic-debugging 技能由方法生成，和方法一致（改了方法跑 node scripts/gen-debug-skill.mjs）', async () => {
  const file = 'skills/coding/systematic-debugging/SKILL.md'
  const config = await resolveConfig(file, { config: 'config/.prettierrc.json' })
  const want = await format(debugSkillMd(), { ...config, filepath: file })
  assert.equal(readFileSync(file, 'utf8'), want)
})

test('假设表按现象类型各给一份提醒：数据、状态、界面、环境、偶发（分析稿 B12）', () => {
  for (const kind of ['数据类', '状态类', '界面类', '环境类', '偶发类'])
    assert.ok(HYPOTHESIS_KINDS_TEXT.includes(kind), `缺 ${kind}`)
  for (const x of ['竞态', '重入', '订阅时机', '缓存', '编码', '权限', '时序', '外部依赖', '缺字段'])
    assert.ok(HYPOTHESIS_KINDS_TEXT.includes(x), `缺 ${x}`)
  // 完整流程的论证一步带着整张表，分析角色至少列出几类
  assert.ok(LOG_SCOPE_TEXT.includes(HYPOTHESIS_KINDS_TEXT))
  assert.ok(BUG_FULL_TEXT.includes(HYPOTHESIS_KINDS_TEXT))
  assert.match(BUG_ANALYSIS_TEXT, /状态类的竞态、顺序、重入/)
})
