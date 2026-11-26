/**
 * 面板替 Agent 跑一次校验工具（ADR 0086）：改完自动跑、改道代答都走这里。执行走自建工具同一个入口
 * （server/custom-tools/run.ts 的 prepare + execute：参数校验、按 shell 转义、起进程、写日志），不另写一份。
 *
 * 在工具前的钩子回答里跑：CLI 等钩子回答最多 70 秒（CLI 定义的 hooks 超时），所以整次限时 VERIFY_BUDGET_SEC，
 * 超过就停下并写清楚「还没校验完」，不悄悄算通过。按文件一个个跑最多 VERIFY_MAX_FILES 个，
 * role.listFile 的工具把文件写成清单一次跑完
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CustomTool, ToolScope } from '../../../shared/custom-tools/schema.ts'
import { fileParamOf } from '../../../shared/custom-tools/match.ts'
import type { ToolRunResult } from '../../../shared/custom-tools/text.ts'
import type { VerifyOutcome, VerifyRun } from '../../../shared/tool-gateway/verify/types.ts'
import type { VerifyOutput } from '../../../shared/tool-gateway/verify/text.ts'
import { execute, prepare } from '../../custom-tools/run.ts'
import { noteRun } from '../../custom-tools/store.ts'

/** 整次校验最多等几秒：钩子回答 70 秒超时，留出守卫、推送和 CLI 自己的余量 */
export const VERIFY_BUDGET_SEC = 45
/** 按文件一个个跑时最多查几个：再多就只查前面这些，并在说明里写还有几个没查 */
export const VERIFY_MAX_FILES = 10

export interface VerifyWhere {
  projectId?: string
  /** 项目根（文件相对它）；独立分支里是分支目录 */
  root: string
}

export interface VerifyTool {
  tool: CustomTool
  scope: ToolScope
}

interface Acc {
  results: ToolRunResult[]
  notes: string[]
  /** 没跑起来的原因（参数填不上、程序不在） */
  spawn: string
  timedOut: boolean
}

/** 一个参数值：工具在项目根跑就传相对路径（输出好读），在子目录跑传绝对路径（相对路径会跳出它的目录） */
const argOf = (t: CustomTool, root: string, f: string) => ((t.run.cwd || '.') === '.' ? f : path.resolve(root, f))

async function once(t: VerifyTool, args: Record<string, unknown>, w: VerifyWhere, sec: number, acc: Acc) {
  const p = await prepare(t.tool, args, { projectRoot: w.root, scope: t.scope })
  if (p.error) {
    acc.spawn ||= `参数填不上：${p.error}`
    return
  }
  const { result } = await execute(t.tool, p, { projectRoot: w.root, timeoutSec: Math.max(1, Math.floor(sec)) })
  acc.results.push(result)
  if (result.spawnError) acc.spawn ||= result.spawnError
  // 经 shell 跑时程序找不到不算 spawn 出错，是 shell 的退出码：sh 系 127、cmd 9009
  else if (!result.ok && (result.code === 127 || result.code === 9009))
    acc.spawn ||= `程序找不到（退出码 ${result.code}）：${result.tail.at(-1) ?? p.line}`
  if (result.timedOut) acc.timedOut = true
}

/** 清单文件放系统临时目录：面板自己写的文件，不放进用户的项目 */
async function listArg(t: CustomTool, files: string[], w: VerifyWhere) {
  const dir = path.join(tmpdir(), 'agent-panel-verify')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${t.id}-${Date.now()}.txt`)
  await writeFile(file, `${files.map((f) => path.resolve(w.root, f)).join('\n')}\n`)
  return file
}

function outcomeOf(acc: Acc, errors: number): VerifyOutcome {
  if (acc.spawn) return 'spawn'
  if (errors) return 'errors'
  if (acc.timedOut) return 'timeout'
  return acc.results.every((r) => r.ok) ? 'ok' : 'failed'
}

/** 跑一个校验工具查这些文件（相对项目根）；任何情况都返回结果，不抛错 */
export async function runVerify(
  t: VerifyTool,
  files: string[],
  trigger: VerifyRun['trigger'],
  w: VerifyWhere,
  budgetSec = VERIFY_BUDGET_SEC,
): Promise<VerifyOutput> {
  const t0 = Date.now()
  const acc: Acc = { results: [], notes: [], spawn: '', timedOut: false }
  const fileParam = fileParamOf(t.tool)
  const left = () => budgetSec - (Date.now() - t0) / 1000
  const cap = (s: number) => Math.min(t.tool.run.timeoutSec, s)
  try {
    if (!fileParam || !files.length) await once(t, {}, w, cap(left()), acc)
    else if (t.tool.role?.listFile) {
      // 清单在项目外：这个参数按面板自己写的文件放行项目目录的限制
      const tool = {
        ...t.tool,
        params: t.tool.params.map((p) => (p.name === fileParam ? { ...p, inProject: false } : p)),
      }
      await once({ ...t, tool }, { [fileParam]: await listArg(t.tool, files, w) }, w, cap(left()), acc)
    } else {
      const some = files.slice(0, VERIFY_MAX_FILES)
      for (const [i, f] of some.entries()) {
        if (left() < 1) {
          acc.timedOut = true
          acc.notes.push(`超过 ${budgetSec} 秒，还有 ${some.length - i} 个文件没查`)
          break
        }
        await once(t, { [fileParam]: argOf(t.tool, w.root, f) }, w, cap(left()), acc)
        if (acc.spawn) break
      }
      if (files.length > some.length)
        acc.notes.push(`一次最多查 ${VERIFY_MAX_FILES} 个，还有 ${files.length - some.length} 个没查`)
    }
  } catch (e) {
    acc.spawn ||= (e as Error).message
  }
  const errors = acc.results.flatMap((r) => r.errors)
  const ms = Date.now() - t0
  const outcome = outcomeOf(acc, errors.length)
  const last = acc.results.at(-1)
  const note = [
    acc.spawn,
    acc.timedOut && !acc.notes.length ? `限时 ${Math.round(cap(budgetSec))} 秒` : '',
    ...acc.notes,
  ]
    .filter(Boolean)
    .join('；')
  noteRun(t.scope, t.tool.id, w.projectId, {
    at: new Date().toISOString(),
    ok: outcome === 'ok',
    ms,
    summary: errors[0]?.msg ?? note,
  })
  return {
    run: {
      trigger,
      tool: t.tool.id,
      name: t.tool.name,
      files,
      outcome,
      errors: errors.length,
      ms,
      ...(note ? { note } : {}),
      ...(last?.logFile ? { logFile: last.logFile } : {}),
    },
    errors,
    tail: last?.tail ?? [],
  }
}
