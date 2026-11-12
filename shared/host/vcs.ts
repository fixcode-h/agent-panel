// 版本管理：独立分支、合回、就地微改动、P4 分 changelist、cherry-pick、推送授权、评审差异。
// 从 shared/engine/host.ts 的 EngineHost / Orchestra 两个大接口里按能力拆出来（重构文档第 5 条），
// 新能力加进对应的小接口或新开一个，不再往大接口上加；成员数由 scripts/structure-check.mjs 盯着
import type { ReviewDiff, RouteInput } from '../engine/host.ts'
import type { HandoffInput } from '../handoff.ts'
import type { ReviewOverride, TriageItem } from '../review-gate.ts'

/** Orchestra 里版本管理的那部分（重构文档第 5 条：按能力拆成小接口，Orchestra 只是它们的组合） */
export interface OrchVcs {
  /** 子对话请父对话收尾：独立分支里由父对话合回原分支，共用目录、P4、没有版本管理时由父对话验收（结果推回来） */
  canSubmit: boolean
  /** 子对话在自己的独立分支里（Git worktree）：收尾时面板提交并合回；不在的改动已经在父对话的目录里 */
  isolated: boolean
  /** 要改文件时才开独立分支的对话：还没开，改文件前先调用 begin_edit */
  canBeginEdit: boolean
  beginEdit(): Promise<{ ok: boolean; info: string }>
  submitMerge(
    note: string,
    tests: string,
    build?: boolean,
    handoff?: HandoffInput,
    /** 对最近一次评审每条高级、中级意见的处置（见 shared/review-gate.ts、ADR 0009） */
    triage?: TriageItem[],
    /** 显式放行（用户明确要求「已知问题也合并」）：门禁真的拦下时才生效，记录写在任务上 */
    override?: ReviewOverride,
  ): Promise<{ ok: boolean; info: string }>
  /** 父对话可以就地做微小改动（shared/inline-edit.ts） */
  inlineEdit: boolean
  beginInlineEdit(files: string[], reason: string, route?: RouteInput): Promise<{ ok: boolean; info: string }>
  endInlineEdit(): Promise<{ ok: boolean; info: string }>
  /** P4 工作区：按文件类型把改动分进各自的 pending（面板执行，不是 P4 项目时没有） */
  p4Split?: VcsHost['p4Split']
  /** 项目设了 cherry-pick 目标：由面板核对后搬（只收这个对话自己的提交 / 改动，见 server/cherry-pick.ts） */
  cherryPick?: VcsHost['cherryPick']
  /** 推送授权（ask_push，见 shared/push-auth.ts）：只有项目推送策略为「问一次」的顶层对话有 */
  askPush?: (input: { branch?: string; summary?: string }) => Promise<{ ok: boolean; info: string }>
}

/** EngineHost 里版本管理的那部分 */
export interface VcsHost {
  /** 子对话怎么隔离（项目设置里选）：worktree 各自独立分支、在里面验证完合回原分支，claim 共用目录认领文件 */
  childIsolation?: 'claim' | 'worktree'
  /** 父对话所在目录现在的分支：父对话不开独立分支，子对话从这里开、合回这里 */
  branch?: string
  /** 在独立分支里时：分支要合回去的目录（开分支的那个目录，在原分支上）。父对话要推送时先合到这里再推；子对话的完成只管合回这里，与推送无关 */
  worktreeHome?: string
  /** 子对话在自己的独立分支（Git worktree）里：分支目录、提交和合回都由面板管 */
  isolated?: boolean
  /**
   * 子对话请父对话收尾（不管用哪种版本管理都有）：评审、测试、交接、待回答的提问都在这里校验。
   * 独立分支里的由父对话合回原分支（面板排队试合并，有冲突撤回，结果推回子对话）；其余的由父对话验收后标完成
   */
  submitMerge?: (
    note: string,
    tests: string,
    build?: boolean,
    handoff?: HandoffInput,
    triage?: TriageItem[],
    override?: ReviewOverride,
  ) => Promise<{ ok: boolean; info: string }>
  /**
   * 要改文件时才开独立分支、现在还没开：面板从当前目录建 worktree，这一轮结束后在里面接着做（能跨目录续接的 CLI 带着原会话过去）。
   * 只有对话有（工作流在创建时就建好了）
   */
  beginEdit?: () => Promise<{ ok: boolean; info: string }>
  /**
   * 父对话的就地微改动（只有项目顶层对话、角色开了 inlineEdit 时有）：begin 校验护栏并记下基线，
   * end 按真实改动核对、越界时写提示（见 shared/inline-edit.ts）
   */
  inlineEdit?: {
    begin(files: string[], reason: string): Promise<{ ok: boolean; info: string }>
    end(): Promise<{ ok: boolean; info: string }>
  }
  /**
   * 交给评审的改动（git 仓库才有）：since 是上一轮评审记下的快照，给了就只取那之后的增量。
   * 派「评审」时面板一次把差异带进提示词，评审只看代码，不用自己一个回合一个回合地 git diff、读文件（ADR 0010）
   */
  reviewDiff?: (since?: string, files?: string[]) => Promise<ReviewDiff | null>
  /** P4 工作区（项目里的对话）：按文件类型分 changelist，由面板跑 p4，规则不靠 Agent 自觉 */
  p4Split?: (input: P4SplitArgs) => Promise<{ ok: boolean; info: string }>
  cherryPick?: (input: { commits?: string[]; changelist?: string }) => Promise<{ ok: boolean; info: string }>
  /** 弹推送授权卡等用户点（回答由宿主记进 task.remotePush，不受「提问」开关影响）；停止时 null */
  askPush?: (info: { branch?: string; summary?: string }) => Promise<{ allow: boolean; message?: string } | null>
}

/** p4_split_changelists 的参数：从哪个 changelist 分、只分哪些文件、每类一句描述 */
export interface P4SplitArgs {
  from?: string
  files?: string[]
  descriptions: Partial<Record<'C++' | 'XLSX' | 'Lua' | 'Other', string>>
}
