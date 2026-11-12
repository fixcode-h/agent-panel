import assert from 'node:assert/strict'
import test from 'node:test'
import { getCli } from '../clis.ts'
import { trustDirs, trustFor } from './trust.ts'
import { versionShortfalls } from './version.ts'
import { cliSettings } from '../settings.ts'
import { Settings } from '../schema.ts'

/** ADR 0050：Pi 在面板里（RPC 模式）不弹信任询问，默认跳过项目里的 .pi 配置；项目设置选了才带参数 */

const pi = getCli('pi')!
const base = { model: 'm', permission: 'full', extraArgs: [] }

test('项目信任：选了信任带 --approve、不信任带 --no-approve，跟随时两个都不带；没写 trust 的 CLI 不带', () => {
  const args = (trust?: 'approve' | 'deny') => pi.buildArgs({ ...base, trust })
  assert.ok(args('approve').includes('--approve'))
  assert.ok(!args('approve').includes('--no-approve'))
  assert.ok(args('deny').includes('--no-approve'))
  assert.ok(!args().some((a) => a === '--approve' || a === '--no-approve'))
  assert.equal(trustFor(pi, { cliTrust: { pi: 'approve' } }), 'approve')
  assert.equal(trustFor(pi, { cliTrust: {} }), undefined)
  assert.equal(trustFor(getCli('codex')!, { cliTrust: { codex: 'approve' } }), undefined, 'Codex 没写 trust')
})

test('标记文件往上找的目录：一层层到根目录为止，Windows 路径也认', () => {
  assert.deepEqual(trustDirs('/home/u/p/'), ['/home/u/p', '/home/u', '/home'])
  assert.deepEqual(trustDirs('C:\\work\\game'), ['C:\\work\\game', 'C:\\work', 'C:\\'])
})

test('设置里的两个开关：长时间缓存、关闭匿名统计默认都关，打开才加环境变量', () => {
  const env = (options: Record<string, boolean>) =>
    cliSettings(Settings.parse({ clis: { pi: { options } } }), 'pi').env.map((e) => `${e.key}=${e.value}`)
  assert.ok(!env({}).some((e) => e.startsWith('PI_CACHE_RETENTION') || e.startsWith('PI_TELEMETRY')))
  assert.ok(env({ cacheRetention: true, noTelemetry: true }).includes('PI_CACHE_RETENTION=long'))
  assert.ok(env({ cacheRetention: true, noTelemetry: true }).includes('PI_TELEMETRY=0'))
})

test('版本门槛：本机版本低于钩子要的版本时列出来，够了或读不出版本时不提示', () => {
  assert.deepEqual(
    versionShortfalls(pi, '1.4.2').map((n) => n.min),
    ['1.5.0'],
  )
  assert.deepEqual(versionShortfalls(pi, '1.5.0'), [])
  assert.deepEqual(versionShortfalls(pi, undefined), [])
})
