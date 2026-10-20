import { test } from 'node:test'
import assert from 'node:assert/strict'
import { platformAsset } from './update.ts'

/** 三个平台各自的包，加上旧的通用包 */
const assets = (v: string) => [
  { name: `agent-panel-${v}.zip`, browser_download_url: `u/${v}.zip`, size: 10 },
  { name: `agent-panel-${v}-mac.tar.gz`, browser_download_url: `u/${v}-mac.tar.gz`, size: 20 },
  { name: `agent-panel-${v}-mac.zip`, browser_download_url: `u/${v}-mac.zip`, size: 21 },
  { name: `agent-panel-${v}-linux.tar.gz`, browser_download_url: `u/${v}-linux.tar.gz`, size: 30 },
  { name: 'SHA256SUMS', browser_download_url: `u/${v}.sums`, size: 1 },
]

test('按系统挑对应平台的包：不受列表顺序影响', () => {
  const v = '0.27.1'
  assert.deepEqual(platformAsset(assets(v), 'win32'), { url: `u/${v}.zip`, size: 10, zip: `agent-panel-${v}.zip` })
  assert.deepEqual(platformAsset(assets(v), 'darwin'), {
    url: `u/${v}-mac.tar.gz`,
    size: 20,
    zip: `agent-panel-${v}-mac.zip`,
  })
  assert.deepEqual(platformAsset(assets(v), 'linux'), {
    url: `u/${v}-linux.tar.gz`,
    size: 30,
    // Linux 没有自己的 zip，退到不通用的那个（这里就是通用包）
    zip: `agent-panel-${v}.zip`,
  })
})

test('平台包被放在列表前面时也挑对', () => {
  const v = '0.27.2'
  const shuffled = [...assets(v)].reverse()
  assert.equal(platformAsset(shuffled, 'linux').url, `u/${v}-linux.tar.gz`)
  assert.equal(platformAsset(shuffled, 'darwin').url, `u/${v}-mac.tar.gz`)
  assert.equal(platformAsset(shuffled, 'win32').url, `u/${v}.zip`)
})

test('旧版本只有一个通用包时，三个平台都用它', () => {
  const v = '0.24.100'
  const old = [
    { name: `agent-panel-${v}.zip`, browser_download_url: `u/${v}.zip`, size: 10 },
    { name: `agent-panel-${v}.tar.gz`, browser_download_url: `u/${v}.tar.gz`, size: 11 },
  ]
  assert.equal(platformAsset(old, 'win32').url, `u/${v}.zip`)
  assert.equal(platformAsset(old, 'darwin').url, `u/${v}.tar.gz`)
  assert.equal(platformAsset(old, 'linux').url, `u/${v}.tar.gz`)
})

test('没有可下载的包时返回空地址，不会把别的平台的包装上', () => {
  assert.equal(platformAsset([], 'linux').url, '')
  const onlyWin = [{ name: 'agent-panel-0.27.3.zip', browser_download_url: 'u/x.zip', size: 1 }]
  // 只有 Windows 的 zip：macOS 退到 zip，Linux 也退到 zip（都能解压），但不会拿到别的平台后缀的包
  assert.equal(platformAsset(onlyWin, 'linux').url, 'u/x.zip')
})
