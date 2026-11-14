import type { Dispatch, SetStateAction } from 'react'
import type { Project, ProjectInput } from '@shared/schema'
import type { Proposal } from '@shared/assist'
import { readProjectProposal } from '@shared/projects/init'

/**
 * 项目设置弹窗各分区共用的类型和草稿工具（从 ProjectSettingsDialog.tsx 挪出）。
 * 草稿是一整份 ProjectInput，点「确认」才保存；各分区只按自己那几个字段改它。
 */

/**
 * 一次 AI 优化会话。参数在打开时快照下来：关掉项目设置后 Body 卸载了，
 * 对话还要接着跑，不能依赖表单里的草稿。
 */
export type AiSession = {
  kind: 'params' | 'teststeps' | 'project'
  workflowId?: string
  agentId?: string
  title: string
  /** 打开就直接发给 CLI 的要求：点「AI 配置」不用再自己写一遍 */
  start?: string
  /** AI 初始化要的目录和扫描线索（Body 关掉后草稿就没了，先存下来） */
  subject?: Record<string, string>
  /** 在新建项目里开的会话，会话没结束项目就先保存了：结果要应用到这个项目，不能再按新建项目打开 */
  projectId?: string
}

/** 把 AI 结果填进表单：Body 挂载时注册，设置关着时先排队，重新打开后再应用 */
export type ApplyAi = (p: Proposal) => void

export type SetDraft = Dispatch<SetStateAction<ProjectInput>>
/** 改草稿里的一个字段 */
export type SetField = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => void

/** 本地目录的版本控制：「禁止子对话执行」、cherry-pick 目标和「文档根」都按它判断 */
export type Vcs = 'git' | 'p4' | 'svn' | 'none'

export const toInput = ({ id, createdAt, updatedAt, ...rest }: Project): ProjectInput => ({
  ...rest,
  // 数据文件是用户可改的：保存的推荐读不出来时当作没有推荐
  initResult: readProjectProposal(rest.initResult),
})
export const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? ''
export const blank: ProjectInput = {
  name: '',
  description: '',
  path: '',
  categoryId: '',
  workflowId: '',
  workflowIds: [],
  defaultAgentId: '',
  agentSet: true,
  workflowParams: {},
  agentParams: {},
  childIsolation: 'worktree',
  isolateByDefault: false,
  testSteps: [],
  scaledVerify: true,
  lessons: [],
  wslDistro: '',
  fileFormat: undefined,
  searchExclude: [],
  codeIndexTools: [],
  gitPolicy: 'ask',
  initializedAt: '',
  initResult: undefined,
}
