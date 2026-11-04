import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { trustMarkers } from './cli-trust-api.ts'

/** ADR 0050：项目里有 Pi 只在信任后才读的文件时提示；.agents/skills 往上找到仓库根目录为止 */
test('项目信任的提示：项目目录里的 .pi 配置、上级目录（到仓库根目录）里的 .agents/skills 都列出来', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trust-'))
  try {
    const repo = path.join(root, 'repo')
    const proj = path.join(repo, 'game')
    await mkdir(path.join(proj, '.pi', 'skills'), { recursive: true })
    await writeFile(path.join(proj, '.pi', 'settings.json'), '{}')
    await mkdir(path.join(repo, '.git'))
    await mkdir(path.join(repo, '.agents', 'skills'), { recursive: true })
    // 仓库根目录之外的不算：Pi 找到仓库根目录就停
    await mkdir(path.join(root, '.agents', 'skills'), { recursive: true })
    const r = await trustMarkers(proj)
    assert.deepEqual(r.pi, ['.pi/settings.json', '.pi/skills', path.join(repo, '.agents/skills')])
    assert.deepEqual(await trustMarkers(path.join(root, 'nope')), {}, '目录不在了就当没有')
    const empty = path.join(repo, 'empty')
    await mkdir(empty)
    assert.deepEqual((await trustMarkers(empty)).pi, [path.join(repo, '.agents/skills')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
