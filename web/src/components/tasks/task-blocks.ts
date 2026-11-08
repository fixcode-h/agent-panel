/**
 * 对话页把消息分成一段一段（一轮对话、一组节点输出、一次工作流运行）：从 TaskView.tsx 拆出来，
 * 那边只留渲染。分段规则只写这一处
 */
import { visibleMessages } from '@shared/end-turn'
import { MAIN_STEP, rootStepId } from '@shared/flow'
import type { Task, TaskMessage } from '@shared/schema'

export type Block =
  | { kind: 'msg'; m: TaskMessage }
  /** 对话里 Agent 连续的回复（一轮），完成后折叠过程 */
  | { kind: 'turn'; key: string; msgs: TaskMessage[] }
  | { kind: 'steps'; key: string; roots: string[]; byRoot: Map<string, TaskMessage[]> }
  /** 工作流的一次运行：节点输出去右边的面板里看 */
  | { kind: 'run'; key: string; run: number }

/** 这一段里有哪些消息：轮次目录跳到某条消息时找它在第几段（被折叠在更早的段里时先显示出来） */
export function blockMsgIds(b: Block): string[] {
  if (b.kind === 'msg') return [b.m.id]
  if (b.kind === 'turn') return b.msgs.map((m) => m.id)
  if (b.kind === 'steps') return [...b.byRoot.values()].flat().map((m) => m.id)
  return []
}

/** 以前新建子对话时记的系统提示（中文、英文界面各一种写法） */
const OLD_CREATED =
  /^(新建了子对话「.*」，这条消息交给它处理|Created sub-conversation “.*”; this message is handed to it)$/

/** 以前开独立分支时记的居中提示：现在 begin_edit 这次调用本身显示成「开独立分支 分支名」 */
const OLD_WORKTREE = /^(要改文件了，已开独立分支 |Ready to edit files: opened separate branch )/

/** 这条消息属于第几次运行（节点 id 带 `r2/` 前缀的算第 2 次） */
function runOf(step: string) {
  const m = /^r(\d+)\//.exec(step)
  return m ? Number(m[1]) : 1
}

/**
 * 把消息分段：连续的节点输出归到一段，段里再按主流程节点分开，同时执行的节点输出不会交错。
 * 工作流任务（主 Agent 是编排器）里节点输出不铺在对话里，按运行归成一张卡片
 */
export function toBlocks(task: Task): Block[] {
  const blocks: Block[] = []
  // 面板提醒、end_turn 和它之后的那句收尾不画进对话，只在「状态」里看（shared/end-turn.ts）
  const msgs = visibleMessages(task.messages).msgs
  // 有工作流运行的对话：一次运行一张卡片，没有单独的节点段。节点输出不铺在对话里，
  // 按「第一次出现这次运行」的位置放卡片，后面的节点消息都跳过
  const byRun = task.mode === 'workflow' || (task.runs?.length ?? 0) > 0
  const carded = new Set<number>()
  // 往后找第一条带节点的消息：判断这条用户消息后面还有没有同一个节点的输出
  const nextRoot = (from: number) => {
    for (let i = from; i < msgs.length; i++) if (msgs[i].step) return rootStepId(msgs[i].step)
    return undefined
  }
  // 对话里派出的子角色：它们的输出收进派出时那张子任务卡片，不平铺在父对话里打断父对话的回复
  const helpers = byRun ? [] : msgs.flatMap((m) => m.spawned ?? [])
  const inHelper = (step: string) => helpers.some((id) => step === id || step.startsWith(`${id}/`))
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.step && helpers.length && inHelper(m.step)) continue
    // 旧对话里新建子对话时记的居中提示：现在这次工具调用本身就显示成「新建子对话 标题」，不再重复
    if (m.role === 'system' && !m.step && OLD_CREATED.test(m.text)) continue
    if (m.role === 'system' && !m.step && !m.panel && OLD_WORKTREE.test(m.text)) continue
    // 派出的子任务、面板推回的结果（后台命令、合并编译、子任务结果）都是 AI 这一轮回复里的一行，
    // 归进当前这轮回复，不单独成段，也不显示成用户消息
    // 父对话交代的任务、回答（role 是 user）：自成一段，画成「接收消息」，不显示成用户消息
    if (!m.step && m.peer && m.role === 'user') {
      blocks.push({ kind: 'msg', m })
      continue
    }
    if (!m.step && ((!byRun && m.spawned?.length) || m.panel || m.peer)) {
      const b = blocks.at(-1)
      if (b?.kind === 'turn') b.msgs.push(m)
      else blocks.push({ kind: 'turn', key: m.id, msgs: [m] })
      continue
    }
    // 没有节点的用户消息（对话里、工作流外的追加要求）单独成一段；
    // 执行中补发的要求后面还有同一个节点的输出时，留在那个节点的竖线里，不另起一段
    if (m.role === 'user' && !m.step) {
      const b = blocks.at(-1)
      const root = b?.kind === 'steps' ? b.roots.at(-1) : undefined
      if (!byRun && b?.kind === 'steps' && root && nextRoot(i + 1) === root) {
        b.byRoot.get(root)!.push(m)
        continue
      }
      blocks.push({ kind: 'msg', m })
      continue
    }
    // 主 Agent 自己的会话（编排器，`@main` 或委派里的 `<父节点>/…/@main`）留在对话里，不属于任何一次运行
    if (!m.step || m.step.endsWith(MAIN_STEP)) {
      // 对话里 Agent 连续的回复归到一轮
      if (m.role === 'agent') {
        const b = blocks.at(-1)
        if (b?.kind === 'turn') b.msgs.push(m)
        else blocks.push({ kind: 'turn', key: m.id, msgs: [m] })
      } else blocks.push({ kind: 'msg', m })
      continue
    }
    if (byRun) {
      // 同一个运行的节点输出只在第一次出现时放一张卡片，其余的都去卡片里看
      const run = runOf(m.step)
      if (carded.has(run)) continue
      carded.add(run)
      blocks.push({ kind: 'run', key: `run${run}`, run })
      continue
    }
    let b = blocks.at(-1)
    if (b?.kind !== 'steps') {
      b = { kind: 'steps', key: m.id, roots: [], byRoot: new Map() }
      blocks.push(b)
    }
    const root = rootStepId(m.step)
    if (!b.byRoot.has(root)) {
      b.roots.push(root)
      b.byRoot.set(root, [])
    }
    b.byRoot.get(root)!.push(m)
  }
  // 正在执行但还没有输出的节点也显示出来
  if (task.status === 'running') {
    const running = task.steps.filter((s) => !s.parentId && s.status === 'running' && s.kind !== 'main')
    if (byRun) {
      // 运行开始执行、还没有任何输出时也要有一张卡片
      for (const s of running) {
        const run = runOf(s.id)
        if (carded.has(run)) continue
        carded.add(run)
        blocks.push({ kind: 'run', key: `run${run}-live`, run })
      }
    } else {
      let b = blocks.at(-1)
      if (running.length && b?.kind !== 'steps') {
        b = { kind: 'steps', key: 'live', roots: [], byRoot: new Map() }
        blocks.push(b)
      }
      if (b?.kind === 'steps')
        for (const s of running)
          if (!b.byRoot.has(s.id)) {
            b.roots.push(s.id)
            b.byRoot.set(s.id, [])
          }
    }
  }
  return blocks
}
