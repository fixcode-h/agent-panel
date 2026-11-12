// 编译和后台命令：UE 编译申请、测试步骤、后台命令的起停查。
// 从 shared/engine-host.ts 的 EngineHost / Orchestra 两个大接口里按能力拆出来（重构文档第 5 条），
// 新能力加进对应的小接口或新开一个，不再往大接口上加；成员数由 scripts/structure-check.mjs 盯着
import type { TestStep } from '../schema.ts'

/** Orchestra 里编译和后台命令的那部分（重构文档第 5 条：按能力拆成小接口，Orchestra 只是它们的组合） */
export interface OrchBuild {
  /** 对话（项目对话、子对话）：长命令交给面板在后台跑，跑完把结果推回这个对话 */
  canBackground: boolean
  runBackground(input: {
    command: string
    name: string
    cwd: string
    exclusive: boolean
    timeoutMinutes?: number
    service?: boolean
    step?: string
  }): Promise<{
    ok: boolean
    info: string
  }>
  /** 后台命令的命令过工具前守卫（runner 装上，见 server/hooks/dispatch.ts 的 commandGuard）：拒绝时返回原因 */
  guardCommand?: (command: string) => Promise<string>
  /**
   * 插件的改文件类工具（McpTool.effect = 'edit'）执行前过工具前守卫（runner 装上，见 server/hooks/dispatch.ts 的 editGuard）：
   * 只读身份、Bug 先诊断、独立分支越界、凭据这些规则以前只认 CLI 自己的改文件工具。拒绝时返回原因
   */
  guardEdit?: (tool: string, paths: string[], input: Record<string, unknown>) => Promise<string>
  checkBackground(id: string): string
  stopBackground(id: string): { ok: boolean; info: string }
  /** UE 项目：子对话向父对话申请编译、父对话向面板占位编译；不是 UE 项目时为空 */
  ueBuild: '' | 'child' | 'parent'
  /** children：父对话替哪些子对话申请（结果也推给它们） */
  requestBuild(note: string, step?: string, children?: string[]): Promise<{ ok: boolean; info: string }>
}

/** EngineHost 里编译和后台命令的那部分 */
export interface BuildHost {
  /**
   * UE 项目的编译归父对话（项目目录里有 .uproject 时才有）。
   * child：子对话不编译，改完向父对话申请；build 为 true 的 submit_merge 合回去后也自动申请。
   * parent：父对话收到申请（或用户要求）后向面板占位编译，面板按编译目录排队：同一目录同一时间只编译一次，
   * 各自 worktree 的目录互不占位；结果推回父对话
   */
  ueBuild?: {
    role: 'child' | 'parent'
    request: (note: string, children?: string[]) => Promise<{ ok: boolean; info: string; id?: string }>
  }
  /**
   * 对话里怎么验证：项目的测试步骤和「按改动大小决定验证范围」开关。
   * 不传时提示里不带这一段（没有项目的聊天、在线演示）
   */
  verify?: {
    steps: TestStep[]
    platform: string
    wslDistro: string
    scaled: boolean
    /**
     * 范围为 parent（全量、合并后由父对话跑）的步骤由谁跑（见 ADR 0018 / 0020）：独立分支的子对话是 child（它不跑），
     * 父对话是 parent（面板自动跑、结果直接回传子对话）。只有 Git 项目、这些步骤真的生效时才传
     */
    parentRun?: 'child' | 'parent'
    /**
     * 这次任务实际改了哪些文件（服务端从 git 改动统计来）：有它就在提示词里直接给出「本轮该跑哪几条 + 命令」，
     * 不再只给规则让 Agent 自己筛
     */
    changedFiles?: string[]
  }
  /**
   * 后台命令：面板在这个对话的目录里跑，马上返回编号；跑完把结果推回对话（正在执行就插话，空闲就开新的一轮）。
   * exclusive 的（编译这类）按项目排队，同一时间只跑一个
   */
  runBackground?: (input: {
    command: string
    name: string
    cwd: string
    exclusive: boolean
    timeoutMinutes?: number
    /** 开发服务器、监听这类常驻进程：不催、不挂计划等待，对话不算在等它（server/background.ts 的 BgJob.service） */
    service?: boolean
    /** 发起它的子任务步骤：子任务调用时写它自己的步骤 id，结果推回时据此标注来源 */
    step?: string
  }) => Promise<{
    ok: boolean
    info: string
    /** 后台命令的编号：计划步骤挂等待时用，结果回来按它找到步骤 */
    id?: string
  }>
  /** 查后台命令：不传编号列出这个对话的全部 */
  checkBackground?: (id: string) => string
  /** 停掉这个对话的一条后台命令：对话看出它卡住了时用 */
  stopBackground?: (id: string) => { ok: boolean; info: string }
}
