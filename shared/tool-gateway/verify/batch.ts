/**
 * 改完自动校验的「一批」（ADR 0086，设计稿第 8 节）：Agent 连着改好几个文件，等这一串改完、它去做别的事
 * （下一个不是改文件的调用，或要收尾）时，每个校验工具只跑一次，查这一批里对得上它 paths 的文件。
 *
 * 跑之前整批取走并清空：同一批不重复跑，并行来的几个工具前（同时读好几个文件）只有第一个会跑；
 * 跑的时候又改了的文件进下一批。只看工具调用的类别和路径，不看回复文字（ADR 0041、0049）。
 * 纯函数 + 显式的状态对象：服务端网关和演示后端用同一份
 */
import { globRe } from '../../text-match/index.ts'

/** 一个校验工具管哪些文件 */
export interface VerifyTarget {
  id: string
  paths: string[]
}

/** 这一轮还没校验的改动：工具 id → 文件（相对项目根，按先后） */
export interface EditBatch {
  pending: Map<string, string[]>
}

export const newBatch = (): EditBatch => ({ pending: new Map() })

const norm = (p: string) => p.replaceAll('\\', '/').replace(/^\.\//, '')

/** 改了文件：对得上哪个校验工具的 paths 就记到它名下；返回记下了几个（同一个文件只记一次） */
export function noteEdits(b: EditBatch, files: string[], tools: VerifyTarget[]): number {
  let n = 0
  for (const t of tools) {
    const res = t.paths.map((g) => globRe(g, { dirPrefix: true }))
    for (const f of files.map(norm).filter(Boolean)) {
      if (!res.some((re) => re.test(f))) continue
      const list = b.pending.get(t.id) ?? []
      if (list.includes(f)) continue
      list.push(f)
      b.pending.set(t.id, list)
      n++
    }
  }
  return n
}

/** Agent 去做别的事了：取走这一批（取完就清空） */
export function takeBatch(b: EditBatch): { tool: string; files: string[] }[] {
  const out = [...b.pending].map(([tool, files]) => ({ tool, files }))
  b.pending.clear()
  return out
}

export const hasPending = (b: EditBatch) => b.pending.size > 0
