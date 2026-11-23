/**
 * P4 里改文件前后的签出规则（版本管理服务，ADR 0073）：Agent 改文件（内置钩子 p4-auto-open）、UE 保存资源、表格保存都用这一份。
 * 以前钩子、UE 插件、表格插件各写一份：2026-11-23「改动不进默认 Changelist」在面板和 UE 各修了一遍，表格那份还只签只读文件。
 *
 * 规则（用户 2026-11-23 定）：
 * - 在库里、还没打开的：改之前 p4 edit 进 default（不论文件是不是只读——allwrite 的 client、手动去掉过只读的文件照样要签出）；
 * - 已经在当前 client 某个 pending 里的：不动，留在原 changelist；
 * - 库里没有的、库里已删除的、本地没有的：写完以后 p4 add 进 default；
 * - 不在这个 client 视图里的：不归 P4 管，跳过；
 * - 不管远端有没有更新、不 sync；只有没法合并的资源（二进制）本地落后时列进 stale，由调用方先问用户
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseZtag, type P4Run } from '../p4-split.ts'

/** 这些报错说明文件本来就不归这个 client 管（不在视图里、不在工作区根下）：不是出错，跳过 */
export const P4_NOT_OURS = /not in client view|not under client's root|is not under client/i
/** fstat 对还没进库的文件报的：这类文件写完后 add */
const NOT_IN_DEPOT = /no such file|not on client/i
/** .p4ignore 里写了的文件：用户本来就不想提交，add 被拒不算出错 */
const IGNORED = /ignored file can't be added|ignored file/i
/** 没法合并的文件类型（p4 的 headType：binary、binary+l、ubinary、apple、resource） */
const UNMERGEABLE = /binary|apple|resource/i

/** 本地版本落后于 P4 最新版的没法合并的资源 */
export interface P4Stale {
  file: string
  have: number
  head: number
}

export interface P4WritePlan {
  /** 改之前要 p4 edit 的 */
  edit: string[]
  /** 写完以后要 p4 add 的 */
  add: string[]
  /** 已经打开着（在某个 pending 里）的：不动 */
  opened: string[]
  stale: P4Stale[]
  /** fstat 整个失败（连不上、没登录）的原因 */
  error?: string
}

const norm = (p: string) => {
  const s = path.resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

const lineKey = (l: string) => {
  const s = l.replace(/\\/g, '/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 问一次 P4（fstat），算出这批文件改前要签出哪些、改后要 add 哪些 */
export async function p4WritePlan(
  run: P4Run,
  files: string[],
  exists: (f: string) => boolean = existsSync,
): Promise<P4WritePlan> {
  const plan: P4WritePlan = { edit: [], add: [], opened: [], stale: [] }
  if (!files.length) return plan
  const st = await run(['-ztag', 'fstat', '-T', 'clientFile,headAction,headType,headRev,haveRev,action', ...files])
  const recs = new Map(
    parseZtag(st.out)
      .filter((r) => r.clientFile)
      .map((r) => [norm(r.clientFile), r]),
  )
  const errLines = st.err.split(/\r?\n/).filter((l) => l.trim())
  const real = errLines.filter((l) => !P4_NOT_OURS.test(l) && !NOT_IN_DEPOT.test(l))
  if (!recs.size && real.length) return { ...plan, error: real.join('；') }
  for (const f of files) {
    const r = recs.get(norm(f))
    if (!r) {
      // 报错行里带着这个文件、并且说不归这个 client 管：跳过；其余不在库里的写完后 add
      const line = errLines.find((l) => lineKey(l).includes(norm(f)))
      if (!line || !P4_NOT_OURS.test(line)) plan.add.push(f)
      continue
    }
    if (r.action) plan.opened.push(f)
    else if (/delete/.test(r.headAction ?? '') || !exists(f)) plan.add.push(f)
    else {
      plan.edit.push(f)
      const have = Number(r.haveRev || 0)
      const head = Number(r.headRev || 0)
      if (UNMERGEABLE.test(r.headType ?? '') && have < head) plan.stale.push({ file: f, have, head })
    }
  }
  return plan
}

/** p4 edit / add 进 default changelist。返回出错原因（没有就是成功）；已打开、被 .p4ignore 忽略、不归这个 client 管的不算错 */
export async function p4Open(run: P4Run, verb: 'edit' | 'add', files: string[]): Promise<string | undefined> {
  if (!files.length) return undefined
  const r = await run([verb, '-c', 'default', ...files])
  const bad = r.err
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/currently opened/i.test(l) && !IGNORED.test(l) && !P4_NOT_OURS.test(l))
  if (verb === 'edit' ? !r.ok || bad.length : !r.ok && bad.length)
    return (bad.join('；') || r.out).trim() || r.err.trim()
  return undefined
}
