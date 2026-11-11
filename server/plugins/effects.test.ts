import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { clearPluginEffects, notePluginEffect, pluginExtra } from './effects.ts'

const cwd = path.resolve('/proj')
const edit = { name: 'write_asset', effect: 'edit' as const }
const verify = { name: 'compile_bp', effect: 'verify' as const }

test('插件作用：改了的文件进改动，验证通过的记成已覆盖，之后再改的拿掉', () => {
  clearPluginEffects()
  const at = (s: number) => `2026-11-11T00:00:0${s}Z`
  assert.deepEqual(notePluginEffect('t1', cwd, 'ue', edit, { changed: [path.join(cwd, 'Content/A.uasset')] }, at(1)), [
    path.join(cwd, 'Content/A.uasset'),
  ])
  notePluginEffect('t1', cwd, 'ue', edit, { changed: ['Content/B.uasset'] }, at(2))
  notePluginEffect('t1', cwd, 'ue', verify, { verified: { passed: true, name: '蓝图编译' } }, at(3))
  notePluginEffect('t1', cwd, 'ue', edit, { changed: ['Content/B.uasset'] }, at(4))
  const x = pluginExtra('t1', at(0))
  assert.deepEqual(x.files, ['Content/A.uasset', 'Content/B.uasset'])
  assert.deepEqual(x.commands, [{ command: '蓝图编译', plugin: true }])
  assert.deepEqual(x.covered, ['Content/A.uasset'], 'B 在验证之后又改过')
  assert.deepEqual(pluginExtra('t1', at(4)).files, ['Content/B.uasset'], '只取这一轮输入之后的')
})

test('插件作用：验证工具报错按没通过，只读工具和没报改动的不记', () => {
  clearPluginEffects()
  assert.deepEqual(notePluginEffect('t2', cwd, 'ue', { name: 'read', effect: 'read' }, { changed: ['a'] }), [])
  assert.deepEqual(notePluginEffect('t2', cwd, 'ue', edit, { isError: true, changed: ['a'] }), [])
  notePluginEffect('t2', cwd, 'ue', verify, { isError: true })
  assert.deepEqual(pluginExtra('t2', '').commands, [{ command: 'ue · compile_bp', plugin: true, failed: true }])
})
