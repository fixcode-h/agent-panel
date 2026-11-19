import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { migrateProjectShape, migrateTaskShape, migrateWorkflowShape } from '../../shared/migrations/legacy-shapes.ts'
import { DATA_FILES, readJson, writeJsonAtomic } from '../store.ts'
import { MSG_JSONL, MSG_LEGACY, appendMessageLines } from '../tasks/messages-file.ts'
import { taskDirsIn } from './0001-task-layout.ts'
import type { Migration, MigrationCtx } from './index.ts'

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 以前挂在 shared/schema.ts 的 z.preprocess 上、每次读都转一遍的四种旧格式，一次性写回成当前格式
 * （复查清单「schema.ts 把数据定义和历史迁移绑在一起」，转换本身在 shared/migrations/legacy-shapes.ts）：
 * - 工作流（config/workflows.json）：旧版的「阶段」换成流程图
 * - 项目（projects/projects.json）：单层 workflowParams 按工作流分组，测试步骤的 runInParent 换成 scope
 * - 任务记录：步骤补 id、消息的节点下标换成 id、旧 queue 并进对话，记录里的工作流 / 测试步骤快照一起换
 * - 回收站里的工作流和项目（trash/items）：恢复时直接按当前格式读
 * 没有要改的文件不备份、不写盘
 */
export const legacyShapes: Migration = {
  version: 11,
  name: 'legacy-shapes',
  async run(ctx) {
    const wf = await migrateList(ctx, path.join(ctx.dataDir, DATA_FILES['workflows.json']), migrateWorkflowShape)
    const pj = await migrateList(ctx, path.join(ctx.dataDir, DATA_FILES['projects.json']), migrateProjectShape)
    const tk = await migrateTasks(ctx)
    const tr = await migrateTrash(ctx)
    if (wf) ctx.log(`${wf} 个工作流换成了当前格式`)
    if (pj) ctx.log(`${pj} 个项目换成了当前格式`)
    if (tk) ctx.log(`${tk} 个任务记录换成了当前格式`)
    if (tr) ctx.log(`回收站里 ${tr} 个工作流 / 项目换成了当前格式`)
  },
}

/** 一个 JSON 数组文件（工作流、项目列表）：先在拷贝上试，有要改的才备份、写回。返回改了几条 */
async function migrateList(ctx: MigrationCtx, file: string, fix: (x: Raw) => boolean) {
  const list = (await readJson(file).catch(() => undefined)) as unknown
  if (!Array.isArray(list)) return 0
  const n = structuredClone(list).filter((x) => isObj(x) && fix(x)).length
  if (!n) return 0
  await ctx.backup(file)
  for (const x of list) if (isObj(x)) fix(x)
  await writeJsonAtomic(file, list)
  return n
}

/** 任务记录逐个改；旧 queue 并进来的要求同时追加进对话文件（完整对话从那里读，只改记录会看不到） */
async function migrateTasks(ctx: MigrationCtx) {
  let n = 0
  for (const dir of await taskDirsIn(path.join(ctx.dataDir, 'tasks'))) {
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json') || f.endsWith(MSG_LEGACY)) continue
      const file = path.join(dir, f)
      const raw = (await readJson(file).catch(() => undefined)) as unknown
      if (!isObj(raw) || !migrateTaskShape(structuredClone(raw)).changed) continue
      await ctx.backup(file)
      const { queued } = migrateTaskShape(raw)
      const jsonl = path.join(dir, f.slice(0, -'.json'.length) + MSG_JSONL)
      // 先追加对话再写记录：中途断掉下次重跑会再追加一遍同样 id 的几行，读对话文件时按 id 去重，不会重复
      if (queued.length && existsSync(jsonl)) {
        await ctx.backup(jsonl)
        await appendMessageLines(jsonl, queued.map((m) => JSON.stringify(m) + '\n').join(''))
      }
      await writeJsonAtomic(file, raw)
      n++
    }
  }
  return n
}

/** 回收站里的工作流和项目：每个一个文件，item 是删掉时的原样 */
async function migrateTrash(ctx: MigrationCtx) {
  const dir = path.join(ctx.dataDir, 'trash', 'items')
  let n = 0
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!f.endsWith('.json')) continue
    const file = path.join(dir, f)
    const row = (await readJson(file).catch(() => undefined)) as unknown
    if (!isObj(row) || !isObj(row.item)) continue
    const fix = row.kind === 'workflow' ? migrateWorkflowShape : row.kind === 'project' ? migrateProjectShape : null
    if (!fix || !fix(structuredClone(row.item))) continue
    await ctx.backup(file)
    fix(row.item)
    await writeJsonAtomic(file, row)
    n++
  }
  return n
}
