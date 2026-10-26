import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/schema.ts'

const { ATTACH_DIR, attachmentAddDirs, placeAttachments, relativeAttachName } = await import('./attachments.ts')

const dir = (name: string) => mkdtempSync(path.join(tmpdir(), `agent-panel-attach-${name}-`))

/**
 * 在临时目录里造一个附件，返回它的 Attachment。
 * size 只是记在附件上的数（判定上限用它），不按它写那么大的文件，否则每个用例都要写几十 MB。
 */
function make(src: string, name: string, opts: { size?: number; mime?: string } = {}): Attachment {
  const file = path.join(src, name)
  mkdirSync(src, { recursive: true })
  writeFileSync(file, 'hello')
  return { name, path: file, size: opts.size ?? 5, mime: opts.mime ?? 'text/plain' }
}

/** 图片附件：拷进任务目录的就是它 */
const image = (src: string, name = '截图.png', opts: { size?: number } = {}) =>
  make(src, name, { ...opts, mime: 'image/png' })

test('图片拷进任务目录的 attachments/，路径换成 Agent 用的相对路径', async () => {
  const from = dir('from')
  const task = dir('task')
  const a = image(from, '需求.png')

  const [placed] = await placeAttachments(task, [a])

  assert.equal(placed.name, '需求.png')
  assert.equal(placed.path, 'attachments/需求.png', '交给 Agent 的是相对任务目录的路径')
  assert.equal(readFileSync(path.join(task, placed.path), 'utf8'), 'hello')
  assert.ok(existsSync(a.path), '原来的文件不删')
})

test('文本、代码、PDF 之类的文件不再拷：路径原样给你，任务目录里没有它', async () => {
  const from = dir('files')
  const task = dir('task-files')
  const files = [make(from, '需求.txt'), make(from, 'main.ts'), make(from, '说明.pdf', { mime: 'application/pdf' })]

  const placed = await placeAttachments(task, files)

  assert.deepEqual(
    placed.map((a) => a.path),
    files.map((a) => a.path),
    '交给 Agent 的是原来那份的绝对路径',
  )
  assert.ok(!existsSync(path.join(task, ATTACH_DIR)), '一个文件都不拷时连 attachments/ 都不建')
})

test('上传目录里的文件也只用原路径，不再往任务目录拷第二份', async () => {
  const uploads = dir('uploads')
  const task = dir('task-upload')
  const a = make(uploads, '需求.txt')

  const [placed] = await placeAttachments(task, [a])

  assert.equal(placed.path, a.path)
  assert.ok(!existsSync(path.join(task, ATTACH_DIR, '需求.txt')), '只在 uploads 里有一份')
})

test('超过上限的图片不拷，直接用原来的路径', async () => {
  const from = dir('big')
  const task = dir('task-big')
  const big = image(from, '素材.png', { size: MAX_ATTACHMENT_BYTES + 1 })

  const [placed] = await placeAttachments(task, [big])

  assert.equal(placed.path, big.path, '还是原来的路径')
  assert.ok(!existsSync(path.join(task, ATTACH_DIR, '素材.png')), '任务目录里没有这份大图')
})

test('同一个任务里重名的图片加序号，不互相覆盖', async () => {
  const one = dir('one')
  const two = dir('two')
  const task = dir('task-dupe')

  const placed = await placeAttachments(task, [image(one, 'note.png'), image(two, 'note.png')])

  assert.deepEqual(
    placed.map((a) => a.path),
    ['attachments/note.png', 'attachments/note (2).png'],
  )
})

test('已经在任务目录里的附件不再拷一遍，路径仍然是相对的', async () => {
  const task = dir('task-same')
  const [first] = await placeAttachments(task, [image(dir('src'), 'a.png')])
  const [again] = await placeAttachments(task, [first])

  assert.equal(again.path, 'attachments/a.png')
})

test('已经是相对路径的附件不再处理：重复执行不会把路径弄坏', async () => {
  const task = dir('task-rel')
  const [first] = await placeAttachments(task, [image(dir('src2'), 'b.png')])
  const [again] = await placeAttachments(task, [first])

  assert.equal(again.path, 'attachments/b.png')
})

test('没有执行目录时原样返回，不报错', async () => {
  const [placed] = await placeAttachments('', [image(dir('none'), 'x.png')])
  assert.ok(placed.path.endsWith('x.png'))
})

test('粘贴路径引用的已有文件和引用卡片不拷，用原来的路径', async () => {
  const from = dir('from')
  const task = dir('task')
  const ref = { ...image(from, '引用.png'), ref: true }
  const quote = { ...make(from, 'quote-q1.md'), quote: 'hello' }
  const placed = await placeAttachments(task, [ref, quote])
  assert.deepEqual(
    placed.map((a) => a.path),
    [ref.path, quote.path],
  )
  assert.ok(!existsSync(path.join(task, ATTACH_DIR, '引用.png')))
})

test('拷进任务目录不影响传进来的附件：记进对话的仍是原始的绝对路径', async () => {
  const a = image(dir('from-keep'), '截图.png')
  const [placed] = await placeAttachments(dir('task-keep'), [a])

  assert.equal(a.path, path.join(path.dirname(a.path), '截图.png'), '传进来的对象不被改写')
  assert.notEqual(placed.path, a.path, '交给 Agent 的是任务目录里的那一份')
  assert.ok(path.isAbsolute(a.path), '原路径还是绝对的，页面据此从附件目录取缩略图')
})

test('要放行的目录：uploads 下的合并成一个根，项目里的文件各自放行所在的目录', () => {
  const cwd = dir('cwd')
  const uploadsRoot = path.join(dir('data'), 'uploads')
  const shot = image(path.join(uploadsRoot, 'u1'), '截图.png')
  const pdf = make(path.join(uploadsRoot, 'u2'), '说明.pdf', { mime: 'application/pdf' })
  const projectFile = make(path.join(dir('proj'), 'src'), 'main.ts')

  assert.deepEqual(attachmentAddDirs([shot, pdf, projectFile], { cwd, uploadsRoot }), [
    uploadsRoot,
    path.dirname(projectFile.path),
  ])
})

test('执行目录是盘根时，里面的路径仍算在工作目录内（不能拼出双分隔符）', () => {
  const root = path.parse(tmpdir()).root // Windows 上是 `C:\`，Linux 上是 `/`
  assert.deepEqual(
    attachmentAddDirs([{ ...image(tmpdir(), 'a.png'), path: path.join(root, 'a.png') }], { cwd: root }),
    [],
  )
})

test('任务目录里的路径和相对路径不用放行', () => {
  const cwd = dir('cwd')
  const uploadsRoot = path.join(dir('data'), 'uploads')
  const inside = { ...image(path.join(cwd, ATTACH_DIR), 'a.png'), path: path.join(cwd, ATTACH_DIR, 'a.png') }
  const relative = { ...image(cwd, 'b.png'), path: `${ATTACH_DIR}/b.png` }

  assert.deepEqual(attachmentAddDirs([inside, relative], { cwd, uploadsRoot }), [])
  assert.deepEqual(attachmentAddDirs([], { cwd, uploadsRoot }), [])
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
