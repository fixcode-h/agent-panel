import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 登记文件在 DATA_DIR 下，必须在 import 之前指到临时目录
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'tracked-data-'))

const { stillOurs, trackedClis } = await import('./orphans.ts')
const { spawnTracked, stopTree } = await import('./tracked.ts')

test('外部进程：起来就登记（带 tag、来源），stopTree 结束并等它退出，退出后撤登记', async () => {
  const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: process.cwd(),
    source: 'ue',
    title: '测试编译',
    detached: process.platform !== 'win32',
  })
  const pid = child.pid!
  const e = trackedClis().find((x) => x.pid === pid)
  assert.equal(e?.extra?.source, 'ue')
  assert.equal(e?.extra?.tag, process.execPath)
  const exited = once(child, 'exit')
  assert.deepEqual(await stopTree(pid, { waitMs: 5000 }), { ok: true })
  await exited
  assert.equal(
    trackedClis().some((x) => x.pid === pid),
    false,
  )
  // 已经不在的进程：直接算成功
  assert.deepEqual(await stopTree(pid), { ok: true })
})

test('认进程：外部进程按 tag（不分大小写），CLI 照旧看面板痕迹', () => {
  const ext = { extra: { tag: 'C:\\UE\\Build.bat', source: 'ue', title: '' } }
  assert.equal(stillOurs(ext, 'cmd.exe /d /s /c ""c:\\ue\\build.bat" MyGame Win64"'), true)
  assert.equal(stillOurs(ext, 'notepad.exe'), false)
  assert.equal(stillOurs({}, 'node /x/cache/cli-run/abc/pi.js'), true)
  assert.equal(stillOurs({}, 'node build.js'), false)
})
