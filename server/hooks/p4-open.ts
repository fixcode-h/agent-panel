import { existsSync } from 'node:fs'
import path from 'node:path'
import type { HookFacts } from '../../shared/hooks/index.ts'
import { parseZtag, type P4Run } from '../p4-split.ts'
import { editTargets } from './guards-edit.ts'
import { taskMap } from '../runtime/task-state.ts'

/**
 * P4 项目里改文件前自动签出（内置钩子 p4-auto-open）：改已有文件前 p4 edit 进 default changelist，
 * 新建的文件写完后 p4 add 进 default changelist。
 * 以前只写在提示词里（「修改前先 p4 edit / add」），模型常常直接改：P4 工作区文件是只读的话 CLI 改不动，
 * 文件可写（allwrite 的 client、手动去掉过只读）时就悄悄改了，改动不在任何 changelist 里，提交时漏掉（用户 2026-11-23 报）。
 * 必须照做的规则交给面板执行（docs/lessons/plan.md）：已经在当前 client 某个 pending 里的文件不动，留在原 changelist。
 * 不管远端有没有更新、不 sync（用户 2026-11-23 定）；只有二进制资源（没法合并）本地版本落后时拦一次，让 Agent 先问用户要不要只更新这个文件
 */
export interface P4AutoOpen {
  /** 工具前：签出要改的已有文件。deny 是拦下的原因（落后的二进制资源），context 是要补给模型的一句话 */
  before: (facts: HookFacts) => Promise<{ deny?: string; context?: string }>
  /** 工具后：工具前还不在库里的文件现在写出来了，p4 add */
  after: (facts: HookFacts) => Promise<string>
}

/** 这些报错说明文件本来就不归这个 client 管（不在视图里、不在工作区根下）：不是出错，跳过 */
const NOT_OURS = /not in client view|not under client's root|is not under client/i
/** fstat 对还没进库的文件报的：这类文件写完后 add */
const NOT_IN_DEPOT = /no such file|not on client/i
/** .p4ignore 里写了的文件：用户本来就不想提交，add 被拒不算出错 */
const IGNORED = /ignored file can't be added|ignored file/i
/** 没法合并的文件类型（p4 的 headType：binary、binary+l、ubinary、apple、resource） */
const UNMERGEABLE = /binary|apple|resource/i

// 运行时（task-state 登记，对话删掉时跟着清）：每个对话问过「要不要先更新」的资源，同一个文件只拦一次；重启后最多再问一次
const asked = taskMap<Set<string>>('hooks.p4-open 问过要不要更新的资源')

