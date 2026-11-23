import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectVcs } from './projects-analyze.ts'

test('P4 工作区：p4config.txt 这类配置文件认得出，p4 set 里的 P4CONFIG 名字也认；不跑 p4 where', async (t) => {
  if (process.platform === 'win32') return t.skip('假 p4 用 sh 脚本')
  const root = mkdtempSync(path.join(tmpdir(), 'ap-vcs-'))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'p4.log')
  mkdirSync(bin)
  // 假 p4：p4 set 报配置文件名叫 my.p4；记下每次调用，查有没有跑 where
  writeFileSync(
    path.join(bin, 'p4'),
    `#!/bin/sh\necho "$@" >> ${log}\nif [ "$1" = set ]; then echo "P4CONFIG=my.p4 (set)"; fi\n`,
  )
  chmodSync(path.join(bin, 'p4'), 0o755)
  const PATH = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${PATH}`
  try {
    const custom = path.join(root, 'custom', 'Game')
    mkdirSync(custom, { recursive: true })
    writeFileSync(path.join(root, 'custom', 'my.p4'), 'P4CLIENT=x\n')
    assert.deepEqual(await detectVcs(custom), { vcs: 'p4', root: path.join(root, 'custom') })
    // 工作区根上有 p4config.txt：按文件就认得出，子目录也算
    const named = path.join(root, 'named', 'Source')
    mkdirSync(named, { recursive: true })
    writeFileSync(path.join(root, 'named', 'p4config.txt'), 'P4CLIENT=x\n')
    assert.deepEqual(await detectVcs(named), { vcs: 'p4', root: path.join(root, 'named') })
    const other = path.join(root, 'other')
    mkdirSync(other)
    assert.equal((await detectVcs(other)).vcs, 'none')
    assert.doesNotMatch(readFileSync(log, 'utf8'), /where/, '不跑 p4 where')
  } finally {
    process.env.PATH = PATH
    rmSync(root, { recursive: true, force: true })
  }
})
