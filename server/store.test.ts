import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的，别动本机的设置和任务
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-store-'))
process.env.AGENT_PANEL_DATA = dir

const { BROKEN_DIR, archiveBrokenFile, readJson, readJsonDetailed, sweepStaleTmp, writeFileOnce, writeJsonAtomic } =
  await import('./store.ts')

/** 目录里剩下的临时文件：写入失败或中断时不能留 */
const tmpFiles = (d: string) => readdirSync(d).filter((f) => f.endsWith('.tmp'))

test('writeJsonAtomic：写成功后能读回，临时文件不残留', async () => {
  const file = path.join(dir, 'nested', 'written.json')
  const data = [{ id: 'a', text: '内容' }]
  await writeJsonAtomic(file, data)

  assert.deepEqual(await readJson(file), data)
  assert.deepEqual(tmpFiles(path.dirname(file)), [], '写完不留临时文件')
})

test('writeJsonAtomic：覆盖写之后读到的是新内容，且不留临时文件', async () => {
  const file = path.join(dir, 'nested', 'overwrite.json')
  await writeJsonAtomic(file, { v: 1 })
  await writeJsonAtomic(file, { v: 2 }, true)
  assert.deepEqual(await readJson(file), { v: 2 })
  assert.deepEqual(tmpFiles(path.dirname(file)), [])
})

test('readJson：文件不存在时返回 undefined，且不算损坏', async () => {
  const res = await readJsonDetailed(path.join(dir, 'nope.json'))
  assert.equal(res.state, 'missing')
  assert.equal(res.value, undefined)
  assert.equal(await readJson(path.join(dir, 'nope.json')), undefined)
})

test('readJson：坏 JSON 被留档，调用方能拿到「存在但坏了」和原路径、字节数', async () => {
  const file = path.join(dir, 'nested', 'broken.json')
  writeFileSync(file, '{"id": "a", 坏掉的内容', 'utf8')
  const size = readFileSync(file).length

  const res = await readJsonDetailed(file)
  assert.equal(res.state, 'broken')
  assert.equal(res.value, undefined)
  if (res.state !== 'broken') return
  // 原来的位置不再有文件（挪走了，不是删了），备份里是原始字节
  assert.equal(existsSync(file), false)
  assert.equal(res.broken.file, file)
  assert.equal(res.broken.size, size, '记下原文件的字节数，全 0 的空洞文件靠它认出来')
  assert.equal(readFileSync(res.broken.backup).length, size, '坏文件原样留档')
  assert.ok(res.broken.backup.startsWith(BROKEN_DIR), '归档到数据目录的留档目录')

  // 备份旁边有一份说明，写明原路径、时间、原因和字节数
  const note = JSON.parse(readFileSync(`${res.broken.backup}.broken.json`, 'utf8'))
  assert.equal(note.file, file)
  assert.equal(note.size, size)
  assert.equal(typeof note.at, 'string')
  assert.ok(note.reason.length > 0)

  // 旧签名的 readJson 保持兼容：当空数据处理，不再抛错
  assert.equal(await readJson(file), undefined)
})

test('readJson：全 0 的空洞文件判成损坏，并记下真实字节数', async () => {
  // 断电后 Windows 上会留下「长度对得上、内容全是 0x00」的这种文件
  const file = path.join(dir, 'nested', 'hole.json')
  writeFileSync(file, Buffer.alloc(4096))
  const res = await readJsonDetailed(file)
  assert.equal(res.state, 'broken')
  if (res.state !== 'broken') return
  assert.equal(res.broken.size, 4096)
  assert.equal(existsSync(file), false, '空洞文件也挪进缓存目录留档')
  assert.equal(readFileSync(res.broken.backup).length, 4096)
})

test('同一毫秒里归档两次同名文件：不覆盖前一份留档', async () => {
  const dirOfFile = path.join(dir, 'twice')
  const file = path.join(dirOfFile, 'same.json')
  mkdirSync(dirOfFile, { recursive: true })
  // 时间戳固定成同一个值：靠真实时钟碰运气不算验证（跳毫秒时两个备份本来就不同，拦不住撞名逻辑被写坏）
  const stamp = 1700000000000
  writeFileSync(file, '坏的内容 1', 'utf8')
  const first = await archiveBrokenFile(file, '测试', 11, stamp)
  writeFileSync(file, '坏的内容 2，长一点', 'utf8')
  const second = await archiveBrokenFile(file, '测试', 23, stamp)

  assert.equal(first.archived, true)
  assert.equal(second.archived, true)
  assert.notEqual(second.backup, first.backup, '同一个 stamp 两次归档也是两个不同的文件')
  // 两份原始内容都在，没有互相覆盖
  assert.equal(readFileSync(first.backup, 'utf8'), '坏的内容 1')
  assert.equal(readFileSync(second.backup, 'utf8'), '坏的内容 2，长一点')
  assert.equal(existsSync(file), false)
})

test('sweepStaleTmp：只删一小时前留下的 writeJsonAtomic 临时文件，新的、别人的 .tmp 和对话工作目录不动', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-sweep-'))
  const put = (rel: string) => {
    const f = path.join(root, rel)
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, '{')
    return f
  }
  const old = put('tasks/chats/t1.messages.json.1234.abcdef01.tmp')
  const fresh = put('tasks/chats/t2.json.1234.abcdef02.tmp')
  const other = put('tasks/chats/notes.tmp')
  const chat = put('chats/t1/out.json.1234.abcdef03.tmp')
  const hourAgo = Date.now() - 2 * 60 * 60_000
  for (const f of [old, other, chat]) utimesSync(f, hourAgo / 1000, hourAgo / 1000)
  const removed = await sweepStaleTmp(root)
  assert.deepEqual(removed, [old])
  assert.equal(existsSync(old), false)
  for (const f of [fresh, other, chat]) assert.equal(existsSync(f), true, f)
})

test('writeFileOnce：同一个按内容起名的文件同时写十次都成功，内容完整、不留临时文件', async () => {
  const file = path.join(dir, 'once', 'abc.rc')
  await Promise.all(Array.from({ length: 10 }, () => writeFileOnce(file, '--glob=!Intermediate\n')))
  assert.equal(readFileSync(file, 'utf8'), '--glob=!Intermediate\n')
  assert.deepEqual(tmpFiles(path.dirname(file)), [])
})
