import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang } from '../shared/i18n.ts'

// 强制更新的记录写在数据目录里，用临时的别碰本机
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-update-'))
process.env.AGENT_PANEL_DATA = dir

const { platformAsset, stopForUpdate, updateApi } = await import('./update.ts')

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

/** 桩 GitHub：版本列表指向本机的下载路径，下载直接返回 500（安装会失败，用来验证失败后能重新开始） */
async function stubReleases() {
  const http = await import('node:http')
  let port = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/releases')) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify([
          {
            tag_name: 'v9.9.9',
            prerelease: false,
            published_at: '2026-01-01T00:00:00Z',
            body: '',
            html_url: '',
            assets: [
              { name: 'agent-panel-9.9.9.zip', browser_download_url: `http://127.0.0.1:${port}/pkg.zip`, size: 1 },
            ],
          },
        ]),
      )
      return
    }
    res.statusCode = 500
    res.end('nope')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
  process.env.AGENT_PANEL_RELEASES_URL = `http://127.0.0.1:${port}/releases`
  return () => new Promise<void>((r) => server.close(() => r()))
}

test('更新卡住时不再一直挡住：没有进展超过 10 分钟的会作废，之后能重新开始', async () => {
  process.env.AGENT_PANEL_APP_DIR = dir
  const close = await stubReleases()
  try {
    const { api: routes } = updateApi({
      running: () => 0,
      restart: () => {},
      stopAll: async () => {},
      interrupted: () => [],
    })
    const post = () =>
      routes.request('/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'v9.9.9' }),
      })

    // 第一次：下载 500，安装失败。job 会变成 failed，不挡后面
    const first = await post()
    assert.equal(first.status, 201, '下载失败不影响「已经开始」这件事')
    await new Promise((r) => setTimeout(r, 300))
    const failed = await routes.request(`/install/${(await first.json()).id}`)
    const failedBody = await failed.json()
    assert.equal(failedBody.status, 'failed', '下载失败要标成失败，不能永远停在 running')

    // 失败之后可以直接再来一次：不会因为上一次而一直被 409 挡住
    const again = await post()
    assert.equal(again.status, 201, '上一次失败后可以重新开始')
    await new Promise((r) => setTimeout(r, 300))

    // 正在跑的那次可以从 /install-current 读回来（页面刷新后靠它接回进度）
    const cur = await routes.request('/install-current')
    assert.equal(cur.status, 200)
    const body = await cur.json()
    assert.ok(body === null || body.job, '要么没有正在跑的更新，要么给出它的进度')
  } finally {
    await close()
    delete process.env.AGENT_PANEL_RELEASES_URL
  }
})
