// 后台拷贝接口：只接受面板确认过的本机路径，拷贝失败降级，删卡片时清掉副本
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_ATTACHMENT_BYTES } from '../shared/schema.ts'
import { setLang } from '../shared/i18n.ts'

// 数据目录要在 uploads.ts 加载之前定好：UPLOADS_DIR 是模块加载时算出来的
const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-uploads-copy-'))
process.env.AGENT_PANEL_DATA = dataDir
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
// 这里断言的是接口返回的 t() 文案：显式固定语言，不跟着 LANG 走
setLang('zh')

const { UPLOADS_DIR, uploadsApi } = await import('./uploads.ts')

const app = uploadsApi()
const post = (route: string, body: unknown) =>
  app.request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const copiedOf = async (routes: string[]) =>
  ((await (await post('/copy', { paths: routes })).json()) as { files: Record<string, unknown>[] }).files

/** 源文件放在临时目录里，不碰真实的数据目录 */
const src = mkdtempSync(path.join(tmpdir(), 'agent-panel-copy-src-'))
process.on('exit', () => rmSync(src, { recursive: true, force: true }))
const make = (name: string, text = 'hello') => {
  const file = path.join(src, name)
  writeFileSync(file, text)
  return file
}

/** 走一遍「粘贴路径」的确认流程，返回服务端认可的附件 */
async function resolveInto(file: string) {
  const res = await post('/resolve', { paths: [file] })
  assert.equal(res.status, 200)
  const { files } = (await res.json()) as { files: { path: string }[] }
  assert.equal(files.length, 1)
  return files[0]
}

test('没确认过、超过上限的路径都不拷；确认过的拷进数据目录', async () => {
  // 没经过确认：前端随便传一段本机路径不行
  const secret = make('secret.txt', '不该被拷走')
  assert.deepEqual(await copiedOf([secret]), [])
  // 确认过、正常大小：拷一份，返回副本的路径和大小
  const file = make('需求.txt', '内容')
  const a = await resolveInto(file)
  const files = (await copiedOf([a.path])) as { from: string; name: string; path: string; size: number }[]
  assert.equal(files.length, 1)
  const [copied] = files
  assert.equal(copied.from, file, 'from 是确认时的原路径')
  assert.equal(copied.name, '需求.txt')
  assert.ok(copied.path.startsWith(UPLOADS_DIR + path.sep), '副本在数据目录的 uploads 下')
  assert.equal(readFileSync(copied.path, 'utf8'), '内容')
  assert.equal(copied.size, 6)
  // 超过单文件上限的不拷
  const big = make('大文件.bin')
  truncateSync(big, MAX_ATTACHMENT_BYTES + 1)
  const b = await resolveInto(big)
  assert.deepEqual(await copiedOf([b.path]), [])
  // 拷贝失败不返回：源文件在确认之后没了，页面自己降级成引用原路径
  const gone = make('会消失.txt')
  const c = await resolveInto(gone)
  rmSync(gone)
  assert.deepEqual(await copiedOf([c.path]), [])
  // 删卡片时把拷出来的副本删掉；别的任务留下的附件目录没被确认过，不能靠这个接口删
  const owned = (await copiedOf([(await resolveInto(make('要删的.txt', 'x'))).path])) as { path: string }[]
  assert.ok(existsSync(owned[0].path))
  const other = path.join(UPLOADS_DIR, 'other-task')
  mkdirSync(other, { recursive: true })
  assert.equal((await post('/discard', { paths: [owned[0].path, path.join(other, 'a.txt')] })).status, 200)
  assert.ok(!existsSync(path.dirname(owned[0].path)), '副本目录整个删掉')
  assert.ok(existsSync(other), '没确认过的路径不删')
})
