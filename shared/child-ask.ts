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
