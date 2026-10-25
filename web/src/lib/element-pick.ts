/**
 * 开发者模式「抓取元素」的纯逻辑：鼠标按键在抓取期间怎么分派、抓到的引用投给谁。
 * 读 DOM、画高亮框的部分在 components/chat/ElementPicker.tsx，这里只有能单独测的判定。
 */
import { formatElementRef, type ElementInfo } from '@/lib/element-ref'
import { t } from '@shared/i18n'
import type { PickButton } from '@shared/schema'

/** 三个键（按 MouseEvent.button 的顺序：左 0、中 1、右 2） */
const ALL_BUTTONS = ['left', 'middle', 'right'] as const

/** 鼠标按键的显示名（设置页、提示条、按钮提示共用一个概念只定义这一次） */
export const pickButtonLabel = (button: PickButton) =>
  ({ middle: t('中键'), left: t('左键'), right: t('右键') })[button]

/** MouseEvent.button 的编号：左 0、中 1、右 2；PointerEvent.buttons 里的位：左 1、右 2、中 4 */
const BUTTON_INDEX: Record<PickButton, number> = { left: 0, middle: 1, right: 2 }
const BUTTON_BITS: Record<PickButton, number> = { left: 1, right: 2, middle: 4 }

/** 指针事件里和按键有关的两个字段（PointerEvent 有全集，测试里给这两个就够） */
export interface ButtonLike {
  button: number
  buttons: number
}

/**
 * 抓取期间这个指针事件的去向：
 * - pick：按下了抓取键，抓完退出
 * - swallow：抓取键的按下 / 松开，拦住页面自己的行为（中键自动滚动、中键粘贴、右键菜单、链接在新标签打开）
 * - pass：其他键，一切照常——抓取期间左键还能点按钮、右键还能弹菜单、拖线和拖动都还能用
 */
export type PointerIntent = 'pick' | 'swallow' | 'pass'

/** 指针事件只有按下和松开两个阶段要说（move 一律 pass，不进来） */
export type ButtonPhase = 'down' | 'up'

/**
 * 抓取期间的一次按下 / 松开要不要吃掉。
 *
 * 抓取键的松开也要拦：document 上的 auxclick 会打开链接、粘贴选中内容，光拦 down 挡不住。
 * 两个键同时按着时抓取键不算数（e.buttons 里还有别的键）：拖拽、刷选到一半顺手中键，不该把整页抓走
 */
export function pointerIntent(pick: PickButton, phase: ButtonPhase, e: ButtonLike): PointerIntent {
  const others = ALL_BUTTONS.filter((b) => b !== pick).reduce<number>((bits, b) => bits | BUTTON_BITS[b], 0)
  if (e.buttons & others) return 'pass'
  if (e.button !== BUTTON_INDEX[pick]) return 'pass'
  return phase === 'down' ? 'pick' : 'swallow'
}

/** 抓到的元素写成引用文字：和「点抓取按钮再点元素」得到的一字不差（formatElementRef 的输出） */
export const pickText = (info: ElementInfo) => formatElementRef(info)

/** 引用最后去了哪里 */
export type PickSink = 'composer' | 'clipboard'

/** 决定投给哪个输入框时用得上的事实（从 DOM 读出来的部分由组件给） */
export interface TargetFacts {
  /** 页面上登记了几个输入框 */
  count: number
  /** 焦点在其中某个输入框里吗 */
  focused: boolean
  /** 最近聚焦过某个输入框吗 */
  recent: boolean
}

/**
 * 该不该直接投给输入框。只有一个输入框时就是它；有多个时只在「焦点在里面」或「刚在里面待过」才投，
 * 否则返回 false 走剪贴板：多输入框（父对话 + 右栏子对话）时猜错会把引用插进另一个对话，
 * 而需求给的口径是「找不到就放剪贴板让用户自己粘」
 */
export const targetsComposer = (f: TargetFacts) => f.count === 1 || f.focused || f.recent

export interface PickTargets {
  /** 开启抓取时正在用的那个输入框；没登记输入框（例如快捷键在别的页面按的）时没有 */
  composer: ((text: string) => boolean) | undefined
  /** 投递失败时的兜底：写系统剪贴板 */
  clipboard: (text: string) => Promise<void>
}

/**
 * 把抓到的引用交出去：先投给开启抓取时的那个输入框，投不进去（输入框已经不在了、
 * 或者根本没有）就写进剪贴板，让用户自己粘到想放的地方。返回去了哪里，调用方据此提示用户。
 */
export async function deliverPick(text: string, targets: PickTargets): Promise<PickSink> {
  if (targets.composer) {
    try {
      if (targets.composer(text)) return 'composer'
    } catch {
      // 输入框那边自己出错了（例如编辑器还没挂上）：不能把引用吞掉，退回剪贴板
    }
  }
  await targets.clipboard(text)
  return 'clipboard'
}
