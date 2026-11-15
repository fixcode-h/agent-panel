import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gitRaw, gitRun } from './git.ts'

/**
 * 模块文档不先提交（摸底报告第 7 条，2026-11-15 用户定）：开子对话前「文档·模块分析」写的模块 README 留在父对话目录里不提交，
 * 以前它先被提交到用户的主分支上，一份文档就多一个和功能无关的提交。
 * - 开独立分支时（carryModuleDocs）：把父对话目录里没提交的模块 README 拷进子对话的分支目录，子对话照样从文档读起；
 *   它们随子对话的改动一起提交，合回时一起进来。
 * - 合回前（clearCarriedCopies）：父对话目录里那几份没跟踪的副本和分支上的内容一样时先挪开，不然 git 会因为
 *   「未跟踪的文件会被覆盖」拒绝合并；合并没成就原样写回，父对话目录不丢文件。内容不一样的不动，照常按挡路处理
 */
const MODULE_DOC = /(^|\/)modules\/[^/]+\/README\.md$/

/** 父对话目录里没提交的模块 README（新建的、改了没提交的） */
async function pendingDocs(dir: string): Promise<string[]> {
  const r = await gitRun(dir, ['status', '--porcelain', '-uall'])
  if (r.code !== 0) return []
  return String(r.stdout)
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((f) => f && !f.includes(' -> ') && MODULE_DOC.test(f))
}

/** 开独立分支后调用：拷过去的文件（相对路径） */
export async function carryModuleDocs(from: string, to: string): Promise<string[]> {
  const files = await pendingDocs(from)
  const done: string[] = []
  for (const f of files) {
    try {
      await mkdir(path.dirname(path.join(to, f)), { recursive: true })
      await copyFile(path.join(from, f), path.join(to, f))
      done.push(f)
    } catch {
      // 拷不过去只少一份文档：子对话按派单里的路径找不到会自己读源码，不拦开分支
    }
  }
  return done
}

/** 合回前调用：挪开和分支上一样的未跟踪副本，返回写回用的函数（合并没成时调用） */
export async function clearCarriedCopies(target: string, branch: string): Promise<() => Promise<void>> {
  const r = await gitRun(target, ['ls-files', '--others', '--exclude-standard'])
  const untracked =
    r.code === 0
      ? String(r.stdout)
          .split('\n')
          .filter((f) => MODULE_DOC.test(f.trim()))
      : []
  const moved: { file: string; data: Buffer }[] = []
  for (const f of untracked.map((x) => x.trim())) {
    const theirs = await gitRaw(target, ['show', `${branch}:${f}`])
    if (theirs.code !== 0) continue
    const mine = await readFile(path.join(target, f)).catch(() => null)
    if (!mine || !mine.equals(theirs.stdout)) continue
    await rm(path.join(target, f), { force: true })
    moved.push({ file: f, data: mine })
  }
  return async () => {
    for (const m of moved) {
      const p = path.join(target, m.file)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, m.data)
    }
  }
}
