/**
 * 父对话的就地微改动（角色分层改造，见 docs/openspec/changes/role-composition-and-dispatch）：
 * 改个文案、一个配置值、一两行文档时，主理不用开一个子对话冷启动，自己在当前分支上改、跑快速检查、本地提交。
 * 这是唯一放宽父对话「不改文件」的地方，所以护栏写死在面板里，不靠提示词自觉：
 * - 开始前（begin_inline_edit）：声明的文件数有上限；子对话正在合回、或者要改的文件被子对话认领 / 正在改时拒绝；
 * - 改动期间：父对话不能收尾子对话（finish_child），免得合并和就地改动搅在同一个工作区里；
 * - 结束时（end_inline_edit，或这一轮结束时自动收）：按真实改动核对文件数、行数和没声明的文件，越界就醒目提示。
 * 这里只放纯判定和文案，git、认领、子对话状态由服务端（server/tasks.ts）取来传进来。
 */

/** 一次就地微改动最多改几个文件 */
export const INLINE_EDIT_MAX_FILES = 2
/** 一次就地微改动最多改几行（新增 + 删除） */
export const INLINE_EDIT_MAX_LINES = 20

/** 进行中的就地微改动：开始时记下声明的范围和工作区基线，结束时按它算真实改动 */
export interface InlineEditState {
  files: string[]
  reason: string
  startedAt: string
  /** 开始时的提交：结束时和它比，期间自己提交了的也算进来 */
  head: string
  /** 开始时已经有的未提交改动（path → 增/删）：不是这次改的，结束核对时剔除 */
  baseline: Record<string, string>
}

/** 规整声明的路径：去掉开头的 ./ 和结尾的 /，统一斜杠，去重 */
export function normInlinePaths(files: string[]) {
  return [
    ...new Set(
      files
        .map((f) =>
          String(f ?? '')
            .trim()
            .replace(/\\/g, '/')
            .replace(/^\.\//, '')
            .replace(/\/+$/, ''),
        )
        .filter(Boolean),
    ),
  ]
}

/** 开始前的拦截：返回拒绝原因，能开始返回空字符串 */
export function inlineEditBlocker(input: {
  files: string[]
  reason: string
  /** 正在合回或合回后跑父对话测试的子对话标题 */
  merging: string[]
  /** 要改的文件被谁占着：认领（共用目录）或者正在改 / 划了范围（独立分支） */
  held: { path: string; by: string }[]
  /** 已经有一次就地改动没结束 */
  active?: boolean
}): string {
  const { files, reason, merging, held } = input
  if (input.active) return '上一次就地改动还没结束：先调用 end_inline_edit 收尾，再开始新的'
  if (!files.length) return 'files 是空的：写清要改哪几个文件（相对项目根）'
  if (files.length > INLINE_EDIT_MAX_FILES)
    return `就地微改动最多改 ${INLINE_EDIT_MAX_FILES} 个文件，这次声明了 ${files.length} 个：交给子对话做（create_conversation）`
  if (reason.trim().length < 4) return 'reason 写清改什么、为什么能就地改（不用排查、改动很小）'
  if (merging.length)
    return `子对话「${merging.join('」「')}」正在合回这个分支：等它收尾完再就地改，或者把这件事交给子对话`
  if (held.length)
    return `这些文件子对话正在用：${held.map((h) => `${h.path}（${h.by}）`).join('、')}。交给那个子对话改（send_to_conversation），不要在这里改`
  return ''
}

/** 结束时按真实改动核对：没越界时 over 为 false */
export function inlineEditOverrun(declared: string[], changes: { path: string; add: number; del: number }[]) {
  const want = normInlinePaths(declared)
  const lines = changes.reduce((n, c) => n + c.add + c.del, 0)
  const undeclared = changes.map((c) => c.path).filter((p) => !want.some((w) => p === w || p.startsWith(`${w}/`)))
  const over = changes.length > INLINE_EDIT_MAX_FILES || lines > INLINE_EDIT_MAX_LINES || undeclared.length > 0
  return { files: changes.length, lines, undeclared, over }
}

/** 越界提示：写进父对话，建议把这次改动交给子对话评审 */
export function inlineEditOverrunText(r: ReturnType<typeof inlineEditOverrun>) {
  const why = [
    r.files > INLINE_EDIT_MAX_FILES ? `改了 ${r.files} 个文件（上限 ${INLINE_EDIT_MAX_FILES}）` : '',
    r.lines > INLINE_EDIT_MAX_LINES ? `改了 ${r.lines} 行（上限 ${INLINE_EDIT_MAX_LINES}）` : '',
    r.undeclared.length ? `改了没声明的文件：${r.undeclared.join('、')}` : '',
  ].filter(Boolean)
  return `就地改动越界：${why.join('；')}。这已经不是微改动了，建议开一个子对话评审这些改动（或者交给子对话重做）。`
}
