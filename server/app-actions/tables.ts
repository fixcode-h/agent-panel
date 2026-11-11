import { z } from 'zod'
import type { TableDoc, TableSchema, TablesIndex } from '../../shared/tables.ts'
import { checkTouched, headerOf, workbookNeeds } from '../../shared/table-struct.ts'
import { TableEditInput, TableQueryInput, planEdit, queryRows } from '../../shared/table-agent.ts'
import type { TablesCheck } from '../tables/check.ts'
import { ActionError, defineAction, type ActionCtx } from './registry.ts'

/**
 * 表格这一组（游戏配置表）：列出表格、按字段查行、按主键改格子 / 增删行、整个项目检查。
 * 读写走表格页的同一套接口：改动只写这些格子，文件仍是原来的 Excel / WPS 格式，写之前自动备份；
 * 写之前按项目的表格结构（枚举、引用、范围、主键）检查，不合规的拦下并说明。
 */

const enc = encodeURIComponent
const PID = z.string().optional().describe('项目 id；不写就是你所在的项目')

const pidOf = (id: string | undefined, ctx: ActionCtx) => {
  const pid = id || ctx.caller?.projectId
  if (!pid) throw new ActionError('要写 projectId：没有对话上下文时得指明是哪个项目')
  return pid
}

async function openSheet(pid: string, path: string, sheet: string | undefined, ctx: ActionCtx) {
  const doc = (await ctx.api('GET', `/tables/${enc(pid)}/file?path=${enc(path)}`)) as TableDoc
  if (doc.kind === 'xls') throw new ActionError('老的 .xls 只能读不能在这里改，用 Excel / WPS 另存为 .xlsx')
  const s = sheet ? doc.sheets.find((x) => x.name === sheet) : doc.sheets[0]
  if (!s) throw new ActionError(`没有工作表「${sheet}」。有：${doc.sheets.map((x) => x.name).join('、')}`)
  const schema = (await ctx.api('GET', `/tables/${enc(pid)}/schema`)) as TableSchema
  return { doc, sheet: s, schema, header: headerOf(schema, path, s) }
}

/** 写之前按表格结构查改到的格子，不合规就拦下、原因交给模型 */
async function mustPass(
  pid: string,
  path: string,
  doc: TableDoc,
  name: string,
  schema: TableSchema,
  plan: ReturnType<typeof planEdit>,
  ctx: ActionCtx,
) {
  const after = { name, rows: plan.after }
  const need = workbookNeeds(schema, path, [after])
  const ext: Record<string, TableDoc['sheets'] | undefined> = {}
  for (const f of need)
    ext[f] = ((await ctx.api('GET', `/tables/${enc(pid)}/file?path=${enc(f)}`).catch(() => null)) as TableDoc | null)
      ?.sheets
  const bad = checkTouched(schema, path, after, plan.touched, (f) =>
    f === path ? doc.sheets.map((s) => (s.name === name ? after : s)) : ext[f],
  )
  if (bad.length)
    throw new ActionError(
      `没有写：${bad.length} 处不符合表格结构\n${bad
        .slice(0, 30)
        .map((p) => `- 第 ${p.r + 1} 行 ${p.field}：${p.msg}`)
        .join('\n')}\n改对后再提交；用户明确要求照写时加 force: true`,
    )
}

