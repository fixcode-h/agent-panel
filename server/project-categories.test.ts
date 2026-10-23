import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ProjectCategory as Category, ProjectCategoryInput } from '../shared/schema.ts'

// 数据目录换成临时的，别动本机的设置和项目分类
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-project-categories-'))
process.env.AGENT_PANEL_DATA = dir

const { createCollection } = await import('./store.ts')
const { ProjectCategory } = await import('../shared/schema.ts')
const { builtinProjectCategories, isBuiltinProjectCategory, projectCategoryDeleteError } =
  await import('../shared/builtin/project-categories.ts')

const at = new Date(0).toISOString()
const file = (name: string) => path.join(dir, name)

/** 补齐内置项是读到缺失项后异步落盘，读文件前等一下它写完 */
async function readJsonWhen(p: string, ok: (v: unknown) => boolean) {
  for (let i = 0; i < 200; i++) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')) as unknown
      if (ok(v)) return v
    } catch {}
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待写盘超时：${p}`)
}

const collection = (name: string) =>
  createCollection<ProjectCategoryInput, Category>(name, ProjectCategory, builtinProjectCategories)

test('首次读取补上全部内置分类，重启后不重复插入', async () => {
  const c = collection('seed.json')
  const first = await c.list()
  const expected = builtinProjectCategories()

  assert.deepEqual(
    first.map((x) => x.id),
    expected.map((x) => x.id),
  )
  assert.ok(
    first.every((x) => x.builtin && isBuiltinProjectCategory(x.id)),
    '补进来的内置分类带 builtin 标记',
  )

  const onDisk = (await readJsonWhen(file('seed.json'), (v) => Array.isArray(v) && v.length === expected.length)) as {
    id: string
  }[]
  assert.equal(onDisk.length, expected.length, '补齐的内置分类落了盘')

  // 新实例等于重启后重新读文件：不会把内置分类再加一遍
  const again = await collection('seed.json').list()
  assert.deepEqual(again, first)
})

test('旧数据升级：缺的内置分类补上，用户自建的分类和顺序不变', async () => {
  const name = 'legacy.json'
  // 旧版本的项目分类：没有 builtin 字段
  writeFileSync(
    file(name),
    JSON.stringify([
      { id: 'user-b', name: '自己的 B', description: '', workflowId: '', createdAt: at, updatedAt: at },
      { id: 'user-a', name: '自己的 A', description: '', workflowId: '', createdAt: at, updatedAt: at },
    ]),
  )

  const list = await collection(name).list()
  const mine = list.filter((x) => x.id.startsWith('user-'))
  assert.deepEqual(
    mine.map((x) => x.id),
    ['user-b', 'user-a'],
    '用户自建的分类都保留，相对顺序不变',
  )
  assert.ok(
    mine.every((x) => !x.builtin && !isBuiltinProjectCategory(x.id)),
    '用户自建的分类不算内置',
  )
  assert.equal(
    list.filter((x) => isBuiltinProjectCategory(x.id)).length,
    builtinProjectCategories().length,
    '缺的内置分类都补上',
  )

  // 再读一次：仍然是一组内置分类，没有重复
  const again = await collection(name).list()
  assert.deepEqual(again, list)
})

test('内置分类不能删除，自建分类可以删除', async () => {
  const c = collection('delete.json')
  await c.list()
  const [builtin] = builtinProjectCategories()

  // 服务端 DELETE 路由就是这套顺序：先判定，有原因就返回 409，不调 remove
  const err = projectCategoryDeleteError(builtin.id)
  assert.match(err ?? '', /内置分类不能删除/)
  if (!err) await c.remove(builtin.id)
  assert.ok(
    (await c.list()).some((x) => x.id === builtin.id),
    '内置分类还在',
  )

  const mine = await c.create({ name: '我的分类', description: '', workflowId: '' })
  assert.equal(projectCategoryDeleteError(mine.id), null, '自建分类不拦')
  assert.equal(await c.remove(mine.id), true)
  assert.ok(!(await c.list()).some((x) => x.id === mine.id), '自建分类删得掉')
})

test('内置分类改名后标识不丢，仍然不能删', async () => {
  const c = collection('rename.json')
  await c.list()
  const [builtin] = builtinProjectCategories()

  const saved = await c.update(builtin.id, { name: '我改的名字', description: '改过的简介', workflowId: '' })
  assert.equal(saved?.id, builtin.id, 'id 不变')
  assert.equal(saved?.builtin, true, 'builtin 标记保留')
  assert.equal(saved?.name, '我改的名字')
  assert.match(projectCategoryDeleteError(builtin.id) ?? '', /内置分类不能删除/, '改名后仍然不能删')
})
