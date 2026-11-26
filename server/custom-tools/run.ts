/**
 * 执行一个自建工具（ADR 0082）：校验参数 → 展开命令（按 shell 转义）→ P4 签出会改的文件 → 起进程等结果。
 * 守卫和授权卡由调用方（Agent 的 custom_tool、管理页试运行）在这之前做：人在管理页点试运行不用再弹卡，
 * Agent 调用只在工具设了 confirm 或是草稿试跑时弹卡。完整输出写日志文件，结果只回尾部和报错（ADR 0067）
 */
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CustomTool } from '../../shared/custom-tools/schema.ts'
import { checkArgs, commandTemplate, expandCommand, type BuiltinVars } from '../../shared/custom-tools/expand.ts'
import { parseErrors, type ToolRunResult } from '../../shared/custom-tools/text.ts'
import type { ShellKind } from '../../shared/shells.ts'
import { DATA_DIR } from '../store.ts'
import { currentShell } from '../shells.ts'
import { runShell } from '../merge-build.ts'
import { checkoutWrites } from './checkout.ts'
import { changeDelta, changeStat, changeSummary } from '../vcs/change-stat.ts'

export const TOOL_RUN_DIR = path.join(DATA_DIR, 'tool-runs')
const TAIL = 40
const KEEP = 400

/** 展开好的一次运行：命令行、目录；有 error 时不能执行 */
export interface Prepared {
  line: string
  cwd: string
  shell: ShellKind
  values: Record<string, unknown>
  error?: string
}

/** 引号规则按 shell 家族：Git Bash、WSL 和 sh 一样 */
const family = (id: string): ShellKind => (id === 'powershell' || id === 'cmd' ? id : 'sh')

/** 校验参数、展开命令；脚本正文写成运行时文件，命令里的 {{script}} 换成它的路径 */
export async function prepare(
  tool: CustomTool,
  args: Record<string, unknown> | undefined,
  where: { projectRoot?: string; workDir?: string; docRoot?: string; scope: string },
): Promise<Prepared> {
  const root = where.workDir || where.projectRoot
  const shell = family((await currentShell()).id)
  const cwd = root ? path.resolve(root, tool.run.cwd || '.') : process.cwd()
  const checked = checkArgs(tool, args, root)
  if (checked.errors.length) return { line: '', cwd, shell, values: checked.values, error: checked.errors.join('；') }
  const vars: BuiltinVars = {
    ...(where.projectRoot && { projectRoot: where.projectRoot }),
    ...(root && { workDir: root }),
    ...(where.docRoot && { docRoot: where.docRoot }),
    dataDir: DATA_DIR,
  }
  if (tool.run.script) {
    const file = path.join(TOOL_RUN_DIR, 'scripts', `${where.scope}-${tool.id}.${tool.run.script.ext}`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, tool.run.script.text)
    vars.script = file
  }
  const r = expandCommand(commandTemplate(tool, process.platform), tool, checked.values, shell, vars)
  return { line: r.line, cwd, shell, values: checked.values, ...(r.error ? { error: r.error } : {}) }
}

/** 真跑：签出 → 起进程 → 等结束或超时 → 解析报错、写日志 */
export async function execute(
  tool: CustomTool,
  p: Prepared,
  o: { projectRoot?: string; signal?: AbortSignal; timeoutSec?: number },
): Promise<{ result: ToolRunResult; output: string[] }> {
  const checkout = o.projectRoot && tool.writes.length ? await checkoutWrites(o.projectRoot, tool.writes) : ''
  // 跑前记一次版本管理里的改动，跑完相减：工具改了什么、有没有把共享文件清空，都摆给 Agent（复盘 P0-2）
  const before = o.projectRoot ? await changeStat(o.projectRoot).catch(() => null) : null
  await mkdir(TOOL_RUN_DIR, { recursive: true })
  const logFile = path.join(TOOL_RUN_DIR, `${tool.id}-${Date.now()}.log`)
  const log = createWriteStream(logFile)
  log.write(`# ${tool.name} ${tool.id} v${tool.version}\n# ${p.line}\n# ${p.cwd}\n\n`)
  const lines: string[] = []
  let total = 0
  const started = Date.now()
  const r = await runShell(p.line, p.cwd, {
    timeoutMs: (o.timeoutSec ?? tool.run.timeoutSec) * 1000,
    signal: o.signal,
    onLine: (l) => {
      total++
      log.write(`${l}\n`)
      lines.push(l)
      if (lines.length > KEEP) lines.splice(0, lines.length - KEEP)
    },
  })
  const err = r.stderr.trim() ? r.stderr.trim().split('\n') : []
  for (const l of err) log.write(`${l}\n`)
  await new Promise((res) => log.end(res))
  const all = [...lines, ...err]
  const after = before && o.projectRoot ? await changeStat(o.projectRoot).catch(() => null) : null
  const changes = before && after ? changeSummary(changeDelta(before, after)) : ''
  const ok = !r.spawnError && !r.killed && r.code !== null && tool.output.okExit.includes(r.code)
  return {
    result: {
      ok,
      code: r.code,
      ms: Date.now() - started,
      line: p.line,
      errors: parseErrors(all, tool.output.errorPattern),
      tail: all.slice(-TAIL),
      totalLines: total + err.length,
      logFile,
      ...(checkout ? { checkout } : {}),
      ...(changes ? { changes } : {}),
      ...(r.killed === 'timeout' ? { timedOut: true } : {}),
      ...(r.spawnError ? { spawnError: r.spawnError } : {}),
    },
    output: all.slice(-KEEP),
  }
}
