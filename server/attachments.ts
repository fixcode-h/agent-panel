/**
 * 附件怎么交给 Agent。
 *
 * 只有图片拷一份到对话目录下的 attachments/（`<TASK_FILES_DIR>/<任务 id>/attachments/`，用户 2026-11 定的）：
 * CLI 和模型要稳定读到、显示它，后面几轮还会引用它。对话目录在工作目录之外，所以交给 Agent 的是
 * 那里的绝对路径，由 runner 把对话目录放进 `--add-dir` 放行。不放进项目目录：用户发一张截图，
 * 项目里就多一个未跟踪文件，还可能被提交上去。
 * 文本、代码、PDF、压缩包、音视频这些直接用原来的绝对路径：拷一份既慢又占空间，源文件改了还容易读到旧内容。
 * 粘贴路径引用的已有文件（Attachment.ref）和引用对话原文（Attachment.quote）本来就不拷。
 * 超过上限（MAX_ATTACHMENT_BYTES）的图片也不拷，只用原来的路径。
 *
 * 拷进来的图片记成「源文件 → 对话目录里的绝对路径」的映射（Task.placedAttachments）：
 * 同一张图再次执行时用同一份，不重复拷。旧任务的映射值是任务工作目录里的相对文件名，仍照旧复用；
 * 统计 git 改动时只把这种可能落在工作目录里的值交给排除名单（见 server/exec/git.ts）。
 *
 * 用绝对路径的附件在任务执行目录之外（数据目录的 uploads、项目原目录、对话目录），有的 CLI 要先放行才读得到，
 * 要放行的目录由 attachmentAddDirs 按附件实际位置算出来（见 `--add-dir` / `--include-directories`）。
 */
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { attachChip, isAbsolutePath } from '../shared/composer.ts'
import { MAX_ATTACHMENT_BYTES, type Attachment, type Task } from '../shared/schema.ts'
import { log } from './log.ts'

/** 图片副本放在对话目录下的这个子目录；旧消息里也存成 `attachments/名字`（以前拷在任务目录里，读取时按它找回来） */
export const ATTACH_DIR = 'attachments'

/** 面板拷进对话目录的图片：消息里记的源文件绝对路径 → 对话目录 attachments/ 里的绝对路径（旧任务的值是工作目录里的相对文件名） */
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
// oxlint-disable-next-line no-control-regex -- 故意匹配控制字符（ANSI 转义序列、不可见字符）
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
 * 拷进附件目录：重名时换下一个序号。
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
 * 面板自己往任务工作目录里放的东西（相对路径），统计 git 改动时按它排除（见 server/exec/git.ts）。
 * 新任务拷进的是对话目录里的绝对路径，本来就不在工作目录里，不用排除；
 * 旧任务的值是工作目录里的相对文件名，照旧交给排除名单；旧消息里存着 `attachments/名字` 的也按它补上
 * ——升级后打开旧对话时，当年拷进任务目录的图片不会重新冒进「更改」列表和评审差异。
 */
export function placedFiles(tk: Pick<Task, 'placedAttachments' | 'messages'>): string[] {
  const out = new Set<string>()
  for (const v of Object.values(tk.placedAttachments)) if (!isAbsolutePath(v)) out.add(v)
  for (const m of tk.messages)
    for (const a of m.attachments ?? []) {
      const old = relativeAttachName(a.path)
      if (old) out.add(`${ATTACH_DIR}/${old}`)
    }
  return [...out]
}

/**
 * 把图片附件拷进对话目录的附件目录（dest），返回替换过路径的附件和新拷进来的映射；其它附件原样返回。
 * dest 为空（任务还没有对话目录）时原样返回。
 *
 * 拷进去的给绝对路径：对话目录在 Agent 的工作目录之外，由 runner 放行整个对话目录（见 server/exec/runner.ts）。
 * cwd 是任务的工作目录：已经在里面的文件仍换成相对路径（Agent 的 cwd 就是它），不重复拷一份。
 * known 是这个任务之前已经拷过的映射：同一张图还用原来那份；旧任务记的相对文件名继续照旧复用。
 */
export async function placeAttachments(
  dest: string,
  attachments: Attachment[],
  known: PlacedAttachments = {},
  cwd = '',
): Promise<PlaceResult> {
  if (!dest || !attachments.length) return { attachments, placed: {} }
  // store 给 path.relative 和拼目标路径用（盘根时不能用 stripEnd 后的 `C:`，那会按进程当前目录解析）；
  // storeRoot / workRoot 只用来做前缀比较
  const store = path.resolve(dest)
  const storeRoot = stripEnd(store)
  const work = cwd ? path.resolve(cwd) : ''
  const workRoot = work ? stripEnd(work) : ''
  // 附件目录在第一次发图时建出来；建不出来时照旧把原路径交给 Agent（拷不进去会落到下面的 catch）
  await mkdir(store, { recursive: true }).catch((e) =>
    log.warn('agent', '建附件目录失败', { dir: store, error: (e as Error).message }),
  )
  const taken = new Set<string>()
  const placed: PlacedAttachments = {}
  const out: Attachment[] = []
  for (const a of attachments) {
    // 已经是相对路径的（上一轮放进去的、旧任务）：不再解析、不再拷，避免把相对路径按进程目录解析错
    if (!isAbsolutePath(a.path)) {
      out.push(a)
      continue
    }
    const full = path.resolve(a.path)
    // 已经在附件目录里的（上一轮拷过的）：不重复拷，保留绝对路径
    if (within(full, storeRoot)) {
      out.push({ ...a, path: full })
      continue
    }
    // 已经在工作目录里的（项目里的文件、旧任务拷在任务目录里的）：换成相对路径，Agent 的 cwd 就是它
    if (within(full, workRoot)) {
      out.push({ ...a, path: path.relative(work, full).replace(/\\/g, '/') })
      continue
    }
    // 引用的已有文件（粘贴回来的路径）用原来的路径，不再拷一份；引用卡片的原文直接写进要求里，不用拷
    if (a.ref || a.quote !== undefined) {
      out.push(a)
      continue
    }
    // 只有图片拷一份：CLI 和模型按图片读它；其它文件直接读原始路径
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
    // 这个任务之前已经拷过同一个源文件：直接用原来那份，继续执行时不会越攒越多副本。
    // 新映射是绝对路径；旧任务映射的是工作目录里的相对文件名，那个文件还在就照旧用相对路径
    const before = known[full]
    if (before) {
      const old = isAbsolutePath(before) ? path.resolve(before) : work ? path.resolve(work, before) : ''
      if (old && existsSync(old)) {
        if (isAbsolutePath(before)) taken.add(path.basename(before))
        placed[full] = before
        out.push({ ...a, path: isAbsolutePath(before) ? old : before })
        continue
      }
    }
    try {
      const name = await copyInto(store, full, safeName(a.name), taken)
      taken.add(name)
      const copy = path.join(store, name)
      placed[full] = copy
      out.push({ ...a, path: copy })
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
