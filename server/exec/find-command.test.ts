/** 找本机命令：PATH 里跳过垫片目录、PATH 外按给的目录找、找不到返回空 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findCommand } from './find-command.ts'

const isWin = process.platform === 'win32'
const root = mkdtempSync(path.join(tmpdir(), 'find-command-'))
const make = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  const f = path.join(dir, isWin ? `${name}.cmd` : name)
  writeFileSync(f, isWin ? '@echo off\r\n' : '#!/bin/sh\n')
  chmodSync(f, 0o755)
  return f
}
const shim = path.join(root, 'shim')
const real = path.join(root, 'real')
const elsewhere = path.join(root, 'elsewhere')
const shimFile = make(shim, 'fc-tool')
const realFile = make(real, 'fc-tool')
const otherFile = make(elsewhere, 'fc-other')
const oldPath = process.env.PATH
// 测试里不起真的 npm：npm 全局目录这一步按「没有」走
process.env.AGENT_PANEL_NPM = path.join(root, 'no-npm')

test.after(() => {
  process.env.PATH = oldPath
  rmSync(root, { recursive: true, force: true })
})

test('PATH 里先找到的是垫片时跳过它，找到真命令', async () => {
  process.env.PATH = [shim, real].join(path.delimiter)
  assert.deepEqual(await findCommand('fc-tool'), { path: shimFile, from: 'path' })
  assert.deepEqual(await findCommand('fc-tool', { exclude: [shim + path.sep] }), { path: realFile, from: 'path' })
})

test('PATH 里没有时按给的目录找', async () => {
  process.env.PATH = real
  assert.deepEqual(await findCommand('fc-other', { dirs: [elsewhere] }), { path: otherFile, from: 'common' })
})

test('给的是完整路径时只看文件在不在；都找不到返回空', async () => {
  assert.equal((await findCommand(realFile))?.path, realFile)
  assert.equal(await findCommand(path.join(root, 'nope', 'fc-tool')), undefined)
  process.env.PATH = real
  assert.equal(await findCommand('fc-missing-xyz'), undefined)
})
