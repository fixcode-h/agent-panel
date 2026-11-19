import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isAssetPath } from '../../shared/projects/cherry-pick-assets.ts'
import { gitRaw, gitRun } from './git.ts'
import { isBinary } from './merge3.ts'

/**
 * Git cherry-pick 遇到冲突时怎么接着搬（用户 2026-11-19 定，取代 2026-11-03 的「停在冲突上留给用户」）：
 * 冲突的提交也要搬过去，不跳过——
 * - 资源文件（按扩展名清单，或内容是二进制）：不解冲突，直接用被搬的那一版覆盖目标（被搬的提交删了它就删掉）
 * - 代码这类文本文件：停下来交给 Agent 解冲突（去掉冲突标记、两边都要的都留着），解完再调一次 cherry_pick（resume）接着搬
 * 只有一个提交在冲突里，资源文件处理完没有文本冲突就直接 --continue，一路搬到底
 */

const git = (cwd: string, ...args: string[]) =>
  // --continue 要写提交说明：用 cherry-pick 准备好的那份（含 -x 那一行），不开编辑器
  gitRun(cwd, args, { timeoutMs: 60_000, env: { ...process.env, GIT_EDITOR: 'true' } })

export type PickRun = { code: number | null; stderr: string }

/** 一次连续搬运的记录：哪些资源文件被覆盖、哪些提交搬过去后是空的（目标里已经是这样） */
export interface PickLog {
  assets: string[]
  empty: string[]
}

export type PickStop =
  | { kind: 'done' }
  /** 停在有文本冲突的提交上：at 是这个提交，files 是要 Agent 解的文件 */
  | { kind: 'text'; at: string; files: string[] }
  /** 不是冲突的失败（没配提交身份之类）：照实写 git 的报错 */
  | { kind: 'error'; stderr: string }

/** 冲突里的文件（有未合并的条目） */
export const unmergedFiles = async (dir: string) =>
  (await git(dir, 'diff', '--name-only', '--diff-filter=U')).stdout.split('\n').filter(Boolean)

/** 是不是资源文件：扩展名在清单里，或者两边任一版是二进制（没法按行合） */
async function isAsset(dir: string, file: string, exts: readonly string[]) {
  if (isAssetPath(file, exts)) return true
  for (const stage of [3, 2]) {
    const r = await gitRaw(dir, ['cat-file', '-p', `:${stage}:${file}`])
    if (r.code === 0 && isBinary(r.stdout)) return true
  }
  return false
}

/** 资源文件用被搬的那一版（cherry-pick 里 theirs 是被搬的提交）；被搬的提交里没有它（删掉了）就删掉 */
async function takeIncoming(dir: string, file: string) {
  const r = await git(dir, 'checkout', '--theirs', '--', file)
  if (r.code !== 0) await git(dir, 'rm', '-q', '-f', '--', file)
  else await git(dir, 'add', '--', file)
}

/** 冲突都处理完了：接着搬；处理完和目标一模一样（没有要提交的）时这个提交是空的，记下来跳过 */
async function continuePick(dir: string, log: PickLog): Promise<PickRun> {
  if ((await git(dir, 'diff', '--cached', '--quiet')).code === 0) {
    const at = (await git(dir, 'rev-parse', '--short', 'CHERRY_PICK_HEAD')).stdout.trim()
    if (at) log.empty.push(at)
    return git(dir, 'cherry-pick', '--skip')
  }
  return git(dir, 'cherry-pick', '--continue')
}

/**
 * 从 first（开始搬 / 接着搬）的结果出发，一路处理冲突：资源文件覆盖后自动接着搬，遇到文本冲突停下。
 * 每一轮都看实际的未合并文件，没有未合并文件的失败按普通失败报
 */
export async function pickThrough(
  dir: string,
  first: PickRun,
  exts: readonly string[],
  log: PickLog,
): Promise<PickStop> {
  let r = first
  while (r.code !== 0) {
    const conflicts = await unmergedFiles(dir)
    if (!conflicts.length) return { kind: 'error', stderr: r.stderr }
    const text: string[] = []
    for (const f of conflicts) {
      if (await isAsset(dir, f, exts)) {
        await takeIncoming(dir, f)
        if (!log.assets.includes(f)) log.assets.push(f)
      } else text.push(f)
    }
    if (text.length) {
      const at = (await git(dir, 'rev-parse', 'CHERRY_PICK_HEAD')).stdout.trim()
      return { kind: 'text', at, files: text }
    }
    r = await continuePick(dir, log)
  }
  return { kind: 'done' }
}

/** 冲突标记还在的文件：Agent 说解完了但标记没删干净时不能 add，否则会把标记提交进目标分支 */
export async function filesWithMarkers(dir: string, files: string[]) {
  const left: string[] = []
  for (const f of files) {
    const text = await readFile(path.join(dir, f), 'latin1').catch(() => '')
    if (/^(<{7}|>{7})( |$)/m.test(text)) left.push(f)
  }
  return left
}

/** Agent 解完文本冲突后：把这些文件记成已解决（删掉的也算），再接着搬 */
export async function resumePick(dir: string, files: string[], exts: readonly string[], log: PickLog) {
  for (const f of files) await git(dir, 'add', '-A', '--', f)
  return pickThrough(dir, await continuePick(dir, log), exts, log)
}

/** 目录里有没有进行中的 cherry-pick */
export const picking = async (dir: string) =>
  (await git(dir, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).code === 0
