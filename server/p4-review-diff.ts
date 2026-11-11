/**
 * P4 工作区交给评审的差异：面板用 p4 diff -du 取这个对话改过的文件，和 Git 项目一样把差异放进评审的提示词。
 * 以前 P4 只列文件名，评审要自己去读文件，「加了又删的代码留下的空行」这种只在差异里显眼的问题
 * 几乎没人看得出来（用户 2026-11-11 报：P4 项目里 Agent 删掉自己加的代码后常留下空行）
 */
import type { ReviewDiff } from '../shared/engine-host.ts'
import { p4Runner, type P4Run } from './p4-split.ts'

/** 和 Git 的评审差异同一个上限：再长就存文件，提示词里只给路径 */
const MAX = 60_000
/** 每处改动前后带的行数：太长时退回更少的上下文 */
const CONTEXT = 10
const CONTEXT_SHORT = 3
/** 一次 p4 diff 最多带的文件数：命令行长度有限（Windows 上约 32K 字符） */
const BATCH = 100

/** 差异里改了的文件：p4 diff -du 每个文件以「--- //depot/… 」开头 */
const changedIn = (diff: string) =>
  [...diff.matchAll(/^--- (\/\/[^\t\n]+?)(?:\t|$)/gm)].map((m) => m[1].replace(/#\d+$/, '').trim())

async function diffOf(run: P4Run, files: string[], context: number) {
  const parts: string[] = []
  for (let i = 0; i < files.length; i += BATCH) {
    // 没打开（没 p4 edit 过）的文件 p4 只在 stderr 说一句，不算出错；新加（p4 add）的文件不在差异里
    const r = await run(['diff', `-du${context}`, ...files.slice(i, i + BATCH)])
    if (r.out.trim()) parts.push(r.out.trimEnd())
  }
  return parts.join('\n')
}

/**
 * files 是相对项目根的路径（这个对话改过的、或交接单点名的）。没有改动时 stat 为空。
 * P4 没有「快照」：每次评审都给全部改动，snapshot 留空（复看时也就不按增量取）
 */
export async function p4ReviewDiff(
  cwd: string,
  files: string[],
  run: P4Run = p4Runner(cwd),
): Promise<ReviewDiff & { full: string }> {
  if (!files.length) return { snapshot: '', stat: '', diff: '', full: '' }
  const full = await diffOf(run, files, CONTEXT)
  const changed = changedIn(full)
  // 差异里没有的（新加的文件、没打开过的文件）也列出来：评审知道它们改过，要看就自己读
  const rest = files.filter((f) => !changed.some((d) => d.endsWith(`/${f}`)))
  const stat = [
    ...changed,
    ...(rest.length ? ['（下面这些不在差异里：新加的文件或没 p4 edit 过的，要看直接读文件）', ...rest] : []),
  ].join('\n')
  const diff = full.length <= MAX ? full : await diffOf(run, files, CONTEXT_SHORT)
  return { snapshot: '', stat, diff: diff.length <= MAX ? diff : '', full }
}
