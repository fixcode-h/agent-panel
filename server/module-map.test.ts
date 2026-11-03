import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { goneModulesNote, moduleIndexText } from './module-map.ts'

test('协调器每轮看到的已有模块文档：从模块 README 的元数据现读，不改写 MODULE-MAP.md', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'module-index-'))
  try {
    assert.match(await moduleIndexText(root, []), /还没有模块文档：定位时看一、二级目录/)
    mkdirSync(path.join(root, 'docs/modules/calc'), { recursive: true })
    writeFileSync(
      path.join(root, 'docs/modules/calc/README.md'),
      '# calc：计算\n\n- 职责：加减乘除\n- 源码：`src/`\n- 关键词：计算器、add\n',
    )
    const text = await moduleIndexText(root, [])
    assert.match(text, /- calc｜加减乘除｜src\/｜计算器、add/)
    assert.match(text, /读 `docs\/modules\/<模块>\/README\.md`/)
    assert.equal(existsSync(path.join(root, 'docs/MODULE-MAP.md')), false, '不在用户的项目里写地图')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('合回后查模块的源码还在不在：全都不在了才提醒派「文档」清理', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'module-gone-'))
  try {
    mkdirSync(path.join(root, 'src/calc'), { recursive: true })
    for (const [m, src] of [
      ['calc', 'src/calc/'],
      ['old', 'src/old/'],
    ]) {
      mkdirSync(path.join(root, 'docs/modules', m), { recursive: true })
      writeFileSync(path.join(root, 'docs/modules', m, 'README.md'), `# ${m}：x\n\n- 源码：\`${src}\`\n`)
    }
    const note = await goneModulesNote(root, [])
    assert.match(note, /「old」（源码 src\/old\/）的源码已经不在了/)
    assert.doesNotMatch(note, /「calc」/)
    assert.match(note, /\{"task": "清理"\}/)
    rmSync(path.join(root, 'docs/modules/old'), { recursive: true })
    assert.equal(await goneModulesNote(root, []), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
