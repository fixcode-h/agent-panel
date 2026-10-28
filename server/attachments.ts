/**
 * 附件怎么交给 Agent。
 *
 * 只有图片拷一份到任务执行目录（对话目录）根下：CLI 和模型要稳定读到、显示它，后面几轮还会引用它，
 * 而且拷进来之后路径就是相对任务目录的文件名，不用放行工作目录以外的位置。
 * 文本、代码、PDF、压缩包、音视频这些直接用原来的绝对路径：拷一份既慢又占空间，源文件改了还容易读到旧内容。
 * 粘贴路径引用的已有文件（Attachment.ref）和引用对话原文（Attachment.quote）本来就不拷。
 * 超过上限（MAX_ATTACHMENT_BYTES）的图片也不拷，只用原来的路径。
 *
 * 拷进来的图片记成「源文件 → 对话目录里的文件名」的映射（Task.placedAttachments）：
 * 统计 git 改动时按它排除面板自己放进来的图片（见 server/exec/git.ts），同一张图再次执行时也用同一份，不重复拷。
 *
 * 用绝对路径的附件在任务执行目录之外（数据目录的 uploads、项目原目录），有的 CLI 要先放行才读得到，
 * 要放行的目录由 attachmentAddDirs 按附件实际位置算出来（见 `--add-dir` / `--include-directories`）。
 */
import { constants, existsSync } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { attachChip, isAbsolutePath } from '../shared/composer.ts'
import { MAX_ATTACHMENT_BYTES, type Attachment, type Task } from '../shared/schema.ts'

/** 旧版本放图片的子目录：旧消息里存成 `attachments/名字`，读取时仍按它找回来 */
export const ATTACH_DIR = 'attachments'

/** 面板拷进对话目录的图片：消息里记的源文件绝对路径 → 对话目录里的文件名 */
export type PlacedAttachments = Record<string, string>

/** 放置结果：交给 Agent 的附件（路径换成对话目录里的），以及这次新拷进来的映射（调用方并进任务） */
export interface PlaceResult {
  attachments: Attachment[]
  placed: PlacedAttachments
}

/**
 * 去掉末尾的分隔符，但保留根本身：`C:\` → `C:`、`/` → `/`。
 * 不能直接去掉所有尾分隔符：盘根 `/` 会变成空串，后面的「在不在这个目录里」判断整段短路。
 */
const stripEnd = (p: string) => p.replace(/(.)[\\/]+$/, '$1')

/** full 在 dir 里（dir 是 stripEnd 过的，根目录本身也算在里面）；不拼 `dir + path.sep`，根上不会多出分隔符 */
const within = (full: string, dir: string) =>
  !!dir && (full === dir || full.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep))

/**
 * 消息里存成任务目录相对路径的旧附件（`attachments/名字`）：返回文件名，不是这种路径时返回空。
 * 以前的消息里记录的是拷进任务目录的那一份，读取时要按名字回上传目录找，清理附件时也要靠它保住那一份。
 * 只认一级文件名：带 `..`、多级目录、绝对路径的都不算。
 */
export function relativeAttachName(p: string): string {
  const rel = (p ?? '').replace(/\\/g, '/')
  if (!rel.startsWith(`${ATTACH_DIR}/`)) return ''
  const name = rel.slice(ATTACH_DIR.length + 1)
  return name && !name.includes('/') && !/^\.\.?$/.test(name) ? name : ''
}

/** 文件名里去掉路径和系统不允许的字符（和上传时一致，名字对得上） */
const safeName = (n: string) => path.basename(n).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'file'

/** 第 i 个候选名：第一个用原名，之后加序号（`note (2).png`） */
function candidateName(name: string, i: number) {
  if (i === 1) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `${stem} (${i})${ext}`
}

/**
 * 拷进对话目录根：重名时换下一个序号。
 * 用 COPYFILE_EXCL 把「检查」和「写入」合成一步——目录里本来就有的文件（项目里的同名文件、
 * 之前别处拷过的一份）、以及并发时刚好写进来的同名文件都不会被覆盖，不会出现检查完再被顶掉。
 */
