import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getCli } from '../shared/clis.ts'
import { listPackages } from './cli-packages.ts'

test('扩展包：读 CLI 配置文件里的列表，相对路径按配置文件所在目录换成绝对路径', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-pkg-'))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    const def = getCli('pi') as Parameters<typeof listPackages>[0]
    assert.deepEqual(await listPackages(def), [], '没有配置文件就是一个都没装')
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        packages: ['npm:@x/tools', '../local-pkg', { source: 'git:github.com/x/y@v1', autoload: false }, 3],
      }),
    )
    assert.deepEqual(await listPackages(def), [
      { source: 'npm:@x/tools', target: 'npm:@x/tools' },
      // pi remove 认的是解析后的路径，原样的相对路径从别的目录跑会找不到
      { source: '../local-pkg', target: path.resolve(dir, '../local-pkg') },
      { source: 'git:github.com/x/y@v1', target: 'git:github.com/x/y@v1' },
    ])
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
  }
})
