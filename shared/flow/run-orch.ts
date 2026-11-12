/**
 * 父对话操作工作流运行的那几样（docs/openspec/changes/workflow-runs/design.md 第 4 节）：
 * 父对话下指令（起、补充、调整、代答、终止、合回），运行回信（等决定、待合回、完成、终止）。
 * 真正的事由宿主（server/tasks/flow-runs.ts）做；这里只做参数检查、把运行挂进父对话的计划等待。
 * 从 engine.ts 拆出来（那个文件到了行数上限），引擎在 makeOrchestra 里把它摊进编排工具。
 */
import type { RunEntry, PickedFlow } from './run.ts'
import { runLine } from './run.ts'
import { bindWait, ensureChildStep } from '../plan.ts'
import type { Task } from '../schema.ts'

/** 补充要求交给谁：current 正在跑的节点；later 之后所有节点（运行级说明）；其余当成节点名 / id */
export type RunTarget = 'current' | 'later' | (string & {})

/** 宿主实现的运行操作：都返回给模型看的一句话 */
export interface FlowRunHost {
  start(input: PickedFlow & { input: string; title: string; files?: string[] }): Promise<{
    ok: boolean
    id?: string
    info: string
  }>
  list(): Promise<RunEntry[]>
  message(id: string, text: string, to: RunTarget): Promise<{ ok: boolean; info: string }>
  revise(id: string, node: string, text: string): Promise<{ ok: boolean; info: string }>
  answer(id: string, allow: boolean, text: string): Promise<{ ok: boolean; info: string }>
  stop(id: string, why: string): Promise<{ ok: boolean; info: string }>
  finish(id: string, action: 'merge' | 'discard'): Promise<{ ok: boolean; info: string }>
}

export interface RunTools {
  startWorkflow(
    picked: PickedFlow,
    input: string,
    title: string,
    files?: string[],
    step?: string,
  ): Promise<{ ok: boolean; id?: string; info: string }>
  listWorkflows(): Promise<string>
  messageWorkflow(id: string, text: string, to: RunTarget): Promise<{ ok: boolean; info: string }>
  reviseWorkflow(id: string, node: string, text: string): Promise<{ ok: boolean; info: string }>
  answerWorkflow(id: string, allow: boolean, text: string): Promise<{ ok: boolean; info: string }>
  stopWorkflow(id: string, why: string): Promise<{ ok: boolean; info: string }>
  finishWorkflow(id: string, action: 'merge' | 'discard'): Promise<{ ok: boolean; info: string }>
}

const NO = { ok: false, info: '只有项目里能启动工作流的父对话能操作工作流运行' }

/** 只给能启动工作流的父对话；其余调用一律回 NO（子对话、子任务、节点都不能操作运行） */
export function runTools(task: Task, runs: FlowRunHost | undefined, allowed: boolean, changed: () => void): RunTools {
  const ok = allowed && !!runs
  const need = (s: string, what: string) => (s.trim() ? '' : `${what}不能为空`)
  return {
    async startWorkflow(picked, input, title, files, step) {
      if (!ok) return NO
      const bad = need(input, 'input')
      if (bad) return { ok: false, info: `${bad}：写清楚这次要做什么、范围和验收标准` }
      const r = await runs!.start({ ...picked, input: input.trim(), title, files })
      if (!r.ok || !r.id) return r
      // 运行挂到计划里的一步：父对话的计划看得到「在等工作流」，运行结束时由宿主结算（settleWait kind workflow）
      const at = step?.trim() || ensureChildStep(task, r.id, title)
      const wait = at ? bindWait(task, at, { kind: 'workflow', ref: r.id, label: title }) : ''
      changed()
      return { ok: true, id: r.id, info: [r.info, wait].filter(Boolean).join('\n') }
    },
    async listWorkflows() {
      if (!ok) return NO.info
      const list = await runs!.list()
      return list.length ? list.map((e) => `- ${runLine(e)}`).join('\n') : '名下还没有工作流运行'
    },
    async messageWorkflow(id, text, to) {
      if (!ok) return NO
      return need(text, 'text') ? { ok: false, info: need(text, 'text') } : runs!.message(id.trim(), text.trim(), to)
    },
    async reviseWorkflow(id, node, text) {
      if (!ok) return NO
      if (!text.trim()) return { ok: false, info: 'text 不能为空：写清楚要怎么改' }
      return runs!.revise(id.trim(), node.trim(), text.trim())
    },
    async answerWorkflow(id, allow, text) {
      if (!ok) return NO
      if (!allow && !text.trim()) return { ok: false, info: '要修改时 text 写清楚改什么' }
      return runs!.answer(id.trim(), allow, text.trim())
    },
    async stopWorkflow(id, why) {
      return ok ? runs!.stop(id.trim(), why.trim() || '父对话终止了这次运行') : NO
    },
    async finishWorkflow(id, action) {
      return ok ? runs!.finish(id.trim(), action) : NO
    },
  }
}