async function copyInto(base: string, full: string, name: string, taken: Set<string>) {
  for (let i = 1; ; i++) {
    const next = candidateName(name, i)
    if (taken.has(next)) continue
    try {
      await copyFile(full, path.join(base, next), constants.COPYFILE_EXCL)
      return next
    } catch (e) {
      // 目标名已经存在（检查之后才出现的）：换下一个序号，别覆盖
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
  }
}

/**
 * 面板自己往对话目录里放的东西（相对对话目录的路径），统计 git 改动时按它排除（见 server/exec/git.ts）。
 * 新任务按 placedAttachments 记的文件名；旧任务没有这个字段，但消息里存着 `attachments/名字`，
 * 按它补上——升级后打开旧对话时，当年拷进子目录的图片不会重新冒进「更改」列表和评审差异。
 */
export function placedFiles(tk: Pick<Task, 'placedAttachments' | 'messages'>): string[] {
  const out = new Set(Object.values(tk.placedAttachments))
  for (const m of tk.messages)
    for (const a of m.attachments ?? []) {
      const old = relativeAttachName(a.path)
      if (old) out.add(`${ATTACH_DIR}/${old}`)
    }
  return [...out]
}

/**
 * 把图片附件拷进任务执行目录根，返回替换过路径的附件和新拷进来的映射；其它附件原样返回。
 * dir 为空（任务还没有执行目录）时原样返回。
 *
 * 拷进去的写成相对文件名：Agent 就在这个目录里跑，相对路径它直接能读。
 * known 是这个任务之前已经拷过的映射：同一张图还用原来那份，不再拷出 `截图 (2).png` 这种副本。
 */
export async function placeAttachments(
  dir: string,
  attachments: Attachment[],
  known: PlacedAttachments = {},
): Promise<PlaceResult> {
  if (!dir || !attachments.length) return { attachments, placed: {} }
  // base 给 path.relative 算相对路径（盘根时不能用 stripEnd 后的 `C:`，那会按进程当前目录解析），
  // root 只用来做前缀比较
  const base = path.resolve(dir)
  const root = stripEnd(base)
  const taken = new Set<string>()
  const placed: PlacedAttachments = {}
  const out: Attachment[] = []
  for (const a of attachments) {
    // 已经是相对路径的（上一轮放进去的）：不再解析、不再拷，避免把相对路径按进程目录解析错
    if (!isAbsolutePath(a.path)) {
      out.push(a)
      continue
    }
    const full = path.resolve(a.path)
    // 已经在任务目录里的（上一轮拷过的、引入会话生成的）不再拷一遍，只把路径换成相对的
    if (within(full, root)) {
      out.push({ ...a, path: path.relative(base, full).replace(/\\/g, '/') })
      continue
    }
    // 引用的已有文件（粘贴回来的路径）用原来的路径，不再拷一份；引用卡片的原文直接写进要求里，不用拷
    if (a.ref || a.quote !== undefined) {
      out.push(a)
      continue
    }
    // 只有图片拷一份：CLI 和模型按图片读它，路径要相对任务目录；其它文件直接读原始路径
    if (attachChip(a) !== 'image') {
      out.push(a)
      continue
    }
    const size =
      a.size ||
      (await stat(full)
        .then((s) => s.size)
        .catch(() => 0))
    if (size > MAX_ATTACHMENT_BYTES) {
      out.push(a)
      continue
    }
    // 这个任务之前已经拷过同一个源文件：直接用原来那份，继续执行时不会越攒越多副本
    const before = known[full]
    if (before && existsSync(path.join(base, before))) {
      taken.add(before)
      placed[full] = before
      out.push({ ...a, path: before })
      continue
    }
    try {
      const name = await copyInto(base, full, safeName(a.name), taken)
      taken.add(name)
      placed[full] = name
      out.push({ ...a, path: name })
    } catch {
      // 源文件已经不在了（比如清缓存时删掉）：留着原来的路径，让 Agent 自己报找不到
      out.push(a)
    }
  }
  return { attachments: out, placed }
}

/**
 * 交给 Agent 之后要放行的目录（工作目录之外还要能读的位置）。
 * 上传的文件在数据目录的 uploads 下，合并成 uploads 根一个目录；粘贴路径引用的项目文件各不相同，
 * 各自放行它所在的目录。任务目录里的（图片拷进来的那份）和相对路径不用放行。
 */
export function attachmentAddDirs(
  attachments: readonly Attachment[],
  opts: { cwd?: string; uploadsRoot?: string } = {},
): string[] {
  const root = opts.cwd ? stripEnd(path.resolve(opts.cwd)) : ''
  const uploads = opts.uploadsRoot ? path.resolve(opts.uploadsRoot) : ''
  const uploadsRoot = uploads ? stripEnd(uploads) : ''
  let needUploads = false
  const dirs = new Set<string>()
  for (const a of attachments) {
    if (!a.path || !isAbsolutePath(a.path)) continue
    const full = path.resolve(a.path)
    if (within(full, root)) continue
    if (within(full, uploadsRoot)) {
      needUploads = true
      continue
    }
    dirs.add(path.dirname(full))
  }
  return [...(needUploads ? [uploads] : []), ...dirs]
}
