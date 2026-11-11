/**
 * 诊断报告「修复」这一步（用户 2026-11-10 要求：修复页显示改了哪些代码、为什么这么改）：
 * 交验证那一版时，面板按对话的实际改动取每个文件和对话开始时比的 diff，存进 Diagnosis.fixFiles。
 * 原文由面板取、不让 Agent 抄（docs/lessons/bug-report.md）；`[排查-` 临时日志收尾时要删，不算修复的改动。
 * 这里只放纯函数，取 diff 由宿主给（BugSource.diff，server/exec/bug-source.ts）
 */
import type { FixFile } from './bug-diagnosis-schema.ts'
import { TEMP_LOG } from './bug-cleanup.ts'
import { normPath } from './bug-phase.ts'
import type { BugSource } from './bug-quotes.ts'
import type { TaskMessage } from './schema.ts'

/** 一个文件的 diff 最多存这么多字（schema 的上限），多了截断并写明 */
const MAX_FILE_DIFF = 19000
/** 最多存这么多个文件：修 Bug 改几十个文件本身就要在报告里提醒 */
const MAX_FILES = 30

/**
 * 把 git diff 的输出整理成报告里显示的：去掉文件头（diff --git、index、---、+++），
 * 去掉临时日志的增删行，只剩临时日志的那几段整段不要；返回空 diff 表示这个文件只加过临时日志
 */
export function cleanDiff(raw: string): { diff: string; add: number; del: number; isNew: boolean } {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const isNew = lines.some((l) => l.startsWith('new file mode') || l === '--- /dev/null')
  const hunks: string[][] = []
  for (const l of lines) {
    if (l.startsWith('@@')) hunks.push([l])
    else if (hunks.length && !l.startsWith('\\ No newline')) hunks.at(-1)!.push(l)
  }
  let add = 0
  let del = 0
  const kept: string[] = []
  for (const h of hunks) {
    const body = h.slice(1).filter((l) => !((l[0] === '+' || l[0] === '-') && l.includes(TEMP_LOG)))
    // diff 末尾多出来的空串不算一行
    while (body.length && body.at(-1) === '') body.pop()
    const a = body.filter((l) => l[0] === '+').length
    const d = body.filter((l) => l[0] === '-').length
    if (!a && !d) continue
    add += a
    del += d
    kept.push(h[0], ...body)
  }
  return { diff: kept.join('\n'), add, del, isNew }
}

/** 一行是不是 unified diff 里的行：段头、增删、上下文、`\\ No newline` */
const DIFF_LINE = /^(@@|[-+ \\]|$)/

/**
 * 不是 git 工作区（P4、SVN 的工程）时，一个文件的改动只能拼 Agent 改它时记下的改动：
 * 改文件工具的输入（CLI 给出结果后换成带行号的 diff，见 server/exec/tool-rows.ts），和对话里点开改动文件看到的是同一份。
 * 不是 diff 的输入（JSON 参数）不要；整份写入（没有段头、全是新增行）补一个段头。拼不出来返回 undefined
 */
export function editPatch(messages: Pick<TaskMessage, 'tools'>[], file: string): string | undefined {
  const parts: string[] = []
  for (const m of messages)
    for (const x of m.tools ?? []) {
      if (x.kind !== 'edit' || x.failed || !x.input || normPath(x.label) !== file) continue
      const ls = x.input.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
      if (!ls.every((l) => DIFF_LINE.test(l))) continue
      parts.push(ls[0].startsWith('@@') ? ls.join('\n') : ['@@ @@', ...ls].join('\n'))
    }
  return parts.length ? parts.join('\n') : undefined
}

/**
 * 交验证时取：changed 是对话目前实际改动的文件（相对项目根）；只加过临时日志的文件不算。
 * 版本管理取不到 diff 时用 edits（Agent 改文件时记下的改动）。
 * blind：改了但两边都取不到改动的文件数，调用方据此不把「一个文件都没取到」当成「还没改代码」
 */
export function fixFilesOf(
  changed: string[],
  src: BugSource,
  edits?: (file: string) => string | undefined,
): { files: FixFile[]; blind: number } {
  const out: FixFile[] = []
  let blind = 0
  if (!src.diff) return { files: out, blind }
  const seen = new Set<string>()
  for (const p of changed) {
    // 项目外的绝对路径算不了 diff
    if (/^([A-Za-z]:)?[\\/]/.test(p)) continue
    const file = normPath(p)
    if (!file || seen.has(file) || out.length >= MAX_FILES) continue
    seen.add(file)
    const raw = src.diff(file) ?? edits?.(file)
    if (raw === undefined) {
      blind++
      continue
    }
    const c = cleanDiff(raw)
    if (!c.add && !c.del) continue
    const diff = c.diff.length > MAX_FILE_DIFF ? `${c.diff.slice(0, MAX_FILE_DIFF)}\n…` : c.diff
    out.push({ file, add: c.add, del: c.del, diff, isNew: c.isNew })
  }
  return { files: out, blind }
}
