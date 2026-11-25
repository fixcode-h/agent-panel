/**
 * 自建工具的存放（ADR 0082）：
 * - 项目：文档根/AgentPanel/Tools/<id>.json，走 projectData（ADR 0078），P4 工作区里先签出、新文件 add；
 * - 全局：<数据目录>/tools/<id>.json，只在这台电脑上。
 * 同一个 id 两处都有时用项目的，全局那份标成被盖住。读不进来的文件不悄悄跳过，带着原因列出来
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { CustomTool, nextVersion, TOOL_ID, type ToolEntry, type ToolScope } from '../../shared/custom-tools/schema.ts'
import { draftProblems } from '../../shared/custom-tools/expand.ts'
import { DATA_DIR, writeTextAtomic } from '../store.ts'
import { projectData } from '../project-data/index.ts'
import { detectVcs } from '../vcs/detect.ts'
import { p4Runner } from '../p4-split.ts'

export const GLOBAL_TOOLS_DIR = path.join(DATA_DIR, 'tools')

/** 最近一次运行：只在内存里，管理页和提示词排序用 */
const lastRuns = new Map<string, NonNullable<ToolEntry['last']>>() // 模块状态：运行时，丢了只是列表上少个绿点，重启后重新记

const runKey = (scope: ToolScope, id: string, projectId?: string) =>
  `${scope}:${scope === 'project' ? projectId : ''}:${id}`

export function noteRun(
  scope: ToolScope,
  id: string,
  projectId: string | undefined,
  r: NonNullable<ToolEntry['last']>,
) {
  lastRuns.set(runKey(scope, id, projectId), r)
}

export async function projectToolsDir(projectId: string) {
  return (await projectData(projectId, 'Tools')).shared
}

async function readDir(dir: string, scope: ToolScope): Promise<ToolEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: ToolEntry[] = []
  for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
    const file = path.join(dir, n)
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      const r = CustomTool.safeParse(raw)
      if (!r.success) {
        out.push({
          scope,
          file,
          error: `格式不对：${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`,
        })
        continue
      }
      if (`${r.data.id}.json` !== n) {
        out.push({ scope, file, error: `文件名要和 id 一样（id 是 ${r.data.id}）` })
        continue
      }
      out.push({ scope, file, tool: r.data })
    } catch (e) {
      out.push({ scope, file, error: `读不进来：${(e as Error).message}` })
    }
  }
  return out
}

/** 这个项目能用的全部工具（项目的在前）；不在项目里只有全局的 */
export async function listTools(projectId?: string): Promise<{ entries: ToolEntry[]; projectDir?: string }> {
  const projectDir = projectId ? await projectToolsDir(projectId).catch(() => undefined) : undefined
  const own = projectDir ? await readDir(projectDir, 'project') : []
  const global = await readDir(GLOBAL_TOOLS_DIR, 'global')
  const ids = new Set(own.flatMap((e) => (e.tool ? [e.tool.id] : [])))
  const entries = [...own, ...global.map((e) => (e.tool && ids.has(e.tool.id) ? { ...e, shadowed: true } : e))]
  return {
    entries: entries.map((e) => {
      const last = e.tool && lastRuns.get(runKey(e.scope, e.tool.id, projectId))
      return last ? { ...e, last } : e
    }),
    ...(projectDir ? { projectDir } : {}),
  }
}

/** 按 id 找能用的那一个（项目优先）；scope 指定时只找那一处 */
export async function findTool(projectId: string | undefined, id: string, scope?: ToolScope) {
  const { entries } = await listTools(projectId)
  return entries.find((e) => e.tool?.id === id && (scope ? e.scope === scope : !e.shadowed))
}

async function dirOf(scope: ToolScope, projectId?: string) {
  if (scope === 'global') return GLOBAL_TOOLS_DIR
  if (!projectId) throw new Error('不在项目里，只能存成全局工具')
  return projectToolsDir(projectId)
}

/**
 * 保存：同 id 已有时 replace 才更新（版本 +1，旧版本的命令留进历史），否则报错。
 * 版本、历史、时间由面板写，草稿里带的不算
 */
export async function saveTool(input: {
  projectId?: string
  scope: ToolScope
  draft: Record<string, unknown>
  replace: boolean
  note?: string
  by?: string
}): Promise<ToolEntry> {
  const parsed = CustomTool.safeParse({ ...input.draft, version: 1, history: [] })
  if (!parsed.success)
    throw new Error(
      `工具定义不对：${parsed.error.issues.map((i) => `${i.path.join('.') || '（整体）'} ${i.message}`).join('；')}`,
    )
  const tool = parsed.data
  if (!TOOL_ID.test(tool.id)) throw new Error(`id 只能用小写字母、数字和 -，以字母开头：${tool.id}`)
  const problems = draftProblems(tool)
  if (problems.length) throw new Error(problems.join('；'))
  const dir = await dirOf(input.scope, input.projectId)
  const file = path.join(dir, `${tool.id}.json`)
  const old = existsSync(file) ? CustomTool.safeParse(JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))) : null
  if (old && !input.replace) throw new Error(`已经有 id 为 ${tool.id} 的工具了：选「更新它」或换一个 id`)
  const prev = old?.success ? old.data : undefined
  const next = nextVersion(tool, prev, { by: input.by, note: input.note, now: new Date().toISOString() })
  const text = JSON.stringify(next, null, 2) + '\n'
  if (input.scope === 'project') await (await projectData(input.projectId!, 'Tools')).write(file, text)
  else await writeTextAtomic(file, text)
  return { scope: input.scope, file, tool: next }
}

/** 删除：项目工具在 P4 工作区里标记删除（进默认 changelist，由用户决定什么时候提交），别处直接删文件 */
export async function removeTool(projectId: string | undefined, scope: ToolScope, id: string) {
  if (!TOOL_ID.test(id)) return { ok: false, info: `id 不对：${id}` }
  const file = path.join(await dirOf(scope, projectId), `${id}.json`)
  if (!existsSync(file)) return { ok: false, info: `没有这个工具：${id}` }
  if (scope === 'project') {
    const vcs = await detectVcs(path.dirname(file)).catch(() => undefined)
    if (vcs?.vcs === 'p4') {
      const r = await p4Runner(path.dirname(file))(['delete', '-c', 'default', file])
      if (r.ok && !existsSync(file)) return { ok: true, info: '已在 P4 里标记删除（默认 changelist）' }
    }
  }
  await rm(file, { force: true })
  return { ok: true, info: '' }
}

/** 复制到另一个范围；move 时删掉原来的 */
export async function copyTool(
  projectId: string | undefined,
  from: ToolScope,
  id: string,
  to: ToolScope,
  move: boolean,
) {
  const src = await findTool(projectId, id, from)
  if (!src?.tool) throw new Error(`没有这个工具：${id}`)
  const { version: _v, history: _h, ...draft } = src.tool
  const exists = await findTool(projectId, id, to)
  const saved = await saveTool({ projectId, scope: to, draft, replace: !!exists, by: src.tool.createdBy })
  if (move) await removeTool(projectId, from, id)
  return saved
}
