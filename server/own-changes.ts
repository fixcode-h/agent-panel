import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FileChange, Task } from '../shared/schema.ts'
import { placedFiles } from './attachments.ts'
import { gitChanges } from './exec/git.ts'
import { DATA_DIR } from './store.ts'

/** 统一成相对项目根、正斜杠的路径；不在项目里的返回空 */
export function rel(root: string, file: string) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file)
  const r = path.relative(root, abs).split(path.sep).join('/')
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : ''
}

/** dir 或它里面（Windows 盘符大小写不同也算）：path.relative 在 win32 上会忽略盘符大小写 */
function insideOrSame(dir: string, full: string) {
  const r = path.relative(dir, full)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

/** 去重用的键：Windows 上路径大小写不区分 */
const pathKey = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * 项目根之外、这个对话的 Agent 写出过的文件：来自 CLI 的写文件事件（`touched`），统一成绝对路径。
 * 没有 git 快照，所以只记录路径，不能算增删行数、做差异或撤销。
 * 面板自己的产物不算 Agent 改的：数据目录（拷进来的附件、对话目录里的截图和临时文件、任务交接文件）
 * 和系统临时目录。ignore 默认是这两处，测试可以换成自己的目录。
 */
export function outsideFiles(
  root: string,
  files: Iterable<string>,
  opts: { ignore?: readonly string[] } = {},
): string[] {
  const base = path.resolve(root)
  const ignore = (opts.ignore ?? [DATA_DIR, tmpdir()]).map((d) => path.resolve(d))
  const seen = new Set<string>()
  const out: string[] = []
  for (const file of files) {
    const p = (file ?? '').trim()
    if (!p) continue
    const abs = path.resolve(base, p)
    if (insideOrSame(base, abs) || ignore.some((d) => insideOrSame(d, abs))) continue
    const key = pathKey(abs)
    if (seen.has(key)) continue
    seen.add(key)
    // 存正斜杠的绝对路径：界面上显示、按路径再读文件都用它，Windows 上 Node 也认
    out.push(abs.split(path.sep).join('/'))
  }
  return out
}

/** 把项目外的文件并进任务记录（去重）：同一轮里同一个文件会随着每个工具调用被报一次 */
export function mergeOutside(task: Pick<Task, 'outsideChanges'>, files: Iterable<string>) {
  const seen = new Set(task.outsideChanges.map((c) => pathKey(c.path)))
  for (const file of files) {
    const key = pathKey(file)
    if (seen.has(key)) continue
    seen.add(key)
    task.outsideChanges.push({ path: file })
  }
}

/**
 * 这个对话改过的文件（相对项目根）：每轮改动卡片记的文件（撤销过的不算）、改文件的工具调用、更改面板里的改动。
 * 子任务、工作流节点的消息也在 task.messages 里，一并算这个对话的。
 * withChanges 为 false 时不看更改面板（算更改面板本身时用，不然旧的错误记录会一直留着）
 */
export function ownFiles(task: Pick<Task, 'messages' | 'changes'>, root: string, withChanges = true): Set<string> {
  const out = new Set<string>()
  const add = (f: string) => {
    const r = rel(root, f.trim())
    if (r) out.add(r)
  }
  for (const m of task.messages) {
    if (m.turnChanges && !m.turnChanges.revertedAt) for (const f of m.turnChanges.files) add(f.path)
    for (const x of m.tools ?? []) if (x.kind === 'edit' && x.label) add(x.label)
  }
  if (withChanges) for (const c of task.changes ?? []) add(c.path)
  return out
}

/**
 * 「本对话改动」：工作区和对话开始时的提交比出来的差异里，只留这个对话自己改过的文件。
 * 差异本身会把对话期间拉代码（pull、merge、p4 sync 后的提交）、切分支、别的对话在同一目录里的改动都算进来，
 * 一个开得久的对话能列出几百个它根本没碰过的文件。
 * 「自己改过」看每轮改动卡片（已去掉这一轮拉代码带进来的文件）、改文件的工具调用和 extra（这一轮 CLI 报过的写文件）
 */
export async function taskChanges(
  cwd: string,
  task: Pick<Task, 'messages' | 'changes' | 'baseline' | 'baseRef' | 'placedAttachments'>,
  extra: Iterable<string> = [],
): Promise<FileChange[] | null> {
  const all = await gitChanges(cwd, task.baseline, task.baseRef, placedFiles(task))
  if (!all) return null
  const mine = ownFiles(task, cwd, false)
  for (const f of extra) {
    const r = rel(cwd, f)
    if (r) mine.add(r)
  }
  return all.filter((c) => mine.has(c.path))
}
