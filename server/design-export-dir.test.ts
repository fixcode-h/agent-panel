import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EXPORT_MARK, pickExportDir } from './design-export-dir.ts'

test('导出到项目目录：同名目录是别的设计导出的就另起一个，是自己的就复用并清旧贴图', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'export-dir-'))
  try {
    // 空的：直接用
    assert.deepEqual(await pickExportDir(base, 'WBP_Design', 'aaaaaaaa-1'), {
      dir: path.join(base, 'WBP_Design'),
      clean: false,
    })
    // 设计 A 导出过：A 再导出复用并清理；B 同名（中文标题都叫 WBP_Design）另起一个目录，不覆盖 A
    mkdirSync(path.join(base, 'WBP_Design'))
    writeFileSync(path.join(base, 'WBP_Design', EXPORT_MARK), JSON.stringify({ designId: 'aaaaaaaa-1' }))
    assert.deepEqual(await pickExportDir(base, 'WBP_Design', 'aaaaaaaa-1'), {
      dir: path.join(base, 'WBP_Design'),
      clean: true,
    })
    const b = await pickExportDir(base, 'WBP_Design', 'bbbbbbbb-2')
    assert.equal(b.dir, path.join(base, 'WBP_Design_bbbbbb'))
    // 没有标记但已经有东西（用户自己放的文件）：同样不覆盖
    mkdirSync(path.join(base, 'WBP_Hand'))
    writeFileSync(path.join(base, 'WBP_Hand', 'mine.txt'), 'x')
    assert.equal((await pickExportDir(base, 'WBP_Hand', 'cccccccc-3')).dir, path.join(base, 'WBP_Hand_cccccc'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
