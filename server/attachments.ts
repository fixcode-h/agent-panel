/**
 * 附件怎么交给 Agent。
 *
 * 只有图片拷一份到任务目录的 <执行目录>/attachments/：CLI 和模型要稳定读到、显示它，后面几轮还会引用它，
 * 而且拷进来之后路径是相对任务目录的，不用放行工作目录以外的位置。
 * 文本、代码、PDF、压缩包、音视频这些直接用原来的绝对路径：拷一份既慢又占空间，源文件改了还容易读到旧内容。
 * 粘贴路径引用的已有文件（Attachment.ref）和引用对话原文（Attachment.quote）本来就不拷。
 * 超过上限（MAX_ATTACHMENT_BYTES）的图片也不拷，只用原来的路径。
 *
 * 用绝对路径的附件在任务执行目录之外（数据目录的 uploads、项目原目录），有的 CLI 要先放行才读得到，
 * 要放行的目录由 attachmentAddDirs 按附件实际位置算出来（见 `--add-dir` / `--include-directories`）。
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { attachChip, isAbsolutePath } from '../shared/composer.ts'
import { MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/schema.ts'

/** 任务目录里放图片的地方，提示里的路径也以它开头 */
export const ATTACH_DIR = 'attachments'

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

/**
 * 同一个任务里重名的图片加序号：两个都叫 note.png 时后一个写成 note (2).png，
 * 不能把前一个覆盖掉。
 */
function uniqueIn(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const next = `${stem} (${i})${ext}`
    if (!taken.has(next)) return next
  }
}

/**
 * 把图片附件拷进任务目录，返回替换过路径的附件；其它附件原样返回。
 * dir 为空（任务还没有执行目录）时原样返回。
 *
 * 拷进去的写成相对路径（`attachments/名字`）：Agent 就在这个目录里跑，相对路径它直接能读。
 */
export async function placeAttachments(dir: string, attachments: Attachment[]): Promise<Attachment[]> {
  if (!dir || !attachments.length) return attachments
  // base 给 path.relative 算相对路径（盘根时不能用 stripEnd 后的 `C:`，那会按进程当前目录解析），
  // root 只用来做前缀比较
  const base = path.resolve(dir)
  const root = stripEnd(base)
  const target = path.join(root, ATTACH_DIR)
  const taken = new Set<string>()
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
    const name = uniqueIn(safeName(a.name), taken)
    taken.add(name)
    try {
      // 懒建：没有要拷的图片时不在任务目录里留一个空的 attachments/
      await mkdir(target, { recursive: true })
      await copyFile(full, path.join(target, name))
      out.push({ ...a, path: `${ATTACH_DIR}/${name}` })
    } catch {
      // 源文件已经不在了（比如清缓存时删掉）：留着原来的路径，让 Agent 自己报找不到
      out.push(a)
    }
  }
  return out
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
