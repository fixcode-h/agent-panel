/** 插件的文件查看器按扩展名认领文件（对话里点 .uasset 弹出 UE 插件的属性窗口） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickFileViewer } from '@/plugins/file-viewers'

const Viewer = () => null
const plugins: [string, { fileViewers?: { id: string; exts: string[]; Viewer: typeof Viewer }[] }][] = [
  ['blender', {}],
  ['ue', { fileViewers: [{ id: 'asset', exts: ['uasset'], Viewer }] }],
  ['other', { fileViewers: [{ id: 'dup', exts: ['UASSET', 'foo'], Viewer }] }],
]

test('pickFileViewer：按扩展名（不分大小写）找查看器，重复登记用先登记的', () => {
  assert.equal(pickFileViewer(plugins, 'Content/Data/DT_Item.uasset')?.plugin, 'ue')
  assert.equal(pickFileViewer(plugins, 'G:\\Proj\\Content\\DA_Hero.UASSET')?.id, 'asset')
  assert.equal(pickFileViewer(plugins, 'a/b.foo')?.plugin, 'other')
})

test('pickFileViewer：没人登记的扩展名、目录、没有扩展名的文件没有查看器', () => {
  assert.equal(pickFileViewer(plugins, 'Map.umap'), undefined)
  assert.equal(pickFileViewer(plugins, 'a.uasset/'), undefined)
  assert.equal(pickFileViewer(plugins, 'uasset'), undefined)
  assert.equal(pickFileViewer([], 'a.uasset'), undefined)
})
