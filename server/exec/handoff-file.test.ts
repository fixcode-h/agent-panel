import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handoffName, saveHandoffFile } from './runner.ts'

test('交接文件：子任务 id 带「/」和 Windows 保留字符也存成一个文件，返回的路径读得到全文', async () => {
  assert.equal(handoffName('@chat/sub/h3'), '@chat_sub_h3')
  assert.equal(handoffName('a\\b:c*d?"e<f>g|h'), 'a_b_c_d_e_f_g_h')
  assert.equal(handoffName('../x'), 'x')
  const root = await mkdtemp(path.join(tmpdir(), 'handoff-'))
  try {
    const text = '验收结论：不通过\n' + 'R'.repeat(9000)
    const file = await saveHandoffFile('t1', { id: '@chat/sub/h3', title: '评审' }, text, root)
    assert.equal(path.dirname(file), path.join(root, 't1'))
    assert.equal(await readFile(file, 'utf8'), `# 评审\n\n${text}\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
