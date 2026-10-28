import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/schema.ts'

const { ATTACH_DIR, attachmentAddDirs, placedFiles, placeAttachments, relativeAttachName } =
  await import('./attachments.ts')

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

/** 图片附件：拷进对话目录的就是它 */
const image = (src: string, name = '截图.png', opts: { size?: number } = {}) =>
  make(src, name, { ...opts, mime: 'image/png' })

test('图片拷进对话目录根，路径换成 Agent 用的相对文件名', async () => {
  const from = dir('from')
  const task = dir('task')
  const a = image(from, '需求.png')

  const { attachments, placed } = await placeAttachments(task, [a])
  const [p] = attachments

  assert.equal(p.name, '需求.png')
  assert.equal(p.path, '需求.png', '交给 Agent 的是相对对话目录的文件名')
  assert.equal(readFileSync(path.join(task, p.path), 'utf8'), 'hello')
  assert.ok(existsSync(a.path), '原来的文件不删')
  assert.deepEqual(placed, { [a.path]: '需求.png' }, '记下放置映射，统计 git 改动时排除它')
})

test('文本、代码、PDF 和上传目录里的文件都不拷：路径原样给你，对话目录里没有它', async () => {
  const from = dir('files')
  const uploads = dir('uploads')
  const task = dir('task-files')
  const files = [
    make(from, '需求.txt'),
    make(from, 'main.ts'),
    make(from, '说明.pdf', { mime: 'application/pdf' }),
    make(uploads, '上传.txt'),
  ]

  const { attachments, placed } = await placeAttachments(task, files)

  assert.deepEqual(
    attachments.map((a) => a.path),
    files.map((a) => a.path),
    '交给 Agent 的是原来那份的绝对路径',
  )
  for (const f of files) assert.ok(!existsSync(path.join(task, f.name)), `${f.name} 不拷进对话目录`)
  assert.deepEqual(placed, {}, '没有拷进来的文件就没有排除名单')
})

test('超过上限的图片不拷，直接用原来的路径', async () => {
  const from = dir('big')
  const task = dir('task-big')
  const big = image(from, '素材.png', { size: MAX_ATTACHMENT_BYTES + 1 })

  const { attachments, placed } = await placeAttachments(task, [big])

  assert.equal(attachments[0].path, big.path, '还是原来的路径')
  assert.ok(!existsSync(path.join(task, '素材.png')), '对话目录里没有这份大图')
  assert.deepEqual(placed, {})
})

test('同一个任务里重名的图片加序号，不互相覆盖', async () => {
  const one = dir('one')
  const two = dir('two')
  const task = dir('task-dupe')

  const { attachments } = await placeAttachments(task, [image(one, 'note.png'), image(two, 'note.png')])

  assert.deepEqual(
    attachments.map((a) => a.path),
    ['note.png', 'note (2).png'],
  )
})

test('对话目录里已有同名文件不覆盖；同一个源文件再次放置沿用原来那份', async () => {
  const task = dir('task-taken')
  writeFileSync(path.join(task, 'note.png'), 'original')
  const a = image(dir('taken'), 'note.png')

  const first = await placeAttachments(task, [a])
  assert.equal(first.attachments[0].path, 'note (2).png', '避开目录里已有的文件')
  assert.equal(readFileSync(path.join(task, 'note.png'), 'utf8'), 'original', '原文件一个字节不动')

  const again = await placeAttachments(task, [a], first.placed)
  assert.equal(again.attachments[0].path, 'note (2).png', '同一张图再放时还用原来那份')
  assert.deepEqual(again.placed, { [a.path]: 'note (2).png' })
  assert.ok(!existsSync(path.join(task, 'note (3).png')), '不会越攒越多副本')
})

test('已经在对话目录里的、已经是相对路径的附件都不再拷，路径保持相对', async () => {
  const task = dir('task-same')
  const inside: Attachment = { name: 'a.png', path: path.join(task, 'a.png'), size: 1, mime: 'image/png' }
  writeFileSync(inside.path, 'x')
  const rel: Attachment = { name: 'b.png', path: `${ATTACH_DIR}/b.png`, size: 1, mime: 'image/png' }

  const { attachments } = await placeAttachments(task, [inside, rel])

  assert.deepEqual(
    attachments.map((a) => a.path),
    ['a.png', `${ATTACH_DIR}/b.png`],
  )
})

test('没有执行目录时原样返回，不报错', async () => {
  const { attachments } = await placeAttachments('', [image(dir('none'), 'x.png')])
  assert.ok(attachments[0].path.endsWith('x.png'))
})

test('粘贴路径引用的已有文件和引用卡片不拷，用原来的路径', async () => {
  const from = dir('from')
  const task = dir('task')
  const ref = { ...image(from, '引用.png'), ref: true }
  const quote = { ...make(from, 'quote-q1.md'), quote: 'hello' }
  const { attachments } = await placeAttachments(task, [ref, quote])
  assert.deepEqual(
    attachments.map((a) => a.path),
    [ref.path, quote.path],
  )
  assert.ok(!existsSync(path.join(task, '引用.png')))
})

test('拷进对话目录不影响传进来的附件：记进对话的仍是原始的绝对路径', async () => {
  const a = image(dir('from-keep'), '截图.png')
  const { attachments } = await placeAttachments(dir('task-keep'), [a])

  assert.equal(a.path, path.join(path.dirname(a.path), '截图.png'), '传进来的对象不被改写')
  assert.notEqual(attachments[0].path, a.path, '交给 Agent 的是对话目录里的那一份')
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
  const root = path.parse(tmpdir()).root
  assert.deepEqual(
    attachmentAddDirs([{ ...image(tmpdir(), 'a.png'), path: path.join(root, 'a.png') }], { cwd: root }),
    [],
  )
})

test('对话目录里的路径和相对路径不用放行', () => {
  const cwd = dir('cwd')
  const uploadsRoot = path.join(dir('data'), 'uploads')
  const inside = { ...image(cwd, 'a.png'), path: path.join(cwd, ATTACH_DIR, 'a.png') }
  const relative = { ...image(cwd, 'b.png'), path: 'b.png' }

  assert.deepEqual(attachmentAddDirs([inside, relative], { cwd, uploadsRoot }), [])
  assert.deepEqual(attachmentAddDirs([], { cwd, uploadsRoot }), [])
})

test('旧消息里的 attachments/名字：只认上传目录那一份，并进 git 排除名单', () => {
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

  // 旧任务没有 placedAttachments，只存了 `attachments/名字`：升级后仍要排除当年拷进子目录的图片
  const old = { ...image(dir('old'), '旧.png'), path: `${ATTACH_DIR}/旧.png` }
  const abs = image(dir('abs'), '绝对.png')
  const task = {
    placedAttachments: { '/src/新.png': '新.png' },
    messages: [
      { role: 'user', text: '', attachments: [old] },
      { role: 'assistant', text: '', attachments: [abs] },
      { role: 'user', text: '', attachments: [old] },
    ],
  }
  assert.deepEqual(placedFiles(task as never), ['新.png', `${ATTACH_DIR}/旧.png`], '绝对路径不补、重复只留一份')
})
