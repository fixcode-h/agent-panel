/**
 * 引擎宿主里的「自建工具」（custom_tool，ADR 0082）：工具清单、执行、授权、P4 签出、保存弹窗都在服务端
 * （server/custom-tools/agent.ts），引擎只转交调用、把清单那一行放进用法说明
 */

export interface CustomToolCall {
  action: 'list' | 'show' | 'run' | 'test' | 'save' | 'locate'
  id?: string
  /** locate：程序名（luac）、本机完整路径；forget 为 true 时删掉这条登记 */
  program?: string
  path?: string
  forget?: boolean
  query?: string
  args?: Record<string, unknown>
  draft?: Record<string, unknown>
  dryRun?: boolean
  note?: string
}

/** 调用方（面板工具）带过来的：守卫和后台命令挂在 Orchestra 上，宿主那边拿不到 */
export interface CustomToolCallCtx {
  signal?: AbortSignal
  /** 命令过工具前守卫（和 CLI 跑命令同一套）：拒绝时返回原因 */
  guard?: (command: string) => Promise<string>
  /** 跑得久的交给后台命令，跑完推回对话 */
  background?: (input: { command: string; name: string; cwd: string; timeoutMinutes: number }) => Promise<{
    ok: boolean
    info: string
  }>
}

export interface CustomToolsApi {
  /** 提示词里那一行清单和已登记的程序位置（这一轮开始时算好）；都没有时是空串 */
  hint: string
  call: (req: CustomToolCall, ctx: CustomToolCallCtx) => Promise<{ text: string; error?: boolean }>
}

export interface CustomToolsHost {
  customTools?: CustomToolsApi
}

export interface OrchCustomTools {
  customTools?: CustomToolsApi
}
