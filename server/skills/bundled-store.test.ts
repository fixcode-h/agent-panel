/**
 * 自带技能装在面板数据目录（ADR 0083）：安装、补齐、没人改过的副本自动跟上新版、从 ~/.agents/skills 一次性搬过来。
 * 数据目录和用户目录都换成临时的：store.ts 在模块顶层就算数据目录，要在 import 之前设好
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'bundled-store-'))
process.env.AGENT_PANEL_DATA = path.join(home, 'data')
process.env.HOME = home
process.env.USERPROFILE = home

const { bundledStore, ensureBundled, entries, installBundled, legacySharedRoot, listBundled } =
  await import('../bundled-skills.ts')
const { recordInstalled, resetInstalledRecordCache, treeHash } = await import('./installed-record.ts')
const { moveFromLegacyRoot } = await import('./store-move.ts')
const { dataPath } = await import('../store.ts')

const skillDirs = readdirSync(path.resolve(import.meta.dirname, '../../skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(path.resolve(import.meta.dirname, '../../skills', d.name)))
const tree = (dir: string): [string, Buffer][] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = path.join(e.parentPath, e.name)
      return [path.relative(dir, full).split(path.sep).join('/'), readFileSync(full)]
    })

test('从 ~/.agents/skills 搬到数据目录：没改过的搬走、改过的复制一份也留着原样，只搬一次', async () => {
  const all = await entries()
  const legacy = legacySharedRoot()
  const put = (name: string, text?: string) => {
    const e = all.find((x) => x.name === name)!
    for (const [rel, buf] of e.files) {
      mkdirSync(path.dirname(path.join(legacy, name, rel)), { recursive: true })
      writeFileSync(path.join(legacy, name, rel), rel === 'SKILL.md' && text ? text : buf)
    }
  }
  put('openspec')
  put('brainstorming', '用户改过的')
  await moveFromLegacyRoot(all)
  assert.ok(existsSync(path.join(bundledStore(), 'openspec/SKILL.md')))
  assert.ok(!existsSync(path.join(legacy, 'openspec')), '没改过的从用户目录删掉（Codex 这些就不会启动时全读进去）')
  assert.equal(readFileSync(path.join(bundledStore(), 'brainstorming/SKILL.md'), 'utf8'), '用户改过的')
  assert.equal(readFileSync(path.join(legacy, 'brainstorming/SKILL.md'), 'utf8'), '用户改过的', '用户的内容原样留着')
  assert.ok(existsSync(dataPath('config/bundled-skills-moved.json')))
  // 做过一次就不再看：之后放进去的不搬
  put('grilling')
  await moveFromLegacyRoot(all)
  assert.ok(existsSync(path.join(legacy, 'grilling/SKILL.md')))
})

test('自带 Skill：统一装到数据目录，已有的不覆盖，执行前自动补齐缺的', async () => {
  const list = await listBundled()
  assert.equal(list.length, skillDirs.length)
  const one = list.find((s) => s.name === 'task-records')!
  assert.equal(one.status.shared, 'missing')
  assert.ok(one.files >= 4, '带上了模板')
  // 详情页要能列出它带哪些文件：树里不含 SKILL.md，目录排在文件前，files 和树里的文件数一致
  assert.ok(one.tree, '自带 Skill 要带文件树')
  assert.equal(
    one.tree.entries.some((x) => x.path.toLowerCase() === 'skill.md'),
    false,
  )
  assert.equal(one.tree.entries.filter((x) => x.type === 'file').length, one.files)
  const at = (p: string) => one.tree!.entries.findIndex((x) => x.path === p)
  assert.ok(at('templates') < at('templates/design.md'))

  const r = await installBundled(['task-records'], [], false)
  assert.deepEqual(r.done, ['task-records'])
  const dir = path.join(bundledStore(), 'task-records')
  assert.ok(existsSync(path.join(dir, 'templates/design.md')))
  assert.ok(!existsSync(path.join(home, '.agents/skills/task-records')), '不再装进 ~/.agents/skills')
  assert.equal((await listBundled()).find((s) => s.name === 'task-records')!.status.shared, 'same')

  // 用户改过的：不覆盖，状态是「不同」；明确覆盖时换回自带的
  writeFileSync(path.join(dir, 'SKILL.md'), '改过')
  assert.equal((await listBundled()).find((s) => s.name === 'task-records')!.status.shared, 'changed')
  assert.deepEqual((await installBundled(['task-records'], [], false)).skipped, ['task-records'])
  await installBundled(['task-records'], [], true)
  assert.notEqual(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '改过')

  // 执行前补齐：只装缺的、只装自带的，用户改过的不动
  writeFileSync(path.join(dir, 'SKILL.md'), '用户的')
  const added = await ensureBundled(['task-records', 'project-vcs', '不存在的'])
  assert.deepEqual(added, ['project-vcs'])
  assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '用户的')
})

test('自带 Skill：面板装进去后没人改过的副本自动跟上新版（含登记过的发布版），用户改过的不动', async () => {
  resetInstalledRecordCache()
  await installBundled(['project-testing', 'coding-standards'], [], false)
  const root = bundledStore()
  const g = path.join(root, 'project-testing', 'SKILL.md')
  const fresh = readFileSync(g, 'utf8')
  // 模拟面板当初装的是旧版：副本是旧内容，记录也是那份的指纹
  writeFileSync(g, '旧版')
  await recordInstalled('project-testing', treeHash(tree(path.join(root, 'project-testing'))))
  const cs = path.join(root, 'coding-standards', 'SKILL.md')
  writeFileSync(cs, '用户改的')
  await ensureBundled([])
  assert.equal(readFileSync(g, 'utf8'), fresh, '没人改过的旧版换成新版')
  assert.equal(readFileSync(cs, 'utf8'), '用户改的', '用户改过的不动')
})
