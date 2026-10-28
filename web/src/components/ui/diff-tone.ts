/**
 * 差异行的配色（照 Claude Code）：整行一层浅底，行号槽再深一层，改动的那几个字最深。
 * 边界靠底色分出来，不画描边：左右对照时右栏自己的行号槽就是分隔，段与段之间是一条浅底的折叠行。
 * 对话里的工具行和差异弹窗都用这一套，改一处两边一起变
 */
export const DIFF_TONE = {
  add: { row: 'bg-success/10', gutter: 'bg-success/20 text-success', sign: 'text-success', mark: 'bg-success/30' },
  del: { row: 'bg-danger/10', gutter: 'bg-danger/20 text-danger', sign: 'text-danger', mark: 'bg-danger/30' },
  ctx: { row: '', gutter: 'bg-field/60 text-subtle/70', sign: 'text-subtle/40', mark: '' },
  /** 左右对照里缺了一侧：只留中性底，新增文件的左栏不染红 */
  none: { row: 'bg-field/40', gutter: 'bg-field/60 text-subtle/70', sign: '', mark: '' },
} as const

/** 段头 / 折叠行：一条浅底的窄行，不加上下边线 */
export const DIFF_HUNK = 'bg-field/70 px-3 py-1 text-[0.6875rem] text-subtle'

/** 行号槽：固定宽度、右对齐，选文字时不带上行号 */
export const DIFF_GUTTER = 'w-11 shrink-0 select-none pr-2 text-right tabular-nums'
