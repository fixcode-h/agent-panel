import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang } from '../shared/i18n.ts'

// 强制更新的记录写在数据目录里，用临时的别碰本机
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-update-'))
process.env.AGENT_PANEL_DATA = dir

const { platformAsset, stopForUpdate } = await import('./update.ts')

// 断言的是中文原文，CI 的系统语言是英文。update.ts 的依赖链会引入 lang.ts，
// 它加载时按系统语言重新设置，所以要在 import 之后再固定
setLang('zh')

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

test('强制更新：停任务之前记下被打断的任务，重启后据此问要不要继续', async () => {
  const order: string[] = []
  const job = { phase: '' }
  await stopForUpdate(job, {
    interrupted: () => [
      { id: 'task-a', doing: '写文档' },
      { id: 'task-b', doing: '' },
    ],
    stopAll: async () => {
      // 记录要在停 CLI 之前就写进文件
      const file = path.join(dir, 'cache/interrupted-by-update.json')
      order.push(
        `${existsSync(file) ? '记录已写' : '没有记录'}：${JSON.parse(readFileSync(file, 'utf8')).tasks.length}`,
      )
    },
  })
  assert.equal(job.phase, '正在停止正在执行的任务…')
  assert.deepEqual(order, ['记录已写：2'])
  const saved = JSON.parse(readFileSync(path.join(dir, 'cache/interrupted-by-update.json'), 'utf8'))
  assert.deepEqual(
    saved.tasks.map((x: { id: string }) => x.id),
    ['task-a', 'task-b'],
  )
  assert.equal(saved.acknowledged, false)
})

test('强制更新：没有正在执行的任务时不留记录，也不把上次没处理的冲掉', async () => {
  await stopForUpdate({ phase: '' }, { interrupted: () => [], stopAll: async () => {} })
  const saved = JSON.parse(readFileSync(path.join(dir, 'cache/interrupted-by-update.json'), 'utf8'))
  assert.deepEqual(
    saved.tasks.map((x: { id: string }) => x.id),
    ['task-a', 'task-b'],
  )
})

test('没有可下载的包时返回空地址，不会把别的平台的包装上', () => {
  assert.equal(platformAsset([], 'linux').url, '')
  const onlyWin = [{ name: 'agent-panel-0.27.3.zip', browser_download_url: 'u/x.zip', size: 1 }]
  // 只有 Windows 的 zip：macOS 退到 zip，Linux 也退到 zip（都能解压），但不会拿到别的平台后缀的包
  assert.equal(platformAsset(onlyWin, 'linux').url, 'u/x.zip')
})
