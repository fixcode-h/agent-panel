/** tasksApi 各模块共用的常量和小工具（不依赖闭包里的状态）：规则命令、执行位冲突、独立分支判定、VCS 探测、收尾种类 */
import { Task, type Project } from '../../shared/schema.ts'
import { gitHasRemote } from '../exec/git.ts'
import { currentTestSteps, parentRunRoleOf, parentRunSteps } from '../../shared/test-steps.ts'
import { wrapUpKind, type WrapUpAnswer } from '../../shared/plan.ts'
import { detectVcs } from '../projects-analyze.ts'
import type { Live } from './types.ts'

/** 发布全局规则的命令：/rule 或 /rules */
export const RULE_CMD = /^\/rules?(?=\s|$)/i

/** 同一个任务已经有执行位时又要发消息：路由按 409 处理，不能当成 500 */
export class TaskBusyError extends Error {}

/** 停止后无论如何不再等它的上限：进程杀不掉、引擎卡住都按停止收口、让出执行位（见 keepalive.ts 的 watchStop） */
export const STOP_GIVE_UP_MS = 30_000

/**
 * 「继续执行」这类要求对话空着的操作，先等执行位上那一份收完：
 * 这一轮已经结束、还在落盘的照旧等它；正在停下的（停止刚点、进程已经杀了、引擎还没收完）也等，
 * 不然停止后那一两秒里点「继续」会被当成「任务正在执行」拒掉。停下的最多等 STOP_GIVE_UP_MS：
 * 用户停止到这时一定已经收口（watchStop），别的原因停的也不把请求一直挂着
 */
