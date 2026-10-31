/**
 * 父对话的「提问」和它名下子对话的提问怎么联动：
 * - 父对话关掉提问：已有子对话一起关（引擎按各自任务的 askUser 判断，只改界面看着关是不够的）；
 * - 父对话重新打开：只开自己，已有子对话保持各自的选择；
 * - 右键菜单「子对话也提问」改的是「之后新建的子对话默认开不开」，勾上时再让用户选已有的要不要一起开。
 *
 * 服务端 PATCH 和界面共用这一份结论，避免两边各写一套规则后对不上。
 */

/** 新建子对话默认开启提问：没有父对话上的记录时按这个值 */
export const CHILD_ASK_DEFAULT = true

/** 父对话当前的两位开关：自己问不问、之后新建的子对话默认问不问 */
export interface ChildAskState {
  askUser: boolean
  childAskUser: boolean
}

/** 这一次 PATCH 的意图：界面传上来的字段子集 */
export interface ChildAskPatch {
  /** 父对话点按钮切换自己的「提问」 */
  askUser?: boolean
  /** 右键菜单改「子对话也提问」 */
  childAskUser?: boolean
  /** 一次性动作：这次改 childAskUser 时，已有子对话要不要跟着改 */
  applyExisting?: boolean
}

/** 服务端按它写任务、改子对话；undefined 表示这一项这次不动 */
export interface ChildAskEffect {
  askUser?: boolean
  childAskUser?: boolean
  /** 已有子对话的提问要改成什么：true 全开、false 全关、undefined 不动 */
  existingChildren?: boolean
}

/** 右键菜单里「子对话也提问」勾没勾：父对话自己关着时跟着显示未勾选，重新打开后回到原来的值 */
export function childAskChecked(state: ChildAskState): boolean {
  return state.askUser && state.childAskUser
}

/**
 * 这次改动要落到哪里。
 *
 * 菜单项优先于按钮：它的语义就是「子对话也提问」，勾上时父对话自己也得开着，否则勾了显示不出来。
 */
export function childAskEffect(patch: ChildAskPatch): ChildAskEffect {
  if (patch.childAskUser !== undefined) {
    // 取消勾选只影响之后新建的子对话，已有子对话保持不动（用户按一下就该停，不弹窗）
    if (!patch.childAskUser) return { childAskUser: false }
    return {
      childAskUser: true,
      askUser: true,
      // 只有用户明确选了「应用到已创建的子对话」才动已有的
      existingChildren: patch.applyExisting ? true : undefined,
    }
  }
  if (patch.askUser === undefined) return {}
  // 从开变关：已有子对话一起关，立即生效
  if (!patch.askUser) return { askUser: false, existingChildren: false }
  // 从关变开：只开自己；childAskUser 没被改过，菜单项自然回到勾选
  return { askUser: true }
}

/** 新建子对话时它的「提问」初始值：跟着父对话上存的「子对话也提问」走，老任务没有记录时按默认 */
export function childAskInitial(parent: Partial<ChildAskState>): boolean {
  return parent.childAskUser ?? CHILD_ASK_DEFAULT
}

/** 新建父对话时它的「子对话也提问」初始值：设置里的全局默认，用户没改过设置时按默认 */
export function childAskDefaultOf(settings?: { childAskUserDefault?: boolean }): boolean {
  return settings?.childAskUserDefault ?? CHILD_ASK_DEFAULT
}

/**
 * 子对话提示词里「有问题怎么办」那一节，按子对话自己的「提问」开关二选一（用户 2026-10-31 定的）：
 * - 关着：自己决定，不交给用户也不交给父对话；
 * - 开着：用提问工具问，面板把问题交给父对话（父对话开着提问再转给用户，关着由它的 AI 作答），答案按回话交回来。
 * 界面把「没在跑、也没有提问」的子对话当成已完成：开着时要求先把提问发出去再停，不能安静地停下把未决的问题藏起来。
 * roleAsks：角色（或它引入的通用约束）里已经写了「先提问」，开着时不再重复
 */
export function childAskPrompt(askUser: boolean, roleAsks: boolean): string {
  if (!askUser)
    return `## 「提问」关着：自己决定
你的问题不交给用户，也不交给父对话。遇到拿不准的地方按已有信息选最合理的做法继续，不可逆的操作选最保守的做法；结论里写清「你替自己决定了什么、依据、不对怎么改」。不要因为等回答而停下；和角色设定里「先提问」的要求不一样时以这里为准。`
  if (roleAsks) return ''
  return `## 停下之前先提问
子对话的「已停止」只由用户或父对话主动停止产生，你不要安静地停下。遇到拿不准的、需要用户确认的、不可逆的操作、缺外部信息时：用提问工具（有原生提问的用原生方式，没有的用面板的 ask_user）把问题、选项和各自的后果写清楚，问题会交给父对话（父对话开着「提问」时再转给用户）；要父对话决定时也可以用 message_parent 并把 question 设为 true。先把提问发出去再结束这一轮，不要只在结论里写一句「待确认」；回答会作为父对话的回话交回给你。`
}
