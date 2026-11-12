import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang } from '../../shared/i18n.ts'

// 解压、替换都在临时目录里做，不碰本机的数据目录和程序目录
const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-local-pkg-'))
process.env.AGENT_PANEL_DATA = path.join(root, 'data')
after(() => rmSync(root, { recursive: true, force: true }))

const { inspectPackage, packageOs, osOf } = await import('./local.ts')
const { updateApi } = await import('../update.ts')
const { rawUploadAllowed } = await import('../http-guards.ts')
// 断言的是中文原文；依赖链里的 lang.ts 会按系统语言重设，import 之后再固定
setLang('zh')

/**
 * 按 scripts/package.mjs 的样子做一个安装包：顶层目录 agent-panel-<版本>[-平台]，
 * 里面有 server.mjs（能通过 --self-check）、dist/index.html、package.json
 */
function makePackage(
  version: string,
  opts: { suffix?: string; extra?: string[]; name?: string; zip?: boolean; server?: string } = {},
) {
  const work = mkdtempSync(path.join(root, 'pkg-'))
  const top = `agent-panel-${version}${opts.suffix ?? ''}`
  const dir = path.join(work, top)
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  writeFileSync(path.join(dir, 'dist', 'index.html'), `<p>${version}</p>`)
  writeFileSync(path.join(dir, 'server.mjs'), opts.server ?? 'process.exit(0)\n')
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: opts.name ?? 'agent-panel', version }))
  for (const f of opts.extra ?? []) {
    if (f.endsWith('.app')) mkdirSync(path.join(dir, f), { recursive: true })
    else writeFileSync(path.join(dir, f), '')
  }
  const file = path.join(work, opts.zip ? `${top}.zip` : `${top}.tar.gz`)
  if (opts.zip) execFileSync('zip', ['-qr', file, top], { cwd: work })
  else execFileSync('tar', ['-czf', file, top], { cwd: work })
  return file
}

const stage = () => path.join(mkdtempSync(path.join(root, 'stage-')), 'stage')

test('按包里的内容认出是哪个系统的包：顶层目录后缀、.app、托盘程序', () => {
  assert.equal(packageOs('agent-panel-1.2.3-mac', ['server.mjs']), 'mac')
  assert.equal(packageOs('agent-panel-1.2.3-linux', ['server.mjs', 'install-service.sh']), 'linux')
  assert.equal(packageOs('agent-panel-1.2.3', ['server.mjs', 'AgentPanel.exe', 'start.sh']), 'win')
  // 改过目录名也能靠 .app 认出 macOS 包
  assert.equal(packageOs('whatever', ['Agent 面板.app', 'install-service.sh']), 'mac')
  // 早期不分平台的通用包：认不出来，三个系统都能装
  assert.equal(packageOs('agent-panel-0.20.1', ['server.mjs', 'AgentPanel.exe', 'install-service.sh']), undefined)
  assert.equal(osOf('win32'), 'win')
  assert.equal(osOf('darwin'), 'mac')
  assert.equal(osOf('linux'), 'linux')
})

test('本机系统的包能通过检查，返回版本和程序文件目录', async () => {
  const pkg = await inspectPackage(
    makePackage('9.8.7', { suffix: '-linux', extra: ['install-service.sh'] }),
    stage(),
    'linux',
  )
  assert.equal(pkg.version, '9.8.7')
  assert.equal(pkg.os, 'linux')
  assert.ok(existsSync(path.join(pkg.src, 'server.mjs')))
})

test('别的系统的包不装，并说清该换哪个包', async () => {
  await assert.rejects(
    inspectPackage(makePackage('9.8.7', { suffix: '-mac', extra: ['Agent 面板.app'] }), stage(), 'linux'),
    /这是 macOS 的安装包，当前系统是 Linux，请改选 agent-panel-9\.8\.7-linux\.tar\.gz/,
  )
  await assert.rejects(
    inspectPackage(makePackage('9.8.7', { extra: ['AgentPanel.exe'], zip: true }), stage(), 'darwin'),
    /这是 Windows 的安装包，当前系统是 macOS/,
  )
})

test('不是压缩包、不是 Agent 面板的包、缺程序文件的都不装', async () => {
  const notArchive = path.join(root, 'notes.zip')
  writeFileSync(notArchive, 'hello')
  await assert.rejects(inspectPackage(notArchive, stage(), 'linux'), /只支持发布页上的 \.zip 和 \.tar\.gz 包/)
  await assert.rejects(
    inspectPackage(makePackage('1.0.0', { suffix: '-linux', name: 'other-app' }), stage(), 'linux'),
    /这不是 Agent 面板的安装包（包名是 other-app）/,
  )
  const work = mkdtempSync(path.join(root, 'bad-'))
  mkdirSync(path.join(work, 'agent-panel-1.0.0-linux'))
  writeFileSync(path.join(work, 'agent-panel-1.0.0-linux', 'package.json'), '{}')
  const bad = path.join(work, 'bad.tar.gz')
  execFileSync('tar', ['-czf', bad, 'agent-panel-1.0.0-linux'], { cwd: work })
  await assert.rejects(inspectPackage(bad, stage(), 'linux'), /包里缺少 server\.mjs 或 dist/)
})

