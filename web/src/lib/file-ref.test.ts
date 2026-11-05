/** 文件标记的图标种类和单击规则：面板能看的（图片、文字）在面板里看，其余交给系统默认程序 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clickAction, fileKind, nameParts, parentName, sizeText } from '@/lib/file-ref'

test('clickAction：图片看大图，md、cpp 这类文字在面板里看，xlsx、docx、pdf 交给系统，目录在文件夹里打开', () => {
  assert.equal(clickAction('a/截图.png'), 'image')
  for (const p of ['README.md', 'src/a.cpp', 'x.h', 'cfg.json', 'a.ts', 'logs/run.log'])
    assert.equal(clickAction(p), 'text', p)
  for (const p of ['C_FunctionalNPCInfo.xlsx', '需求.docx', 'a.pdf', 'b.zip', 'Map.umap', 'noext'])
    assert.equal(clickAction(p), 'system', p)
  assert.equal(clickAction('src/a.ts', true), 'system')
})

test('fileKind / nameParts / parentName / sizeText', () => {
  assert.equal(fileKind('a.xlsx'), 'sheet')
  assert.equal(fileKind('a.cpp'), 'code')
  assert.equal(fileKind('a.md'), 'text')
  assert.equal(fileKind('a.ini'), 'data')
  assert.equal(fileKind('src/'), 'folder')
  assert.equal(fileKind('LICENSE'), 'file')
  assert.deepEqual(nameParts('a/b/C_FunctionalNPCInfo.xlsx'), { stem: 'C_FunctionalNPCInfo', ext: '.xlsx' })
  assert.deepEqual(nameParts('.gitignore'), { stem: '.gitignore', ext: '' })
  assert.equal(parentName('client\\Config.ts'), 'client')
  assert.equal(parentName('Config.ts'), '')
  assert.equal(sizeText(184 * 1024), '184 KB')
  assert.equal(sizeText(512), '512 B')
})
