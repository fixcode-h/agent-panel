import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getCli } from '../../shared/clis.ts'
import { packageChangelog, packageDir } from './dirs.ts'

/** ADR 0050 第四期：已装插件在本机哪、更新说明读哪个文件（包自己指定的优先、只认包目录里面的） */
test('插件目录和更新说明：npm、git、本机目录三种来源都找得到；包指定的文件优先，指到包外面的不读', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-pkgdir-'))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    const spec = getCli('pi')!.packages!
    const npm = { source: 'npm:@x/tools@1.0.0', target: 'npm:@x/tools@1.0.0' }
    assert.equal(packageDir(spec, npm), path.join(dir, 'npm', 'node_modules', '@x', 'tools'))
    assert.equal(
      packageDir(spec, { source: 'git:github.com/a/b@v1', target: 'git:github.com/a/b@v1' }),
      path.join(dir, 'git', 'github.com', 'a', 'b'),
    )
    assert.equal(packageDir(spec, { source: '../local', target: '/abs/local' }), '/abs/local')
    const root = packageDir(spec, npm)
    await mkdir(path.join(root, 'docs'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ pi: { changelogPath: './docs/CHANGES.md' } }))
    await writeFile(path.join(root, 'docs', 'CHANGES.md'), '# x\n## [2.0.0]\n- 新\n## [1.0.0]\n- 旧\n')
    assert.deepEqual(
      (await packageChangelog(spec, npm))?.map((e) => e.version),
      ['2.0.0', '1.0.0'],
    )
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ pi: { changelogPath: '../../../../secret.md' } }))
    assert.equal(await packageChangelog(spec, npm), null, '指到包外面的不读')
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
    await rm(dir, { recursive: true, force: true })
  }
})
