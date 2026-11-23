import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Project } from '../../shared/schema.ts'
import { p4Runner } from '../p4-split.ts'
import { DATA_DIR, writeTextAtomic } from '../store.ts'
import { detectVcs } from '../vcs/detect.ts'
import { p4Open, p4WritePlan } from '../vcs/p4-plan.ts'

/**
 * 插件（和面板自己的功能）按项目存数据的统一入口（「可统一能力盘点」第 7 项，开放给插件）：
 * - shared：团队共享的，放 `文档根/AgentPanel/<名字>/`（UE 用户 2026-11-21 定的位置，表格 2026-11-23 跟上），跟文档一起提交；
 * - local：只在这台机器上用的，放 `<数据目录>/project-data/<名字>/<项目 id>/`；
 * - write：原子写入（先写临时文件再改名）；文件在 P4 工作区里时先 p4 edit（已经在别的 changelist 里的不动），
 *   新文件写完 p4 add——和 Agent 改文件的 p4-auto-open 钩子、UE 保存资源同一份签出规则（server/vcs/p4-plan.ts）。
 *   文档根在 P4 外（项目外层的本地目录）时 p4 说「不在 client 里」，什么都不做。
 * 以前 UE、表格各定各的位置、各写一份原子写入，插件写文件时也不知道 P4 的规则。
 */

export interface ProjectDataDeps {
  getProject: (id: string) => Promise<Project | null | undefined>
  docRoot: (p: Project) => Promise<string | undefined>
}

let deps: ProjectDataDeps | undefined // 模块状态：启动时接线一次

export function initProjectData(d: ProjectDataDeps) {
  deps = d
}

/** 名字只许字母数字和 - _ .：插件 id 或功能名，拼进路径不能跳出目录 */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface ProjectData {
  /** 团队共享目录：文档根/AgentPanel/<名字>；项目没有文档根时退回 <项目>/docs/AgentPanel/<名字> */
  shared: string
  /** 本机目录：<数据目录>/project-data/<名字>/<项目 id> */
  local: string
  /** 原子写一个文件（文本或 JSON），P4 工作区里先签出、新文件写完 add */
  write: (file: string, data: string | object) => Promise<void>
}

export async function projectData(projectId: string, name: string): Promise<ProjectData> {
  if (!SAFE.test(name)) throw new Error(`数据目录名不合法：${name}`)
  if (!deps) throw new Error('项目数据入口还没初始化')
  const p = await deps.getProject(projectId)
  if (!p) throw new Error(`没有这个项目：${projectId}`)
  const root = (await deps.docRoot(p).catch(() => undefined)) || path.join(p.path, 'docs')
  return {
    shared: path.join(root, 'AgentPanel', name),
    local: path.join(DATA_DIR, 'project-data', name, encodeURIComponent(projectId)),
    write: (file, data) => writeTracked(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'),
  }
}

/** 原子写入；在 P4 工作区里按签出规则 edit / add。P4 出错不挡写入（文件可写时照写），只是没进 changelist */
export async function writeTracked(file: string, text: string) {
  const abs = path.resolve(file)
  const vcs = await detectVcs(path.dirname(abs)).catch(() => undefined)
  const run = vcs?.vcs === 'p4' ? p4Runner(path.dirname(abs)) : undefined
  const isNew = !existsSync(abs)
  if (run && !isNew) {
    const plan = await p4WritePlan(run, [abs]).catch(() => undefined)
    if (plan?.edit.length) await p4Open(run, 'edit', plan.edit).catch(() => undefined)
  }
  await writeTextAtomic(abs, text)
  if (run && isNew) await p4Open(run, 'add', [abs]).catch(() => undefined)
}
