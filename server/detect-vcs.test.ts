import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectVcs } from './projects-analyze.ts'

test('P4 工作区：p4config.txt 这类配置文件认得出，没有文件时问 p4 where；不在映射里的仍是没有版本控制', async (t) => {
  if (process.platform === 'win32') return t.skip('假 p4 用 sh 脚本')
  const root = mkdtempSync(path.join(tmpdir(), 'ap-vcs-'))
  const bin = path.join(root, 'bin')
  const ws = path.join(root, 'ws')
  const other = path.join(root, 'other')
  mkdirSync(bin)
  mkdirSync(ws)
  mkdirSync(other)
  // 假 p4：只有工作区目录在 client 映射里；不在映射里时像真的 p4 一样退出 0、只在 stderr 说
  writeFileSync(
    path.join(bin, 'p4'),
    `#!/bin/sh\ncase "$3" in\n  ${ws}/*) echo "... depotFile //d/..."; echo "... path ${ws}/..." ;;\n  *) echo "$3 - file(s) not in client view." >&2 ;;\nesac\n`,
  )
  chmodSync(path.join(bin, 'p4'), 0o755)
  const PATH = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${PATH}`
  try {
    assert.equal((await detectVcs(ws)).vcs, 'p4')
    assert.equal((await detectVcs(other)).vcs, 'none')
    // 工作区根上有 p4config.txt（P4CONFIG 设在 p4 set 里，进程环境变量读不到）：按文件就认得出，子目录也算
    const named = path.join(root, 'named', 'Source')
    mkdirSync(named, { recursive: true })
    writeFileSync(path.join(root, 'named', 'p4config.txt'), 'P4CLIENT=x\n')
    assert.deepEqual(await detectVcs(named), { vcs: 'p4', root: path.join(root, 'named') })
  } finally {
    process.env.PATH = PATH
    rmSync(root, { recursive: true, force: true })
  }
})
