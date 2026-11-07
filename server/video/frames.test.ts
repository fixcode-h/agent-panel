/**
 * 视频截帧：手动截帧、自动截帧（三种方式）、清除、增强、标注、去重、帧差、记下的范围、给 Agent 的截帧工具，
 * 并确认原视频一个字节都没变。
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
  // 标注：存下框，再存浏览器画好的标注图；换底图（增强）后标注图作废、框还在
  const tools = await import('./frame-tools.ts')
  const box = { kind: 'rect' as const, x: 0.1, y: 0.1, w: 0.3, h: 0.3, color: '#ef4444' }
  s = await tools.setShapes(s.key, video, manual.id, [box, { kind: 'rect', x: 2 }])
  assert.deepEqual(s.frames.find((x) => x.id === manual.id)?.shapes, [box], '不合法的标注丢掉')
  const base = s.frames.find((x) => x.id === manual.id)!.enhanced!.file
  const png = readFileSync(base).toString('base64')
  await assert.rejects(tools.saveAnnotated(s.key, video, manual.id, '/elsewhere.png', png))
  s = await tools.saveAnnotated(s.key, video, manual.id, base, png)
  assert.equal(s.frames.find((x) => x.id === manual.id)?.annotated?.from, base)
  s = await f.enhanceFrames(s.key, video, [manual.id], 'ffmpeg-sharpen')
  assert.equal(s.frames.find((x) => x.id === manual.id)?.annotated, undefined, '换了底图，标注图作废')
  assert.equal(s.frames.find((x) => x.id === manual.id)?.shapes?.length, 1)
  // 去重：纯红的那几秒均匀截 3 张，和之前截到的纯红帧几乎一样，只留一张；手动帧不动
  s = await f.autoFrames(s.key, video, 'uniform', 3, undefined, { start: 6.5, end: 9.5 })
  const red = s.frames.filter((x) => x.source === 'auto' && x.time >= 6.5).length
  assert.ok(red >= 2)
  const dd = await tools.dedupeFrames(s.key, video)
  s = dd.session
  assert.ok(dd.removed >= red - 1)
  assert.equal(s.frames.filter((x) => x.source === 'auto' && x.time >= 6.2).length, 1, '纯红的只留一张')
  assert.ok(s.frames.some((x) => x.id === manual.id))
  // 帧差：第一张没有可比的；切到纯红之后那张整张都变了
  const sorted = [...s.frames].sort((a, b) => a.time - b.time)
  assert.equal((await tools.frameDiff(s.key, video, sorted[0].id)).prev, null)
  const later = sorted.find((x) => x.time >= 6.5)!
  assert.deepEqual((await tools.frameDiff(s.key, video, later.id)).boxes, [{ x: 0, y: 0, w: 1, h: 1 }])
  // 命名范围和设置：存下后重新打开还在，不合法的范围丢掉
  s = await tools.saveMeta(s.key, video, {
    ranges: [
      { id: 'a', name: '第一次复现', start: 1, end: 3 },
      { id: 'b', start: 5, end: 4 },
    ],
    prefs: { mode: 'screen', count: 6, range: 'a' },
  })
  const re = await f.openVideo(video)
  assert.deepEqual(re.ranges, [{ id: 'a', name: '第一次复现', start: 1, end: 3 }])
  assert.equal(re.prefs.mode, 'screen')
  assert.equal(re.prefs.range, 'a')
  // 给 Agent 的截帧工具：截到这个对话自己的附件目录，超出时长的时间点不截
  const { callVideoTool } = await import('./agent-frames.ts')
  const r = await callVideoTool('task-video', { path: video, times: [1, 7, 99] })
  assert.ok(!('isError' in r), r.content[0].text)
  const files = r.content[0].text.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(files.length, 2)
  assert.ok(files.every((l) => l.includes(path.join('task-video'))))
  assert.ok((await callVideoTool('task-video', { path: 'relative.mp4' })).isError)
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
