/**
 * 引擎宿主里的「查代码」（find 工具的 symbol / refs / outline / members / include / text，ADR 0081 能力路由）：
 * 服务端按语言挑路（VS、IDEA、面板文本兜底）、合并结果、拼好文字，引擎只转交。找文件那一半在 file-index.ts
 */
import type { FindHit, FindRequest, MissingProgram } from '../capability-router/find/types.ts'
import type { ToolRoute } from '../capability-router/tool-route.ts'

/**
 * route：这次实际走了哪几条路（工具卡片上的小标）；出错前没走成路由时没有。
 * hits：合并好的命中（分页前），工具网关接管搜索命令时拿它和原命令的结果合（ADR 0084 第二期）
 */
export type FindCodeRun = (
  req: FindRequest,
  signal?: AbortSignal,
) => Promise<{ text: string; error?: boolean; route?: ToolRoute; hits?: FindHit[]; missing?: MissingProgram[] }>

export interface FindCodeHost {
  /** 在项目里就有（项目关了文件索引时只有外部路，没有文本兜底）；提示词里「找文件、找代码」一节也按它写 */
  findCode?: FindCodeRun
}

export interface OrchFindCode {
  findCode?: FindCodeRun
}
