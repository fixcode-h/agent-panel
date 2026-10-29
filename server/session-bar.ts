/**
 * 会话栏（对话页右栏，照 Claude Code 的会话栏）要现读的本机信息：
 * 环境（目录、仓库、分支）、上下文细分里的说明文件和 Skill、这个对话新建的文件（输出内容）。
 * 上下文的总占用、面板工具这些在任务上（AgentUsage），不在这里读。
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getCli } from '../shared/clis.ts'
import { CliContextBase } from '../shared/context-breakdown.ts'
import type { SessionInfo, Task } from '../shared/schema.ts'
import { expandHome, listSkills } from './cli-extras.ts'
import { capture } from './exec/process.ts'

const git = (cwd: string, ...args: string[]) => capture('git', ['-c', 'core.quotepath=off', ...args], cwd)

/** 说明文件太大时只看大小，不读内容（读进来也只为了数 @ 引用） */
const DOC_READ_MAX = 512 * 1024

/** Skill 列表要起 CLI（Codex 走 app-server）或扫目录：同一个 CLI + 目录一分钟内复用 */
const SKILL_TTL = 60_000
const skillCache = new Map<string, { at: number; list: Promise<{ name: string; chars: number }[]> }>()

async function skillsOf(cli: string, cwd: string) {
  const key = `${cli}\n${cwd}`
  const hit = skillCache.get(key)
  if (hit && Date.now() - hit.at < SKILL_TTL) return hit.list
  // CLI 只把 Skill 的名字和描述放进上下文，正文用到时才读
  const list = listSkills(cli, cwd)
    .then((xs) =>
      xs.filter((s) => s.enabled).map((s) => ({ name: s.name, chars: s.name.length + s.description.length })),
    )
    .catch(() => [])
  skillCache.set(key, { at: Date.now(), list })
  return list
}

/** 读一个说明文件：不存在返回 null；Claude Code 的 @引用（单独一行的 @路径）展开一层 */
async function docFile(full: string, shown: string, imports: boolean) {
  const s = await stat(full).catch(() => null)
  if (!s?.isFile()) return null
  const out = [{ path: shown, chars: s.size }]
  if (!imports || s.size > DOC_READ_MAX) return out
  const text = await readFile(full, 'utf8').catch(() => '')
  out[0].chars = text.length
  for (const m of text.matchAll(/^@(\S+)\s*$/gm)) {
    const ref = path.resolve(path.dirname(full), expandHome(m[1]))
    const r = await stat(ref).catch(() => null)
    if (r?.isFile())
      out.push({ path: path.relative(path.dirname(full), ref).split(path.sep).join('/') || m[1], chars: r.size })
  }
  return out
}

/** 这个 CLI 启动时会读的说明文件（项目里的 + 用户目录的全局说明） */
async function memoryFiles(cli: string, cwd: string) {
  const def = getCli(cli)
  if (!def) return []
  const base = CliContextBase.parse(def.context ?? {})
  const out: { path: string; chars: number }[] = []
  for (const name of def.docs) {
    const got = cwd ? await docFile(path.join(cwd, name), name, base.docsImports) : null
    if (!got) continue
    out.push(...got)
    if (base.docsMode === 'first') break
  }
  if (def.globalDoc) {
    const full = expandHome(def.globalDoc)
    const got = await docFile(full, def.globalDoc.replace(/\$\{[^}]*:-([^}]*)\}/g, '$1'), base.docsImports)
    if (got) out.push(...got)
  }
  return out
}

/** 仓库名：origin 的地址写成「owner/repo」，没有远端时用目录名 */
async function repoName(cwd: string) {
  const r = await git(cwd, 'remote', 'get-url', 'origin')
  const url = r.code === 0 ? r.stdout.trim() : ''
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
  return m ? m[1] : ''
}

/** 改动里这个对话新建的文件（和开始时的提交比是新增的，或者还没跟踪）：会话栏的「输出内容」 */
async function newFiles(cwd: string, task: Pick<Task, 'baseRef' | 'changes'>) {
  if (!task.changes.length) return []
  const base =
    task.baseRef && (await git(cwd, 'cat-file', '-e', `${task.baseRef}^{commit}`)).code === 0 ? task.baseRef : 'HEAD'
  const added = await git(cwd, 'diff', '--name-only', '--diff-filter=A', base)
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard')
  const fresh = new Set([...added.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))
  return task.changes.map((c) => c.path).filter((p) => fresh.has(p))
}

export async function sessionInfo(
  task: Pick<Task, 'baseRef' | 'changes' | 'imported'>,
  dir: string,
  cli: string,
): Promise<SessionInfo> {
  const ok = !!dir && !task.imported && !!(await stat(dir).catch(() => null))?.isDirectory()
  const cwd = ok ? dir : ''
  const inside = cwd ? await git(cwd, 'rev-parse', '--is-inside-work-tree') : null
  const isGit = inside?.code === 0 && inside.stdout.trim() === 'true'
  const [repo, branch, memory, skills, outputs] = await Promise.all([
    isGit ? repoName(cwd) : '',
    isGit ? git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').then((r) => (r.code === 0 ? r.stdout.trim() : '')) : '',
    cli ? memoryFiles(cli, cwd) : [],
    cli && getCli(cli) ? skillsOf(cli, cwd) : [],
    isGit ? newFiles(cwd, task).catch(() => []) : [],
  ])
  return { dir, repo: repo || (dir ? path.basename(dir) : ''), branch, isGit, memory, skills, outputs }
}
