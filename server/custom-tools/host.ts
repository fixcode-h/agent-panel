/**
 * 插件用的自建工具入口（ADR 0082，开放给插件的模块）：插件的按钮绑定一个项目工具，
 * 例如 UE 插件 Lua 页的「增量编译」「全编译」各选一个 /createtool 做出来的工具，不再各自配一套命令行。
 *
 * 插件要自己逐行接输出（推给网页、认报错、能停止），所以这里只做到「起好进程」：
 * 找工具 → 校验参数、展开命令（和 Agent 调用、管理页试运行同一份 prepare）→ 按 writes 在 P4 里签出
 * → 按设置选的 shell 起进程并进孤儿登记。只认项目里的工具：插件的绑定存在项目文档根、团队共用，
 * 全局工具只在这台电脑上，同事那边找不到
 */
import type { ChildProcess } from 'node:child_process'
import type { CustomTool, ToolParam } from '../../shared/custom-tools/schema.ts'
import { shellCommand } from '../merge-build.ts'
import { projectOf } from '../project-data/index.ts'
import { currentShell } from '../shells.ts'
import { spawnTracked } from '../exec/tracked.ts'
import { checkoutWrites } from './checkout.ts'
import { prepare } from './run.ts'
import { findTool, listTools, noteRun } from './store.ts'

/** 给插件界面列的一项：选工具的下拉、按参数提示能不能用 */
export interface ProjectToolBrief {
  id: string
  name: string
  summary: string
  version: number
  params: Pick<ToolParam, 'name' | 'label' | 'type' | 'required' | 'desc'>[]
  /** 报错行的正则（命名分组 file、line、msg）：插件认报错用 */
  errorPattern?: string
  /** 算成功的退出码 */
  okExit: number[]
}

const brief = (x: CustomTool): ProjectToolBrief => ({
  id: x.id,
  name: x.name,
  summary: x.summary,
  version: x.version,
  params: x.params.map(({ name, label, type, required, desc }) => ({ name, label, type, required, desc })),
  ...(x.output.errorPattern ? { errorPattern: x.output.errorPattern } : {}),
  okExit: x.output.okExit,
})

/** 这个项目的项目工具；读不进来的带原因列出来（不悄悄跳过），dir 是工具存放的目录 */
export async function projectTools(
  projectId: string,
): Promise<{ tools: ProjectToolBrief[]; broken: { file: string; error: string }[]; dir?: string }> {
  const { entries, projectDir } = await listTools(projectId)
  const own = entries.filter((e) => e.scope === 'project')
  return {
    tools: own.flatMap((e) => (e.tool ? [brief(e.tool)] : [])),
    broken: own.flatMap((e) => (e.error ? [{ file: e.file, error: e.error }] : [])),
    ...(projectDir ? { dir: projectDir } : {}),
  }
}

export interface StartedProjectTool {
  tool: ProjectToolBrief
  /** 展开后的命令行（给人看、写进日志） */
  line: string
  cwd: string
  /** P4 签出的结果（不是 P4 项目或没写 writes 时为空） */
  checkout: string
  child: ChildProcess
}

/**
 * 起一个项目工具：参数不对、工具不在、命令展开不了都抛错，错误文字原样给用户看。
 * 进程的 stdout / stderr、结束和停止（server/exec/tracked 的 stopTree）由调用方管
 */
export async function spawnProjectTool(
  projectId: string,
  id: string,
  args: Record<string, unknown>,
  o: { source: string; title: string; detached?: boolean },
): Promise<StartedProjectTool> {
  const e = await findTool(projectId, id, 'project')
  if (!e?.tool)
    throw new Error(
      e?.error
        ? `项目工具 ${id} 读不进来：${e.error}`
        : `项目里没有 id 为 ${id} 的工具（可能被删了或改了 id）：重新选一个，或用 /createtool 做一个`,
    )
  const tool = e.tool
  const project = await projectOf(projectId)
  const root = project?.path
  const p = await prepare(tool, args, { projectRoot: root, scope: 'project' })
  if (p.error) throw new Error(`项目工具「${tool.name}」（${tool.id}）跑不了：${p.error}`)
  const checkout = root && tool.writes.length ? await checkoutWrites(root, tool.writes) : ''
  const cmd = shellCommand(p.line, process.platform, await currentShell())
  const child = spawnTracked(cmd.command, cmd.args, {
    cwd: p.cwd,
    env: { ...process.env, ...cmd.env },
    windowsVerbatimArguments: cmd.windowsVerbatimArguments,
    detached: o.detached,
    source: o.source,
    title: o.title,
    tag: p.line,
  })
  return { tool: brief(tool), line: p.line, cwd: p.cwd, checkout, child }
}

/** 插件跑完记一笔：「技能与 MCP → 工具」列表上的最近一次运行和 Agent 提示词的排序都用它 */
export function noteProjectToolRun(projectId: string, id: string, r: { ok: boolean; ms: number; summary?: string }) {
  noteRun('project', id, projectId, { at: new Date().toISOString(), ok: r.ok, ms: r.ms, summary: r.summary ?? '' })
}
