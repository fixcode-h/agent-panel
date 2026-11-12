/**
 * 评审差异里的二进制文件换成语义差异（UE 2）：按扩展名交给开着的插件的文本化接口（ServerPlugin.textify）——
 * 插件自己写差异（diff，例如表格插件按格子比）或转成文本后面板逐行比。两版内容从 git 快照或 p4 的 have 版本取。
 * 没人认领的二进制文件不处理，评审只在文件列表里看到它。拼文字见 shared/review/semantic.ts
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { semanticSection, lineDiffText, type SemanticPart } from '../../shared/review/semantic.ts'
import type { Project } from '../../shared/schema.ts'
import { textifierFor } from '../plugins/runtime.ts'
import { blobAt, gitRun } from './git.ts'
import { vcsRun } from './vcs-run.ts'

/** 一次评审最多整理这么多个二进制文件：一次改几百张表时只看前面的，其余评审按文件列表自己看 */
const MAX_FILES = 30

/** 取一版内容：null 是这一版没有这个文件 */
type Load = (file: string) => Promise<Buffer | null>

const extOf = (file: string) => path.extname(file).slice(1).toLowerCase()

/** 这个文件有没有开着的插件认领 */
export function claimed(file: string) {
  return !!textifierFor(extOf(file))
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 对话所在的项目：插件按它读项目自己的设置（例如表格插件的表头规则） */
export type SemanticProject = Pick<Project, 'id' | 'path'>

async function partOf(
  file: string,
  cwd: string,
  project: SemanticProject,
  old: Load,
  next: Load,
): Promise<SemanticPart> {
  const tx = textifierFor(extOf(file))
  if (!tx) return { path: file, how: '', text: '', error: '没有开着的插件认领这个扩展名' }
  const how = tx.how ?? `插件 ${tx.id} 转成文本后逐行比较`
  const f = { path: file, cwd, project: { id: project.id, path: project.path } }
  try {
    const [a, b] = await Promise.all([old(file), next(file)])
    if (tx.diff) return { path: file, how, text: String(await tx.diff(f, a, b)) }
    const conv = async (side: 'old' | 'new', buf: Buffer | null) =>
      buf ? String(await tx.text({ ...f, side, data: buf })) : ''
    const [ta, tb] = await Promise.all([conv('old', a), conv('new', b)])
    const text = !a ? `新建的文件：\n${tb}` : !b ? `删掉的文件（原来的内容）：\n${ta}` : lineDiffText(ta, tb)
    return { path: file, how, text }
  } catch (e) {
    return { path: file, how, text: '', error: errText(e) }
  }
}

/** 按认领筛文件、逐个整理，拼成提示词里的一节；一个都没有时返回空串 */
export async function semanticFor(files: string[], cwd: string, project: SemanticProject, old: Load, next: Load) {
  const mine = files.filter(claimed)
  const parts: SemanticPart[] = []
  for (const f of mine.slice(0, MAX_FILES)) parts.push(await partOf(f, cwd, project, old, next))
  const more = mine.length - parts.length
  const section = semanticSection(parts)
  return section && more > 0 ? `${section}\n\n（还有 ${more} 个二进制文件没整理，按文件列表自己看）` : section
}

/** Git：两棵快照树之间改了的文件（files 给了就只看这些） */
export async function gitSemantic(
  cwd: string,
  from: string,
  to: string,
  files: string[] | undefined,
  project: SemanticProject,
) {
  const scope = files ? ['--', ...files] : ['--', '.']
  const r = await gitRun(cwd, ['diff', '--name-only', '--no-renames', from, to, ...scope])
  const changed = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!changed.some(claimed)) return ''
  return semanticFor(
    changed,
    cwd,
    project,
    (f) => blobAt(cwd, from, f),
    (f) => blobAt(cwd, to, f),
  )
}

/** p4 print 说没有这一版（新加的文件、不在 client 里）：当作改动前没有这个文件 */
const P4_MISSING = /no such file|not on client|not in client view|file\(s\) not/i

/** P4：改动前是工作区的 have 版本（p4 print），改动后是磁盘上的文件 */
export async function p4Semantic(cwd: string, files: string[], project: SemanticProject) {
  if (!files.some(claimed)) return ''
  const old: Load = (f) =>
    vcsRun('p4', ['print', '-q', `${f}#have`], cwd).catch((e: unknown) => {
      if (P4_MISSING.test(errText(e))) return null
      throw e
    })
  const next: Load = (f) => readFile(path.join(cwd, f)).catch(() => null)
  return semanticFor(files, cwd, project, old, next)
}
