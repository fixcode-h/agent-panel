import { z } from 'zod'
import type { TaskMessage } from '../schema.ts'

/**
 * 一轮结束后的「本轮产出」（设计稿 6.7，项目共享目录 designs/GitHub项目一键变插件与网页页签-设计稿.md）：
 * 从这一轮记下的改动（server/turn/changes.ts 记在总结消息上的 turnChanges）里挑出「能直接看」的文件。
 * 不在 Task 上加字段：每次按这一轮的消息现算，所以只会是当前这一轮的，不累加。
 * 正式后端和演示后端都按这里挑，界面也按这里排。
 */

/** 回复里换成 HTML 卡片、在右栏网页页签里打开的扩展名（设计稿 6.6） */
const HTML: readonly string[] = ['html', 'htm', 'svg']
/** 面板自己能直接看的产出：网页、图片、PDF、文档。源代码不算（完成依据和改动卡片里已经列了） */
const VIEWABLE: readonly string[] = [
  ...HTML,
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'],
  'pdf',
  ...['md', 'mdx', 'markdown'],
]

/** 扩展名（小写，不含点） */
const extOf = (path: string) => {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isHtmlFile = (path: string) => HTML.includes(extOf(path))

/**
 * 这个文件算不算产出：面板能直接看的，或者开着的插件文件查看器认得的扩展名（extra，界面从插件登记里取）
 */
export const isViewableOutput = (path: string, extra: Iterable<string> = []) => {
  const ext = extOf(path)
  if (!ext) return false
  if (VIEWABLE.includes(ext)) return true
  for (const e of extra) if (e.toLowerCase().replace(/^\./, '') === ext) return true
  return false
}

/**
 * 这一轮的候选产出：一轮回复（用户发话到停下）里带改动记录、没撤销的那几条消息，和它们改过的能直接看的文件。
 * 删除的文件这里还分不出来（改动记录只有增删行数），交给服务端按 git 的状态剔掉
 */
export function turnOutputCandidates(msgs: Pick<TaskMessage, 'id' | 'turnChanges'>[], extra: Iterable<string> = []) {
  const ids: string[] = []
  const paths = new Set<string>()
  const ext = [...extra]
  for (const m of msgs) {
    const ch = m.turnChanges
    if (!ch || ch.revertedAt || !ch.files.length) continue
    let hit = false
    for (const f of ch.files)
      if (isViewableOutput(f.path, ext)) {
        paths.add(f.path)
        hit = true
      }
    if (hit) ids.push(m.id)
  }
  return { msgs: ids, paths: [...paths] }
}

/**
 * 这一轮：用户最后一次发话以后的消息。子任务、工作流、子对话交回结果后自动接着做的几轮也算在里面
 * （用户看到的是「我说了一句，它一路做到停下」），用户再发一句就是新的一轮，上一轮的产出不再列
 */
export function currentRound<T extends Pick<TaskMessage, 'role'>>(messages: T[]) {
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== 'user') i--
  return messages.slice(i + 1)
}

export const TurnOutput = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified']),
  size: z.number(),
})
export type TurnOutput = z.infer<typeof TurnOutput>

/** 排列：HTML 在前（两列卡片），其余按原来的顺序一行一个 */
export function splitOutputs<T extends { path: string }>(files: T[]) {
  return { html: files.filter((f) => isHtmlFile(f.path)), rest: files.filter((f) => !isHtmlFile(f.path)) }
}
