/**
 * 视频截帧的纯逻辑：认视频、解析 FFmpeg 输出、自动截帧挑时间点、清晰度评分、手动帧保留、帧文件名。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ffmpegDownloadUrl,
  ffmpegVersion,
  frameName,
  isVideoFile,
  mergeAuto,
  parseComfyMethod,
  comfyMethod,
  parseProbe,
  pickTimes,
  sharpestIndex,
  sharpness,
  showinfoTimes,
  timeText,
  uniformTimes,
  type VideoFrame,
} from './video.ts'

test('认视频：按扩展名或 mime', () => {
  assert.equal(isVideoFile('录屏.MP4'), true)
  assert.equal(isVideoFile('a.mkv'), true)
  assert.equal(isVideoFile('a.png'), false)
  assert.equal(isVideoFile('blob', 'video/webm'), true)
  assert.equal(isVideoFile('song.mp3'), false)
})

test('解析 ffmpeg -i 的输出：时长、尺寸、帧率，不被 fourcc 里的 0x 骗', () => {
  const out = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '录屏.mp4':",
    '  Duration: 00:01:42.33, start: 0.000000, bitrate: 1234 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 1100 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)',
  ].join('\n')
  assert.deepEqual(parseProbe(out), { duration: 102.33, width: 1920, height: 1080, fps: 29.97 })
  assert.deepEqual(parseProbe('nothing'), { duration: 0, width: 0, height: 0, fps: 0 })
  assert.equal(ffmpegVersion('ffmpeg version 6.0-static https://johnvansickle.com'), '6.0-static')
})

test('showinfo 的 pts_time', () => {
  const out = '[Parsed_showinfo_3 @ 0x1] n:   0 pts:  1000 pts_time:1.25 duration:1\n[x] n: 1 pts_time:3.5 \n'
  assert.deepEqual(showinfoTimes(out), [1.25, 3.5])
})

test('均匀截帧取每段中间，不取 0 秒和结尾', () => {
  assert.deepEqual(uniformTimes(10, 4), [1.25, 3.75, 6.25, 8.75])
  assert.deepEqual(uniformTimes(0, 4), [])
})

test('画面变化挑点：候选多时每段取一个，少时在最大空档补齐，没有候选退回均匀', () => {
  const many = Array.from({ length: 50 }, (_, i) => i * 0.2)
  const picked = pickTimes(many, 10, 5)
  assert.equal(picked.length, 5)
  // 每段 2 秒各一个，且离段中间最近
  assert.deepEqual(picked, [1, 3, 5, 7, 9])
  const few = pickTimes([2], 10, 3)
  assert.equal(few.length, 3)
  assert.ok(few.includes(2))
  assert.deepEqual(pickTimes([], 10, 2), uniformTimes(10, 2))
  // 超出时长的候选不要
  assert.ok(pickTimes([20, 30], 10, 1).every((x) => x <= 10))
})

test('清晰度：有边缘的图比一片灰的分高，挑出最清楚的一帧', () => {
  const w = 8
  const h = 8
  const flat = new Uint8Array(w * h).fill(128)
  const edge = new Uint8Array(w * h).map((_, i) => (((i % w) + Math.floor(i / w)) % 2 ? 255 : 0))
  assert.equal(sharpness(flat, w, h), 0)
  assert.ok(sharpness(edge, w, h) > 1000)
  const raw = new Uint8Array([...flat, ...edge, ...flat])
  assert.equal(sharpestIndex(raw, w, h), 1)
  assert.equal(sharpestIndex(new Uint8Array(3), w, h), -1)
})

const frame = (id: string, time: number, source: 'manual' | 'auto'): VideoFrame => ({
  id,
  time,
  source,
  file: `/x/${id}.png`,
  width: 0,
  height: 0,
  bytes: 0,
})

test('自动截帧换掉旧的自动帧，手动帧一直保留，同一时刻不重复', () => {
  const old = [frame('m1', 2, 'manual'), frame('a1', 5, 'auto')]
  const next = mergeAuto(old, [frame('a2', 2.05, 'auto'), frame('a3', 8, 'auto')])
  assert.deepEqual(
    next.map((f) => f.id),
    ['m1', 'a3'],
  )
})

test('帧文件名带时间，增强的加 -enhanced；时间显示', () => {
  assert.equal(frameName('D:\\录屏\\复现.mp4', 72.34), '复现-01m12.3s.png')
  assert.equal(frameName('a.mov', 5, true), 'a-00m05.0s-enhanced.png')
  assert.equal(timeText(72.34), '01:12.3')
  assert.equal(timeText(3725, 0), '1:02:05')
})

test('增强方式 id 和下载地址', () => {
  assert.deepEqual(parseComfyMethod(comfyMethod('chain', 'c1')), { kind: 'chain', id: 'c1' })
  assert.equal(parseComfyMethod('ffmpeg-sharpen'), null)
  assert.match(
    ffmpegDownloadUrl('win32', 'x64', false),
    /github\.com\/eugeneware\/ffmpeg-static\/releases\/download\/b6\.0\/ffmpeg-win32-x64\.gz$/,
  )
  assert.match(ffmpegDownloadUrl('darwin', 'arm64', true), /npmmirror\.com/)
  assert.equal(ffmpegDownloadUrl('freebsd', 'x64', false), '')
})
