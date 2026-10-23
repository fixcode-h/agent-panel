// 消息里的附件怎么取图：旧消息存的是拷进任务目录的相对路径（attachments/名字），
// 接口要能按文件名回附件目录找回，同时不能让它去读附件目录以外的文件。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../shared/i18n.ts'

// 数据目录要在 uploads.ts 加载之前定好：UPLOADS_DIR 是模块加载时算出来的
const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-uploads-raw-'))
process.env.AGENT_PANEL_DATA = dataDir
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
// 这里断言的是接口返回的 t() 文案：显式固定语言，不跟着 LANG 走
setLang('zh')

const { UPLOADS_DIR, uploadsRawApi } = await import('./uploads.ts')

const app = uploadsRawApi()
const raw = (p: string) => app.request(`/?path=${encodeURIComponent(p)}`)
const view = (p: string) => app.request(`/file?path=${encodeURIComponent(p)}`)

// 上传时的样子：每个附件单独一个目录，保留原文件名
const dir = path.join(UPLOADS_DIR, '4b36f8c7-1b1e-4f3a-9a4b-2f9d0b0e1a11')
mkdirSync(dir, { recursive: true })
const png = path.join(dir, '截图-071747.png')
writeFileSync(png, 'png!')
const note = path.join(dir, '需求.md')
writeFileSync(note, '# 需求\n')

test('附件目录里的绝对路径照旧能取到原图', async () => {
  const res = await raw(png)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(await res.text(), 'png!')
})

test('旧消息里的相对路径（attachments/名字）按文件名回附件目录取到图', async () => {
  // 消息里存的就是这个形状：任务目录里的那份，任务目录删了也要能显示
  const res = await raw('attachments/截图-071747.png')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'png!')
  // Windows 的分隔符也认
  assert.equal((await raw('attachments\\截图-071747.png')).status, 200)
})

test('相对路径不当地址用：不带 attachments/、带 .. 或层级的一律不是附件', async () => {
  for (const bad of ['截图-071747.png', 'attachments/../需求.md', 'attachments/a/../../需求.md', '../../etc/passwd']) {
    const res = await raw(bad)
    assert.equal(res.status, 400, bad)
    assert.equal((await res.json()).error, '不是附件', bad)
  }
})

test('附件已经被清理时返回「附件已经不在了」，不是破图', async () => {
  const res = await raw('attachments/没有了.png')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, '附件已经不在了')
})

test('附件目录以外的文件不能借这个接口读', async () => {
  const outside = path.join(dataDir, 'secret.png')
  writeFileSync(outside, 'secret')
  assert.equal((await raw(outside)).status, 200, '图片扩展名的绝对路径是粘贴引用的本机文件，照旧能看')
  const text = path.join(dataDir, 'notes.txt')
  writeFileSync(text, 'secret')
  assert.equal((await raw(text)).status, 400, '不是图片的不能从 raw 读')
})

test('点文件卡片看内容：相对路径也能找到，找不到时说附件已经不在了', async () => {
  const hit = await view('attachments/需求.md')
  assert.equal(hit.status, 200)
  assert.equal((await hit.json()).content, '# 需求\n')
  const gone = await view('attachments/没有.md')
  assert.equal(gone.status, 404)
  assert.equal((await gone.json()).error, '附件已经不在了')
})
