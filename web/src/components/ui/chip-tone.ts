import type { ChipKind } from '@shared/composer'

/**
 * 行内卡片（输入框、消息气泡、InlineChip）按类型着色：一层带色的浅底、同色的细内框、图标和类型字用实色。
 * 只靠中性浅底时卡片在用户气泡（同样是 bg-sel）里几乎看不出来，所以这里破例描一圈细线（见 docs/lessons/visual.md）。
 * 类名写全：Tailwind 只认源码里完整出现的类名，不能拼
 */
export const CHIP_TONE: Record<ChipKind | 'missing', { box: string; hover: string; icon: string; status: string }> = {
  image: { box: 'bg-run/12 ring-run/35', hover: 'hover:bg-run/20', icon: 'text-run', status: 'text-run/80' },
  file: {
    box: 'bg-accent/12 ring-accent/35',
    hover: 'hover:bg-accent/20',
    icon: 'text-accent',
    status: 'text-accent/80',
  },
  skill: { box: 'bg-peer/12 ring-peer/35', hover: 'hover:bg-peer/20', icon: 'text-peer', status: 'text-peer/80' },
  command: { box: 'bg-peer/12 ring-peer/35', hover: 'hover:bg-peer/20', icon: 'text-peer', status: 'text-peer/80' },
  quote: {
    box: 'bg-success/12 ring-success/35',
    hover: 'hover:bg-success/20',
    icon: 'text-success',
    status: 'text-success/80',
  },
  /** 附件已经不在了：退回中性色，看得出是张卡片但不抢眼 */
  missing: { box: 'bg-sel/70 ring-line-strong', hover: '', icon: 'text-subtle', status: 'text-subtle' },
}

/** 所有行内卡片共用的外形：一行高、圆角、细内框（颜色由 CHIP_TONE 给） */
export const CHIP_SHAPE =
  'mx-0.5 inline-flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-md px-1.5 align-middle text-[0.8125rem] leading-[1.7] text-fg ring-1 ring-inset'
