/**
 * 保存时的重复检测（设计稿 6.2）：同 id、中文名很像、命令去掉参数后一样、用同一段脚本。
 * 撞上了由用户在保存弹窗里选「更新它」还是「另存为新工具」，面板不自己合并
 */
import type { CustomTool, ToolDraft, ToolEntry, ToolScope } from './schema.ts'

export interface ToolDup {
  id: string
  name: string
  scope: ToolScope
  version: number
  /** 为什么算重复（给人看） */
  why: string
  /** 同 id：只能更新或改 id */
  sameId: boolean
}

/** 命令的指纹：去掉占位符、引号、多余空白，统一大小写和斜杠 */
export function commandPrint(cmd: string) {
  return cmd
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/["'`]/g, '')
    .replaceAll('\\', '/')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 中文名的相似：去掉空白和标点后一样，或者一个包含另一个（「导表」和「导表工具」） */
const nameKey = (s: string) => s.replace(/[\s\p{P}]/gu, '').toLowerCase()
const similarName = (a: string, b: string) => {
  const x = nameKey(a)
  const y = nameKey(b)
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))))
}

export function findDups(draft: Pick<ToolDraft, 'id' | 'name' | 'run'>, entries: ToolEntry[]): ToolDup[] {
  const out: ToolDup[] = []
  const print = commandPrint(draft.run.command)
  for (const e of entries) {
    const t: CustomTool | undefined = e.tool
    if (!t) continue
    const why: string[] = []
    const sameId = t.id === draft.id
    if (sameId) why.push('id 一样')
    if (similarName(t.name, draft.name)) why.push('名字很像')
    if (print && commandPrint(t.run.command) === print) why.push('命令一样（不算参数）')
    if (draft.run.script?.text && t.run.script?.text?.trim() === draft.run.script.text.trim()) why.push('脚本一样')
    if (why.length)
      out.push({ id: t.id, name: t.name, scope: e.scope, version: t.version, why: why.join('、'), sameId })
  }
  // 同 id 的排最前：它决定了只能「更新」
  return out.sort((a, b) => Number(b.sameId) - Number(a.sameId))
}
