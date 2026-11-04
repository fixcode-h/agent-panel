import assert from 'node:assert/strict'
import test from 'node:test'
import { changelogPath, newerThan, parseChangelog } from './package-changelog.ts'

/** ADR 0050 第四期：插件的更新说明按 Pi 的约定读，设置页更新后只显示新版本的条目 */
test('更新说明：两种版本标题都认、标题前的不要；包指定的文件优先，写成空串就是不提供；更新后只要比原来新的', () => {
  const text = `# Changelog\n\n说明\n\n## [1.3.0] - 2026-11-01\n- 新功能 A\n\n## 1.2.1 - 2026-10-01\n- 修复 B\n\n## v1.2.0\n- 初版\n`
  const e = parseChangelog(text)
  assert.deepEqual(
    e.map((x) => x.version),
    ['1.3.0', '1.2.1', '1.2.0'],
  )
  assert.equal(e[0].body, '- 新功能 A')
  assert.deepEqual(
    newerThan(e, '1.2.1').map((x) => x.version),
    ['1.3.0'],
  )
  assert.equal(newerThan(e, undefined).length, 3)
  const spec = { manifestKey: 'pi', field: 'changelogPath', fallback: 'CHANGELOG.md' }
  assert.equal(changelogPath(spec, { pi: { changelogPath: './docs/CHANGES.md' } }), './docs/CHANGES.md')
  assert.equal(changelogPath(spec, { pi: { changelogPath: '' } }), null)
  assert.equal(changelogPath(spec, { name: 'x' }), 'CHANGELOG.md')
})
