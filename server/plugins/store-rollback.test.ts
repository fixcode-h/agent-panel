/**
 * 升级留着上一版、退回上一版（插件框架改进 B4、B5）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = mkdtempSync(path.join(tmpdir(), 'plugin-rollback-'))
process.env.AGENT_PANEL_DATA = dataDir
const { listInstalled, PLUGINS_DIR, removePackage, rollbackPackage, writePackage } = await import('./store.ts')

const pkg = (version: string) => [
  { name: 'plugin.json', data: Buffer.from(JSON.stringify({ id: 'demo', name: 'Demo', version })) },
]
const source = { kind: 'zip' as const, ref: 'demo.zip' }
const find = async () => (await listInstalled()).ok.find((p) => p.manifest.id === 'demo')!

test.after(() => rmSync(dataDir, { recursive: true, force: true }))

test('新装没有上一版；覆盖安装记下从哪个版本升级来、留着旧版能退回', async () => {
  await writePackage('demo', pkg('1.0.0'), '', source)
  let p = await find()
  assert.equal(p.previousVersion, '')
  assert.equal(p.rollback, '')
  await writePackage('demo', pkg('1.1.0'), '', source)
  p = await find()
  assert.equal(p.manifest.version, '1.1.0')
  assert.equal(p.previousVersion, '1.0.0')
  assert.equal(p.rollback, '1.0.0')
})

test('退回上一版：两版对换，安装时间换新（模块地址变了才不会拿到缓存的新版本），还能再退回去', async () => {
  const before = (await find()).installedAt
  await new Promise((r) => setTimeout(r, 5))
  await rollbackPackage('demo')
  let p = await find()
  assert.equal(p.manifest.version, '1.0.0')
  assert.equal(p.rollback, '1.1.0')
  assert.notEqual(p.installedAt, before)
  await rollbackPackage('demo')
  p = await find()
  assert.equal(p.manifest.version, '1.1.0')
  assert.equal(JSON.parse(readFileSync(path.join(PLUGINS_DIR, 'demo', 'plugin.json'), 'utf8')).version, '1.1.0')
})

test('删除插件：上一版一起删，没有可退回的时候报错', async () => {
  await removePackage('demo')
  await assert.rejects(rollbackPackage('demo'), /没有可以退回的上一版/)
  assert.equal((await listInstalled()).ok.length, 0)
})