test('安装包、插件包上传只放行这两个接口的 octet-stream，别的写操作照样必须是 JSON', () => {
  assert.equal(rawUploadAllowed('/api/app/local-package', 'application/octet-stream'), true)
  assert.equal(rawUploadAllowed('/api/plugins/install/zip', 'application/octet-stream'), true)
  assert.equal(rawUploadAllowed('/api/plugins/install/zip', 'application/zip'), false)
  assert.equal(rawUploadAllowed('/api/app/local-package', 'text/plain'), false)
  assert.equal(rawUploadAllowed('/api/app/install', 'application/octet-stream'), false)
})

/** 当前装着的程序目录：旧版本的程序文件，加上不能动的 data/ */
function makeAppDir() {
  const app = mkdtempSync(path.join(root, 'app-'))
  mkdirSync(path.join(app, 'dist'))
  writeFileSync(path.join(app, 'dist', 'index.html'), '<p>old</p>')
  writeFileSync(path.join(app, 'server.mjs'), 'process.exit(0)\n')
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'agent-panel', version: '1.0.0' }))
  mkdirSync(path.join(app, 'data'))
  writeFileSync(path.join(app, 'data', 'keep.json'), '{"keep":true}')
  return app
}

const upload = (routes: { request: (p: string, init?: RequestInit) => Response | Promise<Response> }, file: string) =>
  routes.request('/local-package', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(file),
  })

test('上传本地安装包：检查通过后确认安装，有任务时先等，替换程序文件、保留 data，然后重启', async () => {
  const app = makeAppDir()
  process.env.AGENT_PANEL_APP_DIR = app
  let running = 1
  let restarted = 0
  try {
    const { api: routes } = updateApi({
      running: () => running,
      restart: () => restarted++,
      stopAll: async () => {},
      interrupted: () => [],
    })
    const file = makePackage('9.9.1', {
      suffix: process.platform === 'darwin' ? '-mac' : process.platform === 'win32' ? '' : '-linux',
    })
    const res = await upload(routes, file)
    assert.equal(res.status, 200)
    const info: any = await res.json()
    assert.equal(info.version, '9.9.1')
    // 只是检查，还没动程序文件
    assert.equal(readFileSync(path.join(app, 'dist', 'index.html'), 'utf8'), '<p>old</p>')

    const started = await routes.request(`/local-package/${info.id}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(started.status, 201)
    const job: any = await started.json()
    assert.equal(job.tag, 'v9.9.1')

    // 有任务在执行：先等，不替换
    await new Promise((r) => setTimeout(r, 300))
    const waiting: any = await (await routes.request(`/install/${job.id}`)).json()
    assert.equal(waiting.waiting, true, '有任务在执行时要先等它们结束')
    assert.equal(readFileSync(path.join(app, 'dist', 'index.html'), 'utf8'), '<p>old</p>')

    // 任务结束后替换、自检、重启
    running = 0
    let done: any
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100))
      done = await (await routes.request(`/install/${job.id}`)).json()
      if (done.status !== 'running') break
    }
    assert.equal(done.status, 'done', done.error)
    assert.equal(readFileSync(path.join(app, 'dist', 'index.html'), 'utf8'), '<p>9.9.1</p>')
    assert.equal(readFileSync(path.join(app, 'data', 'keep.json'), 'utf8'), '{"keep":true}', 'data/ 不能动')
    await new Promise((r) => setTimeout(r, 1000))
    assert.equal(restarted, 1)

    // 装过的包不能再装第二次
    const again = await routes.request(`/local-package/${info.id}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(again.status, 404)
  } finally {
    delete process.env.AGENT_PANEL_APP_DIR
  }
})

test('上传的包检查不通过时直接报错，不开始更新', async () => {
  process.env.AGENT_PANEL_APP_DIR = makeAppDir()
  try {
    const { api: routes } = updateApi({
      running: () => 0,
      restart: () => {},
      stopAll: async () => {},
      interrupted: () => [],
    })
    const junk = path.join(root, 'junk.tar.gz')
    writeFileSync(junk, 'not a package')
    const res = await upload(routes, junk)
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as any).error, /不是 Agent 面板的安装包/)
    assert.equal(await (await routes.request('/install-current')).json(), null)
  } finally {
    delete process.env.AGENT_PANEL_APP_DIR
  }
})
