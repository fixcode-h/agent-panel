/**
 * 诊断报告的环境采集（分析稿 B4，渲染和解析在 shared/bug-env.ts）：交第一份报告时同步取一次。
 * 交报告是工具调用、宿主同步回答，所以 git 命令同步跑、每条限时；取不到的项省略，报告照常交
 */
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BugEnv } from '../../shared/bug-diagnosis-schema.ts'
import { getCli } from '../../shared/clis.ts'
import { gitSync } from './git.ts'
import type { Agent, Task } from '../../shared/schema.ts'
import { COMMIT_FORMAT, ENV_COMMITS, LOCK_FILES, parseCommits, parseDirty } from '../../shared/bug-env.ts'

/** 每条 git 命令最多等这么久：五条加起来也不会让交报告卡住十几秒 */
const GIT_MS = 3000

function git(dir: string, args: string[]): string | undefined {
  const r = gitSync(dir, args, { timeoutMs: GIT_MS, maxBuffer: 2 << 20 })
  return r?.code === 0 ? r.out : undefined
}

/** 操作系统一行：版本名取不到（少见的平台）就只写平台和内核版本 */
function osLine(): string {
  let name = ''
  try {
    name = os.version()
  } catch {
    name = ''
  }
  return [name || os.type(), os.release(), `(${os.arch()})`].filter(Boolean).join(' ')
}

/**
 * dir 是用户的项目目录（不是对话的独立分支：环境说的是用户出问题的那个工作区）。
 * who：CLI 的名字和模型，调用方从任务取
 */
export function collectBugEnv(dir: string, who: { cli: string; model: string }, now = new Date()): BugEnv {
  const env: BugEnv = {
    at: now.toISOString(),
    os: osLine(),
    node: process.version,
    cli: who.cli,
    model: who.model,
    branch: '',
    commits: [],
    dirty: [],
    dirtyMore: 0,
    lock: undefined,
  }
  // 不是 Git 仓库（P4、SVN、没有版本管理）：后面几项都取不到，一条命令就知道，不逐条试
  if (!dir || git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return env
  env.branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? ''
  env.commits = parseCommits(git(dir, ['log', `-${ENV_COMMITS}`, `--format=${COMMIT_FORMAT}`, '--date=short']) ?? '')
  const dirty = parseDirty(git(dir, ['status', '--porcelain']) ?? '')
  env.dirty = dirty.files
  env.dirtyMore = dirty.more
  const lock = LOCK_FILES.find((f) => existsSync(path.join(dir, f)))
  if (lock) {
    const [c] = parseCommits(git(dir, ['log', '-1', `--format=${COMMIT_FORMAT}`, '--date=short', '--', lock]) ?? '')
    if (c) env.lock = { file: lock, hash: c.hash, title: c.title, date: c.date }
  }
  return env
}

/**
 * 这个对话用的 CLI 名字和模型：对话上选了就用对话的，没选用它的 Agent 的；名字取 CLI 定义里的 name（自定义 CLI 没有定义就写 id）
 */
export function bugWho(ctx: { task: Pick<Task, 'cli' | 'model' | 'agentId'>; agents: Agent[] }) {
  const agent = ctx.agents.find((a) => a.id === ctx.task.agentId)
  const cli = ctx.task.cli || agent?.cli || ''
  return { cli: getCli(cli)?.name ?? cli, model: ctx.task.model || agent?.model || '' }
}
