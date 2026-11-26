import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gitRun } from '../exec/git.ts'
import { jobChanges, jobChangesText, jobSnapshot } from './changes.ts'

test('后台命令跑的期间把共享文件写空：记下改了哪个文件，推回的那段带大量删除告警', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bg-changes-'))
  await gitRun(root, ['init', '-q'])
  await gitRun(root, ['config', 'user.email', 'a@b.c'])
  await gitRun(root, ['config', 'user.name', 't'])
  await writeFile(path.join(root, 'big.lua'), Array.from({ length: 800 }, (_, i) => `x${i}`).join('\n'))
  await gitRun(root, ['add', '.'])
  await gitRun(root, ['commit', '-qm', 'init'])
  const before = await jobSnapshot(root)
  await writeFile(path.join(root, 'big.lua'), 'x0\n')
  const r = await jobChanges(root, before)
  assert.equal(r.changed, true)
  assert.equal(r.changes?.[0].file, 'big.lua')
  assert.match(
    jobChangesText(r.changes),
    /跑的期间工作目录里改了：big\.lua（\+\d+ −\d+）\n【注意】big\.lua 一次删掉了大量内容/,
  )
  // 没动过：不算改过、不写这一段
  const same = await jobChanges(root, await jobSnapshot(root))
  assert.deepEqual(same, { changed: false })
  assert.equal(jobChangesText(undefined), '')
})
