import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import type { TaskMessage } from '../../shared/schema.ts'
import { turnOutputCandidates } from '../../shared/turn-outputs/pick.ts'
import { gitSnapshot, spansNumstat } from '../exec/git.ts'
import { turnOutputs } from './outputs.ts'

setLang('zh')
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_INDEX_FILE

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

test('本轮产出：新建、修改分得开，删掉的、源代码不算，只看交上来的那几条消息', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-out-'))
  git(dir, 'init', '-q')
  mkdirSync(path.join(dir, 'docs'))
  writeFileSync(path.join(dir, 'docs/old.md'), '# old\n')
  writeFileSync(path.join(dir, 'gone.html'), '<p>x</p>\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  const from = await gitSnapshot(dir, [])
  writeFileSync(path.join(dir, 'docs/old.md'), '# old\nmore\n')
  writeFileSync(path.join(dir, 'demo.html'), '<title>示例</title>\n')
  writeFileSync(path.join(dir, 'a.ts'), 'export {}\n')
  rmSync(path.join(dir, 'gone.html'))
  const to = await gitSnapshot(dir, [])
  const spans = [{ from, to }]
  const msg = {
    id: 'm1',
    turnChanges: { spans, files: await spansNumstat(dir, spans) },
  } as TaskMessage
  const cand = turnOutputCandidates([msg])
  assert.deepEqual(cand.msgs, ['m1'])
  assert.deepEqual(cand.paths.sort(), ['demo.html', 'docs/old.md', 'gone.html'])
  const out = await turnOutputs(dir, [msg], cand.msgs, cand.paths)
  assert.deepEqual(out.map((f) => `${f.path}:${f.status}`).sort(), ['demo.html:added', 'docs/old.md:modified'])
  assert.ok(out.find((f) => f.path === 'demo.html')!.size > 0)
  // 没交上来的消息不算（上一轮的不累加）
  assert.deepEqual(await turnOutputs(dir, [msg], [], cand.paths), [])
})