export async function settleBefore(prev: Live | undefined) {
  if (!prev?.done) return
  if (prev.task.status !== 'running') return void (await prev.done.catch(() => {}))
  if (!prev.stop) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    prev.done.catch(() => {}),
    new Promise<void>((r) => {
      timer = setTimeout(r, STOP_GIVE_UP_MS)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
}

/** 任务还在用自己的独立分支（没合并也没丢弃） */
export const isolated = (tk: Pick<Task, 'worktree'>) => tk.worktree?.state === 'active'

/** 用户点「解决」时等子任务停下来的上限和轮询间隔：停不下来就如实报错，不静默把在跑的步骤抹成完成 */
export const HELPER_STOP_TIMEOUT_MS = 15_000
export const HELPER_STOP_POLL_MS = 150

/** 对话搜索的缓存上限：留多少个对话、合计多少字符（超了按最久没用的丢，见 cachedMessages） */
export const SEARCH_CACHE_TASKS = 40
export const SEARCH_CACHE_CHARS = 8_000_000

/**
 * 兜底回收「任务已收口、CLI 还活着」时给的缓冲：停止是异步的（3 秒后才补杀），
 * 别把正在退出的进程当僵尸再杀一次、再写一条日志
 */
export const REAP_GRACE_MS = 60_000

/** 项目目录是不是 P4 工作区：每轮都要判断，结果按目录记住（工作区类型不会在运行中变） */
const p4Dirs = new Map<string, Promise<boolean>>() // 模块状态：缓存，丢了重算
/** 项目目录是不是 Git 仓库（ADR 0018 / 0020 的 parent 范围只对 Git 生效）：判定和缓存同 isP4 */
const gitDirs = new Map<string, Promise<boolean>>() // 模块状态：缓存，丢了重算
export const isGit = (dir: string) => {
  let got = gitDirs.get(dir)
  if (!got) {
    got = detectVcs(dir)
      .then((v) => v.vcs === 'git')
      .catch(() => false)
    gitDirs.set(dir, got)
  }
  return got
}

/**
 * 范围是 parent 的步骤在这个对话里由谁跑（ADR 0018 / 0020）：只对 Git 项目生效。
 * 独立分支的子对话是 child（它不跑，合并后父对话跑）；顶层父对话是 parent（面板自动跑、结果直接回传子对话）；
 * 共用目录的子对话、P4 / SVN / 没有版本控制时返回空，步骤照常由 Agent 自己跑。
 * 步骤按项目当前设置判断（用户口径：调用前现读配置）：改了项目设置，进行中的对话下一次判断就按新配置走；
 * 项目被删、读不到时才退回任务快照。
 */
export async function parentRunRole(tk: Task, project: Project): Promise<{ parentRun?: 'child' | 'parent' }> {
  const steps = currentTestSteps(tk.testSteps, project)
  if (!parentRunSteps(steps).length) return {}
  // 独立分支一定是 Git 仓库，不用再探；顶层对话是否 Git 要问 detectVcs（判定和开 worktree 时同一套）
  const git = isolated(tk) || (await isGit(project.path))
  const role = parentRunRoleOf({ child: !!tk.parentTaskId, isolated: isolated(tk), git, steps })
  return role ? { parentRun: role } : {}
}
export const isP4 = (dir: string) => {
  let got = p4Dirs.get(dir)
  if (!got) {
    got = detectVcs(dir)
      .then((v) => v.vcs === 'p4')
      .catch(() => false)
    p4Dirs.set(dir, got)
  }
  return got
}

/** 收尾判定要的工作区事实（是不是 P4、Git 有没有远端）：这一轮开始时探一次，之后按推送授权现算收尾 */
export type WrapProbe = { p4: boolean; git: boolean } | undefined

/** 探测工作区：不是对话、没有项目目录、父对话明确不推送时不用探（gitHasRemote 要起 git 进程） */
export async function wrapUpProbe(
  tk: Task,
  projectPath: string | undefined,
  policy: Project['gitPolicy'] | undefined,
): Promise<WrapProbe> {
  if (tk.mode !== 'chat' || !projectPath || (!tk.parentTaskId && policy === 'deny')) return undefined
  // 有没有远端、是不是 Git 都按真实工作区判断：SVN、没有远端的本地仓库加一步推送收尾，它永远做不了
  const [p4, git] = await Promise.all([isP4(projectPath), gitHasRemote(projectPath)])
  return { p4, git }
}

/**
 * 这个对话计划最后一步的收尾（见 plan.ts 的 wrapUpKind 和 ensureWrapUp）：子对话是独立分支合回父对话所在的
 * 分支（P4 工作区按文件类型分 changelist，共用目录的 Git 子对话不用收尾），父对话是明确授权推送时把分支推到远端。
 * 同步现算：推送授权（task.remotePush）会在保活中途被用户点上，run.ts 把它写成 getter，每次拼提示、交计划时读现值。
 * 返回 undefined 表示「这一轮算不出来」（项目目录或远端没探测到），此时计划里已有的收尾保持原样
 */
export function wrapUpFrom(
  tk: Task,
  probe: WrapProbe,
  policy: Project['gitPolicy'] | undefined,
): WrapUpAnswer | undefined {
  if (tk.mode !== 'chat') return undefined
  const child = !!tk.parentTaskId
  const isolatedChild = isolated(tk) || !!tk.wantsWorktree
  // 明确不推：项目设置不许推、或这个对话里用户拒绝过。这时才去掉计划里还挂着的推送收尾
  // （只对父对话成立：子对话本来就不碰远端，它的收尾是合回分支 / 分 changelist，不推送也要照做）
  if (!child && (policy === 'deny' || tk.remotePush === 'denied')) return 'none'
  // 项目目录没取到（项目被删、读失败）时不知道有没有远端，先不算，别把已有的收尾删掉
  if (!probe) return undefined
  return wrapUpKind({ child, isolated: isolatedChild, ...probe, push: policy, answered: tk.remotePush })
}

/** 打开对话页时后台启动 CLI 用的提示：只让它停在等下一句上，不做任何事 */
export const PREWARM_PROMPT =
  '（面板预热：用户还没有发新消息。不要回复任何内容，也不要调用其他工具，直接调用 wait_user_message 等用户的下一条消息。）'
