/**
 * 项目用到的程序在本机的位置（复盘 2026-11-26 §5 第 4 项「项目工具路径登记」）。
 *
 * 为什么：luac、导表工具这类程序不在 PATH 里，每个节点都重新全盘找（Get-ChildItem 全项目、find 整个盘），
 * 一次几分钟、还常超时；经验里明明记过路径，收尾和测试节点照样再找一遍（复盘 P2-4）。
 * 所以 Agent 找到一次就用 custom_tool action=locate 登记，之后每个对话开头的自建工具清单里带上，
 * Agent 又要全盘找同一个程序时情境规则再提醒一次（shared/hooks/situational.ts）。
 *
 * 路径是这台电脑上的，同事的检出位置不同，所以存本机数据目录（server/custom-tools/programs.ts），不进项目文档、不进仓库
 */
import { z } from 'zod'

/** 程序名：命令里写的那个名字（luac、TableExporter），不带路径 */
export const PROGRAM_NAME = /^[A-Za-z0-9][\w.+-]{0,63}$/

export const ProgramPath = z.object({
  name: z.string().regex(PROGRAM_NAME),
  /** 可执行文件或脚本的完整路径 */
  path: z.string().min(1),
  /** 用途、怎么用（一句话） */
  note: z.string().default(''),
  /** 登记时间 */
  at: z.string(),
  /** 谁登记的：Agent 登记写对话标题，人在设置里改写「我」 */
  by: z.string().default(''),
})
export type ProgramPath = z.infer<typeof ProgramPath>

/** 列表上多一个「文件还在不在」：挪走、删掉的不再推给 Agent，设置里标出来 */
export const ProgramPathView = ProgramPath.extend({ missing: z.boolean().optional() })
export type ProgramPathView = z.infer<typeof ProgramPathView>

/** 一个项目最多记这么多个：多了提示词里也列不下，最早登记的先丢 */
export const MAX_PROGRAMS = 30

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** 登记一条：同名的换成新的（排到最后），超过上限丢最早的。服务端和演示后端共用 */
export function upsertProgram<T extends ProgramPath>(list: T[], entry: T): T[] {
  return [...list.filter((p) => !same(p.name, entry.name)), entry].slice(-MAX_PROGRAMS)
}

/** 删掉一条：返回剩下的和有没有删到 */
export function withoutProgram<T extends ProgramPath>(list: T[], name: string): { rest: T[]; found: boolean } {
  const rest = list.filter((p) => !same(p.name, name))
  return { rest, found: rest.length !== list.length }
}

/** 登记前的检查（名字、绝对路径）：不对时返回原因。文件在不在由服务端另查 */
export function programProblem(name: string, file: string): string {
  if (!PROGRAM_NAME.test(name.trim())) return `程序名不对：「${name.trim()}」，只写名字（luac），不带路径和空格`
  const f = file.trim()
  if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(f)) return `路径要写完整的绝对路径：${f}`
  return ''
}

/** 提示词里那一行的长度上限：程序再多也不挤占提示词 */
const HINT_MAX = 400

/** 对话开头那一行：只列文件还在的；一个都没有时是空串 */
export function programsHint(list: ProgramPathView[]): string {
  const ok = list.filter((p) => !p.missing)
  if (!ok.length) return ''
  const parts: string[] = []
  let size = 0
  for (const p of ok) {
    const s = `${p.name} ${p.path}${p.note ? `（${p.note.slice(0, 30)}）` : ''}`
    if (size + s.length > HINT_MAX) break
    parts.push(s)
    size += s.length
  }
  return `本机已登记的程序位置（直接用这个路径，不要再全盘找）：${parts.join('；')}；`
}

/**
 * 在「找文件」的命令：find、where、Get-ChildItem 这类。只认命令开头或管道、分号后的那个词，
 * 宁可漏认也不把普通命令当成在找程序
 */
const SEARCH =
  /(?:^|[|;&]\s*|\bcmd\s+\/c\s+)(?:find|fd|fdfind|locate|where|where\.exe|which|whereis|get-childitem|gci|ls|dir|get-command|gcm|es|everything)\b/i

/** Agent 这条命令是不是在找某个已登记的程序：是就返回那一条（文件还在的才算） */
export function searchedProgram(command: string, list: ProgramPathView[]): ProgramPathView | undefined {
  const cmd = command.trim()
  if (!cmd || !SEARCH.test(cmd)) return undefined
  const low = cmd.toLowerCase()
  return list.find((p) => {
    if (p.missing) return false
    const name = p.name.toLowerCase().replace(/[.+]/g, '\\$&')
    // 程序名前后不是字母数字：luac 不认成 luacheck
    return new RegExp(`(?:^|[^a-z0-9_])${name}(?:\\.exe|\\.bat|\\.cmd|\\.py)?(?:[^a-z0-9_]|$)`).test(low)
  })
}
