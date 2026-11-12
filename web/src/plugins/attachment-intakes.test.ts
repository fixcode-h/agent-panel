/** 插件按扩展名 / MIME 认领输入框附件（插件接口 6：视频插件认领视频，发送时换成截好的帧） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { intakeByKey, pickIntake } from '@/plugins/attachment-intakes'

const Dialog = () => null
const base = { status: () => '', pending: () => '', Dialog }
const plugins: [string, { attachmentIntakes?: (typeof base & { id: string; exts: string[]; mimes?: string[] })[] }][] =
  [
    ['ue', {}],
    ['video', { attachmentIntakes: [{ ...base, id: 'frames', exts: ['mp4', 'MKV'], mimes: ['video/'] }] }],
    ['other', { attachmentIntakes: [{ ...base, id: 'dup', exts: ['mp4', 'gif'] }] }],
  ]

test('pickIntake：按扩展名（不分大小写）或 MIME 前缀认领，重复登记用先登记的', () => {
  assert.equal(pickIntake(plugins, '录屏.MP4')?.key, 'video:frames')
  assert.equal(pickIntake(plugins, 'a.mkv')?.plugin, 'video')
  assert.equal(pickIntake(plugins, 'clip', 'video/webm')?.key, 'video:frames')
  assert.equal(pickIntake(plugins, 'x.gif')?.key, 'other:dup')
})

test('pickIntake：没人认领的文件照旧当普通附件', () => {
  assert.equal(pickIntake(plugins, 'a.png', 'image/png'), undefined)
  assert.equal(pickIntake(plugins, 'mp4'), undefined)
  assert.equal(pickIntake([], 'a.mp4', 'video/mp4'), undefined)
})

test('intakeByKey：按条目上记的 key 找回插件，插件不在了找不到', () => {
  assert.equal(intakeByKey(plugins, 'video:frames')?.plugin, 'video')
  assert.equal(intakeByKey(plugins, 'gone:frames'), undefined)
})
