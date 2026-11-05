/**
 * 项目经验：检索排序、新会话提示、机械摘要和闸门。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ProjectExperience,
  experiencePrompt,
  findExperience,
  queryTerms,
  rankExperience,
  sameExperience,
} from './experience.ts'
import { digestOf, gateReason, landingCovered, relPath, type TraceTool } from './experience-gate.ts'

const exp = (o: Partial<ProjectExperience>) =>
  ProjectExperience.parse({ id: 'e1', kind: 'locate', title: '表格', keywords: ['表格'], createdAt: '', ...o })

test('中文查询切成两字一组，能命中关键词', () => {
  assert.ok(queryTerms('加一张掉落表').includes('掉落'))
  assert.deepEqual(queryTerms('a DataTable'), ['datatable'])
})

test('排序：关键词命中优先，停用的不算', () => {
  const list = [
    exp({ id: 'a', title: '掉落相关', keywords: ['奖励'], body: '掉落在这里' }),
    exp({ id: 'b', title: '表格在哪', keywords: ['掉落', '配表'] }),
    exp({ id: 'c', title: '掉落', keywords: ['掉落'], enabled: false }),
  ]
  assert.deepEqual(
    rankExperience(list, '加一张掉落表').map((e) => e.id),
    ['b', 'a'],
  )
})

test('findExperience 没有经验、没命中、空查询各有说法', () => {
  assert.match(findExperience([], 'x'), /还没有经验/)
  const list = [exp({ title: '表格在哪', keywords: ['配表'], paths: ['Source/Table/**'] })]
  assert.match(findExperience(list, '网络'), /没有相关的经验/)
  assert.match(findExperience(list, ''), /表格在哪〔配表〕/)
  assert.match(findExperience(list, '配表'), /位置：Source\/Table\/\*\*/)
  // 按要改的文件也能命中
  assert.match(findExperience(list, 'zz', ['Source/Table/Drop.cpp']), /### 表格在哪/)
})

test('新会话提示只说有几条；preHint 命中时附最多两条', () => {
  assert.equal(experiencePrompt([], '配表', true), '')
  const list = [exp({ title: '表格在哪', keywords: ['配表'], paths: ['Source/Table'] })]
  const plain = experiencePrompt(list, '配表', false)
  assert.match(plain, /有 1 条/)
  assert.doesNotMatch(plain, /可能相关/)
  assert.match(experiencePrompt(list, '改一下配表', true), /- 表格在哪：Source\/Table/)
})

test('同一件事：标题一样，或关键词和路径都有重合', () => {
  const a = exp({ title: '表格在哪', keywords: ['配表'], paths: ['Source/Table/**'] })
  assert.ok(sameExperience(a, { title: '表格 在哪', keywords: [], paths: [] }))
  assert.ok(sameExperience(a, { title: 'x', keywords: ['配表'], paths: ['Source/Table/Drop'] }))
  assert.ok(!sameExperience(a, { title: 'x', keywords: ['配表'], paths: ['Source/Net'] }))
})

test('relPath：Windows 盘符不分大小写', () => {
  assert.equal(relPath('C:\\Proj\\Source\\A.cpp', ['c:/proj']), 'Source/A.cpp')
  assert.equal(relPath('/w/p/a.ts', ['/w/p']), 'a.ts')
})

const tr = (kind: 'search' | 'read' | 'edit' | 'run', label: string, failed = false): TraceTool => ({
  tool: { kind, label, failed, name: '' },
  roots: ['/p'],
})

test('绕了很多路才进落点目录：闸门放行，已有经验覆盖时不再学', () => {
  const trace = [
    ...Array.from({ length: 6 }, (_, i) => tr('search', `table${i}`)),
    tr('read', '/p/Other/x.ts'),
    tr('read', '/p/Other/y.ts'),
    tr('read', '/p/Source/Game/Table/Drop.cpp'),
    tr('edit', '/p/Source/Game/Table/Drop.cpp'),
    tr('edit', '/p/Source/Game/Table/Drop.h'),
  ]
  const d = digestOf(trace)
  assert.deepEqual(d.landing, ['Source/Game/Table'])
  assert.equal(d.detour, 8)
  assert.match(gateReason(d, 'normal'), /Source\/Game\/Table/)
  assert.equal(gateReason(d, 'low'), '')
  assert.ok(landingCovered(d, ['Source/Game/**']))
  assert.ok(!landingCovered(d, ['Source/Net']))
})

test('命令失败几次后才成：算试错；搜索类命令不算', () => {
  const d = digestOf([
    tr('run', 'npm test', true),
    tr('run', 'npm test -- x', true),
    tr('run', 'npm test -- y'),
    tr('run', 'rg foo', true),
  ])
  assert.deepEqual(d.commands, [{ command: 'npm test -- y', failures: 2 }])
  assert.equal(d.searches.length, 1)
  assert.match(gateReason(d), /失败 2 次/)
})
