/**
 * 对话里提到的文件怎么找到本机的真实文件：对话目录、项目目录、项目目录的上级（工作区根）依次找；
 * 打开接口只开项目里的、或者对话里提到过的文件。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mentioned, openable, resolvePath, searchRoots } from './task-paths.ts'

function fixture() {
  // <根>/Main/Project/Client 是项目目录；表格在 <根>/Main/Project/Designer 下，Agent 写的是相对 Main 的路径
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-paths-'))
  const project = path.join(root, 'Main', 'Project', 'Client')
  mkdirSync(path.join(project, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'Main', 'Project', 'Designer', 'Excel'), { recursive: true })
  writeFileSync(path.join(project, 'src', 'a.cpp'), 'int main() {}\n')
  writeFileSync(path.join(root, 'Main', 'Project', 'Designer', 'Excel', 'NPC.xlsx'), Buffer.from([0x50, 0x4b, 0, 0, 1]))
  return { root, project, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('searchRoots：对话目录、项目目录，再往上最多四层，不重复', () => {
  const roots = searchRoots('/data/wt/t1', '/w/Main/Project/Client')
  assert.deepEqual(
    roots.map((r) =>
      r
        .split(path.sep)
        .join('/')
        .replace(/^[A-Za-z]:/, ''),
    ),
    ['/data/wt/t1', '/w/Main/Project/Client', '/w/Main/Project', '/w/Main', '/w', '/'],
  )
  assert.equal(searchRoots('/p', '/p').length, 2, '对话目录就是项目目录时只算一次')
})

test('resolvePath：项目里的文本文件给相对路径，认成文字', async () => {
  const f = fixture()
  try {
    const homes = [f.project]
    const info = await resolvePath('src/a.cpp', searchRoots(f.project, f.project), homes)
    assert.equal(info.exists, true)
    assert.equal(info.rel, 'src/a.cpp')
    assert.equal(info.inTask, true)
    assert.equal(info.text, true)
    assert.equal(info.dir, false)
  } finally {
    f.done()
  }
})

test('resolvePath：相对工作区根写的路径在上级目录里找到，不算项目内，二进制不认成文字', async () => {
  const f = fixture()
  try {
    const want = 'Project/Designer/Excel/NPC.xlsx'
    const info = await resolvePath(want, searchRoots(f.project, f.project), [f.project])
    assert.equal(info.exists, true)
    assert.equal(info.abs, path.join(f.root, 'Main', want))
    assert.equal(info.rel, '')
    assert.equal(info.inTask, false)
    assert.equal(info.text, false)
  } finally {
    f.done()
  }
})

test('resolvePath：目录、绝对路径、找不到的', async () => {
  const f = fixture()
  try {
    const roots = searchRoots(f.project, f.project)
    const dir = await resolvePath('src', roots, [f.project])
    assert.equal(dir.dir, true)
    const abs = await resolvePath(path.join(f.project, 'src', 'a.cpp'), roots, [f.project])
    assert.equal(abs.rel, 'src/a.cpp')
    const gone = await resolvePath('src/没有.ts', roots, [f.project])
    assert.equal(gone.exists, false)
    // 找不到时按第一个根拼出完整路径，复制路径能复制到它本该在的位置
    assert.equal(gone.abs, path.join(f.project, 'src', '没有.ts'))
  } finally {
    f.done()
  }
})

test('mentioned / openable：对话里提到过（正反斜杠都算）或在项目里才能打开', async () => {
  const f = fixture()
  try {
    const task = {
      messages: [
        { text: '表在 `Project\\Designer\\Excel\\NPC.xlsx`', tools: [] },
        { text: '', tools: [{ label: 'src/a.cpp', input: '', output: '' }] },
      ],
    } as never
    assert.equal(mentioned(task, 'Project/Designer/Excel/NPC.xlsx'), true)
    assert.equal(mentioned(task, 'Project/Designer/Excel/Other.xlsx'), false)
    const roots = searchRoots(f.project, f.project)
    const xlsx = await resolvePath('Project/Designer/Excel/NPC.xlsx', roots, [f.project])
    assert.equal(openable(task, xlsx, [f.project]), true)
    // 项目外、对话里没提到的：不能凭一段路径就打开
    const other = await resolvePath(path.join(f.root, 'Main', 'Project', 'Designer'), roots, [f.project])
    assert.equal(openable({ messages: [] } as never, other, [f.project]), false)
    // 项目里的文件不用提到也能打开
    const cpp = await resolvePath('src/a.cpp', roots, [f.project])
    assert.equal(openable({ messages: [] } as never, cpp, [f.project]), true)
  } finally {
    f.done()
  }
})
