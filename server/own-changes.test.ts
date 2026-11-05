import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../shared/i18n.ts'
import type { Task } from '../shared/schema.ts'
import { mergeOutside, outsideFiles } from './own-changes.ts'

setLang('zh')

/** 临时目录里的一个目录；测试用 ignore: [] 关掉默认排除（项目本身也在系统临时目录里） */
function dir(name: string) {
  return mkdtempSync(path.join(tmpdir(), `ap-own-${name}-`))
}

const posix = (p: string) => p.split(path.sep).join('/')

test('项目外改动：记录项目根之外的绝对路径，项目根内的不进来', () => {
  const root = dir('root')
  const outside = dir('outside')
  const file = path.join(outside, 'notes.md')
  const got = outsideFiles(root, [file, 'src/a.ts', path.join(root, 'b.ts')], { ignore: [] })
  assert.deepEqual(got, [posix(file)])
})

test('项目外改动：相对项目根的 ../ 路径也算项目外，统一成绝对路径', () => {
  const root = path.join(dir('root'), 'project')
  mkdirSync(root, { recursive: true })
  const got = outsideFiles(root, ['../shared.md'], { ignore: [] })
  assert.deepEqual(got, [posix(path.join(path.dirname(root), 'shared.md'))])
})

test('项目外改动：同一个文件只记一次，空的路径跳过', () => {
  const root = dir('root')
  const outside = dir('outside')
  const file = path.join(outside, 'a.md')
  const got = outsideFiles(root, [file, file, '', '  '], { ignore: [] })
  assert.deepEqual(got, [posix(file)])
})

test('项目外改动：面板数据目录里的文件不算（附件、对话目录、交接和任务数据）', () => {
  const root = dir('root')
  const data = path.join(dir('data'), '.agent-panel')
  const attach = path.join(data, 'tasks', 'files', 'task1', 'attachments', 'shot.png')
  const handoff = path.join(data, 'tasks', 'handoff', 'task1', 'review.diff')
  const got = outsideFiles(root, [attach, handoff], { ignore: [data] })
  assert.deepEqual(got, [])
})

test('项目外改动：系统临时目录默认不算（面板和测试的临时产物）', () => {
  const root = dir('root')
  const tmpFile = path.join(dir('scratch'), 'x.md')
  // 默认 ignore 包含 tmpdir()，这个文件和项目都建在系统临时目录下
  assert.deepEqual(outsideFiles(root, [tmpFile]), [])
})

test('并进任务记录：重复的文件不重复追加', () => {
  const task = { outsideChanges: [] } as unknown as Pick<Task, 'outsideChanges'>
  mergeOutside(task, ['C:/notes/a.md', 'C:/notes/a.md', 'C:/notes/b.md'])
  mergeOutside(task, ['C:/notes/b.md', 'C:/notes/c.md'])
  assert.deepEqual(
    task.outsideChanges.map((c) => c.path),
    ['C:/notes/a.md', 'C:/notes/b.md', 'C:/notes/c.md'],
  )
})