export const tableActions = [
  defineAction({
    name: 'table.list',
    title: '列出表格',
    description: '列出项目表格目录（项目设置 → 表格）里的配置表：相对路径、格式。改表格前先用它找文件。',
    level: 'read',
    input: z.object({ projectId: PID }),
    run: async (a, ctx) => {
      const r = (await ctx.api('GET', `/tables/${enc(pidOf(a.projectId, ctx))}`)) as TablesIndex
      if (!r.dirs.length && !r.files.length) throw new ActionError('这个项目还没设表格目录（项目设置 → 表格）')
      return { dirs: r.dirs, files: r.files.map((f) => `${f.path}${f.kind === 'xls' ? '（只读）' : ''}`) }
    },
  }),
  defineAction({
    name: 'table.sample',
    title: '看一张表的表头',
    description:
      '读一张配置表的表头和前几行数据（制表符分隔，行号从 1 数），以及这张表里各个类型名出现过的值。AI 分析表格风格时一张一张用它看，不要自己写脚本解析 xlsx。',
    level: 'read',
    input: z.object({ projectId: PID, path: z.string().min(1).describe('表格的路径（table.list 列出来的）') }),
    run: async (a, ctx) =>
      (await ctx.api('GET', `/tables/${enc(pidOf(a.projectId, ctx))}/sample?path=${enc(a.path)}`)) as {
        text: string
      },
  }),
  defineAction({
    name: 'table.query',
    title: '查表格里的行',
    description:
      '按字段名查一张配置表：返回字段列表、主键字段、匹配的行（Excel 行号 + 字段值）。表头按项目的表格结构识别，不用自己数第几行。读 xlsx 用它，不要自己写脚本解析。',
    level: 'read',
    input: TableQueryInput.extend({ projectId: PID }),
    run: async (a, ctx) => {
      const pid = pidOf(a.projectId, ctx)
      const { sheet, schema, header } = await openSheet(pid, a.path, a.sheet, ctx)
      return { sheet: sheet.name, ...queryRows(sheet.rows, header, schema.style.key, a) }
    },
  }),
  defineAction({
    name: 'table.edit',
    title: '改表格',
    description:
      '按主键（或 Excel 行号）改一张配置表的格子、在末尾加行、删行。只写这些格子，样式、公式、其它工作表原样保留，文件格式不变，写之前自动备份。' +
      '按项目的表格结构检查（类型、枚举、引用、范围、主键重复），有问题时不写并列出原因。改 xlsx 一律用它，不要用 openpyxl 之类整本重写。',
    level: 'write',
    input: TableEditInput.extend({ projectId: PID }),
    run: async (a, ctx) => {
      const pid = pidOf(a.projectId, ctx)
      const { doc, sheet, schema, header } = await openSheet(pid, a.path, a.sheet, ctx)
      if (!a.set.length && !a.add.length && !a.remove.length) throw new ActionError('set、add、remove 至少写一项')
      const key = schema.style.key
      let plan
      try {
        plan = planEdit(sheet.rows, header, key, sheet.name, a)
      } catch (e) {
        throw new ActionError((e as Error).message)
      }
      if (!a.force) await mustPass(pid, a.path, doc, sheet.name, schema, plan, ctx)
      await ctx.api('POST', `/tables/${enc(pid)}/save`, { path: a.path, mtime: doc.mtime, sheets: [plan.edit] })
      return {
        saved: a.path,
        sheet: sheet.name,
        cells: plan.touched.length,
        added: a.add.length,
        removed: plan.removed,
        note: '只改了这些格子，文件格式没变；改之前的文件备份在面板的数据目录（tables-backup）。',
      }
    },
  }),
  defineAction({
    name: 'table.propose',
    title: '提议改表格（给用户确认）',
    description:
      '和 table.edit 参数一样，但不写文件：按表格结构检查通过后，把改动交给用户在表格页里看差异、确认后再放进表格保存。' +
      '用户从表格页让你「照着描述加几行」「修检查出的问题」时用它，不要用 table.edit。note 用一两句话说明改了什么、依据是什么。同一张表再提会替换上一份。',
    level: 'read',
    input: TableEditInput.extend({
      projectId: PID,
      note: z.string().max(2000).default('').describe('给用户看的说明：改了什么、为什么'),
    }),
    run: async (a, ctx) => {
      const pid = pidOf(a.projectId, ctx)
      const { doc, sheet, schema, header } = await openSheet(pid, a.path, a.sheet, ctx)
      if (!a.set.length && !a.add.length && !a.remove.length) throw new ActionError('set、add、remove 至少写一项')
      let plan
      try {
        plan = planEdit(sheet.rows, header, schema.style.key, sheet.name, a)
      } catch (e) {
        throw new ActionError((e as Error).message)
      }
      if (!a.force) await mustPass(pid, a.path, doc, sheet.name, schema, plan, ctx)
      await ctx.api('POST', `/tables/${enc(pid)}/proposal`, {
        path: a.path,
        mtime: doc.mtime,
        edit: plan.edit,
        note: a.note,
        cells: plan.touched.length,
        added: a.add.length,
        removed: plan.removed,
      })
      return {
        proposed: a.path,
        sheet: sheet.name,
        cells: plan.touched.length,
        added: a.add.length,
        removed: plan.removed,
        note: '还没写进文件：用户在表格页看过差异、确认后才会放进表格。告诉用户去表格页看「AI 提的改动」。',
      }
    },
  }),
  defineAction({
    name: 'table.check',
    title: '检查全部表格',
    description:
      '按项目的表格结构把所有配置表查一遍（类型、枚举、引用、范围、主键重复），按文件和工作表列出前几处问题。',
    level: 'read',
    input: z.object({ projectId: PID }),
    run: async (a, ctx) => {
      const r = (await ctx.api('GET', `/tables/${enc(pidOf(a.projectId, ctx))}/check`)) as TablesCheck
      return {
        files: r.files,
        failed: r.failed,
        problems: r.sheets.map((s) => ({
          path: s.path,
          sheet: s.sheet,
          count: s.count,
          first: s.first.slice(0, 10).map((p) => `第 ${p.r + 1} 行 ${p.field}：${p.msg}`),
        })),
      }
    },
  }),
]
