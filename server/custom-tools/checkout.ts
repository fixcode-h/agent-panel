/**
 * 自建工具会改的文件（CustomTool.writes）执行前在 P4 里签出：和 Agent 改文件、UE 保存资源同一种做法，
 * 只是这里是通配（** 换成 P4 的 ...），已经签出的、不在 client 里的不算错。Git 项目和别的什么都不做
 */
import path from 'node:path'
import { detectVcs } from '../vcs/detect.ts'
import { p4Runner } from '../p4-split.ts'

/** 项目相对的通配 → P4 的文件规格：** 是任意层（...），* 不跨目录 */
export const p4Spec = (root: string, pattern: string) =>
  path.join(
    root,
    pattern
      .replace(/\\/g, '/')
      .replace(/\/?\*\*\/?$/, '/...')
      .replace(/\*\*\//g, '.../'),
  )

/** 返回给 Agent 的一句：签出了哪些，或者为什么没签出；不是 P4 项目时是空串 */
export async function checkoutWrites(root: string, writes: string[]): Promise<string> {
  const vcs = await detectVcs(root).catch(() => undefined)
  if (vcs?.vcs !== 'p4' || !writes.length) return ''
  const run = p4Runner(root)
  const r = await run(['edit', '-c', 'default', ...writes.map((w) => p4Spec(root, w))])
  const opened = r.out.split('\n').filter((l) => /opened for edit/i.test(l)).length
  const bad = r.err
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/currently opened|file\(s\) not on client|no such file|not in client view/i.test(l))
  if (bad.length)
    return `P4 签出没完全成功：${bad.slice(0, 3).join('；')}（工具照常跑了，没签出的文件写不进去时会报错）`
  return opened ? `P4 已签出 ${opened} 个文件到默认 changelist` : ''
}
