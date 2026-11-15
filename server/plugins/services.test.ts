/**
 * 插件接口 11 的托管进程（services.ts）：分端口、等健康检查、写日志、起不来报原因、插件关掉时停。
 * 用一个真的 node 小服务。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { ServiceStatus } from '../../shared/api-contract/plugin-services.ts'
import { PluginManifest } from '../../shared/plugins/types.ts'

const dataDir = mkdtempSync(path.join(tmpdir(), 'plugin-services-'))
process.env.AGENT_PANEL_DATA = dataDir
setLang('zh')
const { serviceStatuses, startService, stopService, syncServices } = await import('./services.ts')

const pkgDir = path.join(dataDir, 'pkg')
mkdirSync(pkgDir, { recursive: true })
writeFileSync(
  path.join(pkgDir, 'server.js'),
  `require('http').createServer((q, s) => { s.end(process.env.GREETING + ' ' + process.argv[2]) })
     .listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening ' + process.env.PORT))`,
)
writeFileSync(path.join(pkgDir, 'crash.js'), `console.error('boom'); process.exit(3)`)

const manifest = PluginManifest.parse({
  id: 'web',
  name: 'Web',
  version: '1.0.0',
  api: 11,
  settings: [{ key: 'name', type: 'text', label: '名字', default: '' }],
  services: [
    { id: 'app', command: 'node', args: ['server.js', '{config.name}'], env: { GREETING: 'hi' }, startTimeoutSec: 20 },
    { id: 'bad', command: 'node', args: ['crash.js'], startTimeoutSec: 10 },
  ],
}) as never
const installed = {
  manifest,
  dir: pkgDir,
  source: { kind: 'dir', ref: pkgDir },
  installedAt: '',
  skills: [],
  previousVersion: '',
  rollback: '',
} as never

test.after(() => rmSync(dataDir, { recursive: true, force: true }))

test('托管进程：分端口、等健康检查、占位符换成参数、写日志；关掉插件时停', async () => {
  await syncServices([installed], () => ({ name: 'panel' }))
  assert.deepEqual(
    serviceStatuses('web').map((s) => s.state),
    ['stopped', 'stopped'],
  )
  const [a, b] = await Promise.all([startService('web', 'app'), startService('web', 'app')])
  assert.equal(a, b, '并发的两次等同一次启动')
  assert.equal(ServiceStatus.safeParse(a).success, true)
  assert.equal(a.state, 'running')
  assert.ok(a.port > 0)
  const text = await (await fetch(`http://127.0.0.1:${a.port}/`)).text()
  assert.equal(text, 'hi panel')
  assert.match(readFileSync(a.log, 'utf8'), /listening/)
  await syncServices([], () => ({}))
  assert.equal(serviceStatuses('web').length, 0)
  await new Promise((ok) => setTimeout(ok, 500))
  await assert.rejects(fetch(`http://127.0.0.1:${a.port}/`, { signal: AbortSignal.timeout(2000) }))
})

test('托管进程：起不来时报原因，不重试', async () => {
  await syncServices([installed], () => ({ name: '' }))
  const s = await startService('web', 'bad')
  assert.equal(s.state, 'failed')
  assert.match(s.error, /进程已经退出/)
  assert.equal(stopService('web', 'bad').state, 'stopped')
  await assert.rejects(startService('web', 'nope'), /没有托管进程/)
  await syncServices([], () => ({}))
})