export function p4AutoOpen(cwd: string, run: P4Run, taskId = ''): P4AutoOpen {
  const win = process.platform === 'win32'
  const key = (p: string) => {
    const s = path.resolve(p).replace(/\\/g, '/')
    return win ? s.toLowerCase() : s
  }
  const rel = (f: string) => path.relative(cwd, f).replace(/\\/g, '/')
  // 这次 CLI 调用里已经确认打开过的文件：再改同一个文件不再问 P4
  const opened = new Set<string>()
  // 工具前还不在库里（新文件、库里已删除、没进过库）的文件：工具后存在了就 add
  const toAdd = new Map<string, string>()

  /** 这次要改的、在项目目录里的文件（绝对路径）；项目外的（项目外文档根、系统临时目录）和项目的 .tmp/ 不管 */
  const targets = (facts: HookFacts) => {
    const root = path.resolve(cwd)
    return [
      ...new Set(
        editTargets(facts)
          .map((p) => path.resolve(cwd, p))
          .filter((abs) => {
            const r = path.relative(root, abs)
            return r && !r.startsWith('..') && !path.isAbsolute(r) && !/^\.tmp([\\/]|$)/.test(r)
          }),
      ),
    ]
  }

  const before = async (facts: HookFacts): Promise<{ deny?: string; context?: string }> => {
    const files = targets(facts).filter((f) => !opened.has(key(f)) && !toAdd.has(key(f)))
    if (!files.length) return {}
    const st = await run(['-ztag', 'fstat', '-T', 'clientFile,headAction,headType,headRev,haveRev,action', ...files])
    const recs = new Map(parseZtag(st.out).map((r) => [key(r.clientFile ?? ''), r]))
    const errLines = st.err.split(/\r?\n/).filter((l) => l.trim() && !NOT_OURS.test(l) && !NOT_IN_DEPOT.test(l))
    if (!recs.size && errLines.length)
      return {
        context: `【面板】P4 自动签出没成功（p4 fstat：${errLines.join('；')}）：先自己 p4 edit / add 要改的文件进 default changelist，失败原因原样告诉用户。`,
      }
    const edit: string[] = []
    const stale: string[] = []
    const mine = asked.get(taskId) ?? new Set<string>()
    for (const f of files) {
      const r = recs.get(key(f))
      if (!r) {
        // 不在这个 client 的视图里（报 not in client view）的文件不归 P4 管；其余不在库里的写完后 add
        const line = st.err.split(/\r?\n/).find((l) => (win ? l.toLowerCase() : l).replace(/\\/g, '/').includes(key(f)))
        if (!line || !NOT_OURS.test(line)) toAdd.set(key(f), f)
        continue
      }
      if (r.action) opened.add(key(f))
      else if (/delete/.test(r.headAction ?? '') || !existsSync(f)) toAdd.set(key(f), f)
      else {
        // 代码文件不看远端、直接签出；没法合并的资源本地落后时先问一次（改完再更新只能二选一丢掉一边）
        if (UNMERGEABLE.test(r.headType ?? '') && Number(r.haveRev || 0) < Number(r.headRev || 0) && !mine.has(key(f)))
          stale.push(`${rel(f)}（本地 #${r.haveRev || 0}，最新 #${r.headRev}）`)
        edit.push(f)
      }
    }
    if (stale.length) {
      for (const f of edit) mine.add(key(f))
      asked.set(taskId, mine)
      return {
        deny: `【面板】这些是没法合并的资源文件，本地版本落后于 P4 上的最新版：${stale.join('、')}。先不要改：问用户是先更新再改（只 p4 sync 这几个文件，不同步别的），还是不更新直接改（之后提交会和别人的版本冲突）。用户回答后再改，面板不再拦这几个文件。`,
      }
    }
    if (!edit.length) return {}
    const e = await run(['edit', '-c', 'default', ...edit])
    const bad = e.err.split(/\r?\n/).filter((l) => l.trim() && !/currently opened/i.test(l))
    if (!e.ok || bad.length)
      return {
        context: `【面板】P4 自动签出失败（p4 edit：${(bad.join('；') || e.out).trim()}）：被别人独占锁住或没权限时不要强改，把这个文件记成阻塞并告诉用户；其他原因先自己 p4 edit 再改。`,
      }
    for (const f of edit) opened.add(key(f))
    return { context: `【面板】已自动 p4 edit 进 default changelist：${edit.map(rel).join('、')}（不用再手动 edit）。` }
  }

  const after = async (facts: HookFacts) => {
    const files = targets(facts)
      .map((f) => toAdd.get(key(f)))
      .filter((f): f is string => !!f && existsSync(f))
    if (!files.length) return ''
    for (const f of files) toAdd.delete(key(f))
    const a = await run(['add', '-c', 'default', ...files])
    const bad = a.err.split(/\r?\n/).filter((l) => l.trim() && !IGNORED.test(l) && !NOT_OURS.test(l))
    if (!a.ok && bad.length)
      return `【面板】新文件自动 p4 add 失败（${bad.join('；')}）：先自己 p4 add 进 default changelist，失败原因原样告诉用户。`
    for (const f of files) opened.add(key(f))
    return ''
  }

  return { before, after }
}
