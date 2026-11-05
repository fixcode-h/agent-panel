import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readConfigSettings, writeConfigSetting } from './cli-config-settings.ts'

/** ADR 0050：设置页直接改 Pi 的 settings.json：只动这一个键，恢复默认删掉；文件坏了不写 */
test('Pi 自己的设置：改一项只动这个键，恢复默认删掉；文件读不出来时不写、照实报', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-cfg-'))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const file = path.join(dir, 'settings.json')
  try {
    assert.deepEqual(await readConfigSettings('pi'), { values: {}, error: '' }, '没有文件就是都跟随')
    await writeFile(file, JSON.stringify({ packages: ['npm:x'], retry: { baseDelayMs: 1000 } }))
    await writeConfigSetting('pi', 'retryMax', 6)
    await writeConfigSetting('pi', 'idleTimeout', 600)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved, {
      packages: ['npm:x'],
      retry: { baseDelayMs: 1000, maxRetries: 6 },
      httpIdleTimeoutMs: 600_000,
    })
    assert.deepEqual((await readConfigSettings('pi')).values, { retryMax: 6, idleTimeout: 600 })
    await writeConfigSetting('pi', 'idleTimeout', null)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).httpIdleTimeoutMs, undefined)
    await assert.rejects(writeConfigSetting('pi', 'retryMax', 99), /10/)
    await writeFile(file, '{ broken')
    assert.match((await readConfigSettings('pi')).error, /settings\.json/)
    await assert.rejects(writeConfigSetting('pi', 'retryMax', 2))
    assert.equal(await readFile(file, 'utf8'), '{ broken', '坏文件原样不动')
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
    await rm(dir, { recursive: true, force: true })
  }
})
