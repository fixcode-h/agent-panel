/**
 * 视频截帧：手动截帧、自动截帧（三种方式）、清除、增强，并确认原视频一个字节都没变。
 * 要本机有 ffmpeg（生成测试视频、截帧都用它）；没有时跳过。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-video-'))
process.env.AGENT_PANEL_DATA = path.join(dir, 'data')
const video = path.join(dir, '复现录屏.mp4')
const hash = () => createHash('sha1').update(readFileSync(video)).digest('hex')

test('视频截帧：手动帧一直保留，原视频不变', { skip: !hasFfmpeg && '本机没有 ffmpeg' }, async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 6 秒测试图案 + 4 秒纯红：中间有一次明显的画面切换
  const made = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=6:size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=320x180:duration=4:rate=25',
    '-filter_complex',
    '[0][1]concat=n=2:v=1[v]',
    '-map',
    '[v]',
    '-pix_fmt',
    'yuv420p',
    video,
  ])
  assert.equal(made.status, 0, made.stderr?.toString())
  const before = hash()
  const f = await import('./frames.ts')
  let s = await f.openVideo(video)
  assert.equal(Math.round(s.info.duration), 10)
  assert.equal(s.info.width, 320)
  s = await f.manualFrame(s.key, video, 2.5)
  assert.equal(s.frames.length, 1)
  const manual = s.frames[0]
  for (const mode of ['uniform', 'scene', 'screen'] as const) {
    s = await f.autoFrames(s.key, video, mode, 4)
    assert.ok(
      s.frames.some((x) => x.id === manual.id),
      `${mode} 之后手动帧还在`,
    )
    assert.ok(s.frames.filter((x) => x.source === 'auto').length >= 1, mode)
  }
  // 画面变化方式要在 6 秒的切换附近截到一帧
  s = await f.autoFrames(s.key, video, 'scene', 4)
  assert.ok(s.frames.some((x) => x.source === 'auto' && Math.abs(x.time - 6) < 1))
  // 只在 4~9 秒里截：新的自动帧都落在范围里，范围外原来的自动帧留着
  const outside = s.frames.filter((x) => x.source === 'auto' && (x.time < 4 || x.time > 9)).map((x) => x.id)
  s = await f.autoFrames(s.key, video, 'scene', 3, undefined, { start: 4, end: 9 })
  const inside = s.frames.filter((x) => x.source === 'auto' && x.time >= 4 && x.time <= 9)
  assert.ok(inside.length >= 1, '范围里截到了帧')
  assert.ok(
    inside.some((x) => Math.abs(x.time - 6) < 1),
    '范围里的画面切换（6 秒）截到了',
  )
  for (const id of outside)
    assert.ok(
      s.frames.some((x) => x.id === id),
      '范围外的自动帧还在',
    )
  s = await f.autoFrames(s.key, video, 'uniform', 2, undefined, { start: 4, end: 9 })
  s = await f.enhanceFrames(s.key, video, [manual.id], 'ffmpeg-sharpen')
  const enh = s.frames.find((x) => x.id === manual.id)?.enhanced
  assert.ok(enh?.file && enh.bytes > 0)
  s = await f.enhanceFrames(s.key, video, [manual.id], 'ffmpeg-denoise')
  const den = s.frames.find((x) => x.id === manual.id)?.enhanced
  assert.ok(den?.file && den.bytes > 0 && den.method === 'ffmpeg-denoise')
  s = await f.removeFrames(s.key, video, { which: 'auto' })
  assert.deepEqual(
    s.frames.map((x) => x.id),
    [manual.id],
  )
  // 重新打开还能读回手动帧
  s = await f.openVideo(video)
  assert.equal(s.frames[0]?.id, manual.id)
  assert.equal(hash(), before, '原视频不能被改动')
})
