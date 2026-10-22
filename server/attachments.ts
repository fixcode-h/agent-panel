/**
 * 把附件放进任务自己的目录。
 *
 * Agent 在任务的执行目录里跑（项目目录、独立分支目录，Chat 是数据目录下的专属目录），
 * 附件原本在 ~/.agent-panel/uploads 里，不在这个目录下：有的 CLI 读工作目录以外的文件要先放行，
 * 而且提示里给绝对路径也不方便 Agent 自己去找。所以开始时拷一份到 <执行目录>/attachments/，
 * 提示里给的相对路径就是 `attachments/<文件名>`。
 *
 * 超过上限（20M）的不拷，只用原来的路径：大文件拷一份既慢又占空间。
 * 粘贴路径引用的已有文件（Attachment.ref）也不拷：用户要的就是那个文件本身。
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/schema.ts'

/** 任务目录里放附件的地方，提示里的路径也以它开头 */
export const ATTACH_DIR = 'attachments'

/** 文件名里去掉路径和系统不允许的字符（和上传时一致，名字对得上） */
const safeName = (n: string) => path.basename(n).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'file'

/**
 * 同一个任务里重名的附件加序号：两个都叫 note.txt 时后一个写成 note (2).txt，
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
 * 把附件拷进任务目录，返回替换过路径的附件。
 * dir 为空（任务还没有执行目录）时原样返回。
 *
 * 拷进去的写成相对路径（`attachments/名字`）：Agent 就在这个目录里跑，相对路径它直接能读；
 * 超过上限的不拷，保留原来的绝对路径。
 */
export async function placeAttachments(dir: string, attachments: Attachment[]): Promise<Attachment[]> {
  if (!dir || !attachments.length) return attachments
  const root = path.resolve(dir)
  const target = path.join(root, ATTACH_DIR)
  await mkdir(target, { recursive: true })
  const taken = new Set<string>()
  const out: Attachment[] = []
  for (const a of attachments) {
    // 已经是相对路径的（上一轮放进去的）：不再解析、不再拷，避免把相对路径按进程目录解析错
    if (!path.isAbsolute(a.path) && !/^[a-zA-Z]:[\\/]/.test(a.path)) {
      out.push(a)
      continue
    }
    const full = path.resolve(a.path)
    // 已经在任务目录里的（上一轮拷过的、引入会话生成的）不再拷一遍，只把路径换成相对的
    if (full.startsWith(root + path.sep)) {
      out.push({ ...a, path: path.relative(root, full).replace(/\\/g, '/') })
      continue
    }
    // 引用的已有文件（粘贴回来的路径）用原来的路径，不再拷一份；引用卡片的原文直接写进要求里，不用拷
    if (a.ref || a.quote !== undefined) {
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
    const to = path.join(target, name)
    try {
      await copyFile(full, to)
      out.push({ ...a, path: `${ATTACH_DIR}/${name}` })
    } catch {
      // 源文件已经不在了（比如清缓存时删掉）：留着原来的路径，让 Agent 自己报找不到
      out.push(a)
    }
  }
  return out
}
