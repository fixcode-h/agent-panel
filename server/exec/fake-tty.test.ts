import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { getCli } from '../../shared/clis.ts'
import { withFakeTty } from './process.ts'

/** 用户 2026-11-04 报：Command Code 在面板里登录直接报 Ink 的 raw mode 不支持，浏览器也不打开 */
test('登录要终端的 CLI：管道 stdin 也被当成终端、raw mode 能调、输出不按 80 列折行；用户自己的 NODE_OPTIONS 保留', () => {
  const env = withFakeTty({ ...process.env, NODE_OPTIONS: '--no-warnings' })
  assert.match(env.NODE_OPTIONS ?? '', /^--no-warnings --import=data:/)
  assert.ok(!/\s/.test((env.NODE_OPTIONS ?? '').split('--import=')[1]), 'data: 地址里不能有空格')
  const r = spawnSync(
    process.execPath,
    ['-e', 'process.stdin.setRawMode(true);console.log(process.stdin.isTTY,process.stdout.columns)'],
    { env, input: '', encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'true 1000')
  assert.equal(getCli('commandcode')!.auth?.loginTty, true)
})
