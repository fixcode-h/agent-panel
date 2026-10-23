import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/schema.ts'

const { ATTACH_DIR, placeAttachments, relativeAttachName } = await import('./attachments.ts')

const dir = (name: string) => mkdtempSync(path.join(tmpdir(), `agent-panel-attach-${name}-`))

/** 在临时目录里造一个附件，返回它的 Attachment */
function make(src: string, name: string, size = 0): Attachment {
  const file = path.join(src, name)
  writeFileSync(file, size ? Buffer.alloc(size, 1) : 'hello')
  return { name, path: file, size: size || 5, mime: 'text/plain' }
}

test('附件拷进任务目录的 attachments/，路径换成 Agent 用的相对路径', async () => {
  const from = dir('from')
  const task = dir('task')
  const a = make(from, '需求.txt')

  const [placed] = await placeAttachments(task, [a])

  assert.equal(placed.name, '需求.txt')
  assert.equal(placed.path, 'attachments/需求.txt', '交给 Agent 的是相对任务目录的路径')
  assert.equal(readFileSync(path.join(task, placed.path), 'utf8'), 'hello')
  assert.ok(existsSync(a.path), '原来的文件不删')
})

test('超过 20M 的不拷，直接用原来的路径', async () => {
  const from = dir('big')
  const task = dir('task-big')
  const big = make(from, '素材.bin', MAX_ATTACHMENT_BYTES + 1)

  const [placed] = await placeAttachments(task, [big])

  assert.equal(placed.path, big.path, '还是原来的路径')
  assert.ok(!existsSync(path.join(task, ATTACH_DIR, '素材.bin')), '任务目录里没有这份大文件')
})

test('同一个任务里重名的附件加序号，不互相覆盖', async () => {
  const one = dir('one')
  const two = dir('two')
  const task = dir('task-dupe')

  const placed = await placeAttachments(task, [make(one, 'note.txt'), make(two, 'note.txt')])

  assert.deepEqual(
    placed.map((a) => a.path),
    ['attachments/note.txt', 'attachments/note (2).txt'],
  )
})

test('已经在任务目录里的附件不再拷一遍，路径仍然是相对的', async () => {
  const task = dir('task-same')
  const [first] = await placeAttachments(task, [make(dir('src'), 'a.txt')])
  const [again] = await placeAttachments(task, [first])

  assert.equal(again.path, 'attachments/a.txt')
})

test('已经是相对路径的附件不再处理：重复执行不会把路径弄坏', async () => {
  const task = dir('task-rel')
  const [first] = await placeAttachments(task, [make(dir('src2'), 'b.txt')])
  const [again] = await placeAttachments(task, [first])

  assert.equal(again.path, 'attachments/b.txt')
})

test('没有执行目录时原样返回，不报错', async () => {
  const [placed] = await placeAttachments('', [make(dir('none'), 'x.txt')])
  assert.ok(placed.path.endsWith('x.txt'))
})

test('粘贴路径引用的已有文件和引用卡片不拷，用原来的路径', async () => {
  const from = dir('from')
  const task = dir('task')
  const ref = { ...make(from, '引用.txt'), ref: true }
  const quote = { ...make(from, 'quote-q1.md'), quote: 'hello' }
  const placed = await placeAttachments(task, [ref, quote])
  assert.deepEqual(
    placed.map((a) => a.path),
    [ref.path, quote.path],
  )
  assert.ok(!existsSync(path.join(task, ATTACH_DIR, '引用.txt')))
})

test('拷进任务目录不影响传进来的附件：记进对话的仍是上传目录里的原始绝对路径', async () => {
  const a = make(dir('from-keep'), '截图.png')
  const [placed] = await placeAttachments(dir('task-keep'), [a])

  assert.equal(a.path, path.join(path.dirname(a.path), '截图.png'), '传进来的对象不被改写')
  assert.notEqual(placed.path, a.path, '交给 Agent 的是任务目录里的那一份')
  assert.ok(path.isAbsolute(a.path), '原路径还是绝对的，页面据此从附件目录取缩略图')
})

test('旧消息里的 attachments/名字：按名字找回上传目录那一份，别的一概不认', () => {
  assert.equal(relativeAttachName('attachments/截图-071747.png'), '截图-071747.png')
  assert.equal(relativeAttachName('attachments\\截图-071747.png'), '截图-071747.png')
  for (const bad of [
    'C:/x/截图.png',
    '/tmp/a/截图.png',
    'attachments/',
    'attachments/..',
    'attachments/a/b.png',
    '截图.png',
  ])
    assert.equal(relativeAttachName(bad), '', bad)
})
