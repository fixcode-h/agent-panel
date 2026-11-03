/**
 * 工作流子对话的流程图阶段（ADR 0044）：起一次运行、接着上次停下的跑，或者带着父对话的意见重跑失败的节点。
 * 从 engine.ts 拆出来（它到了行数上限）：跑流程图、写消息、收尾这几样由引擎当参数传进来，这里不 import 引擎的实现。
 */
import type { EngineHost, Fail } from './engine.ts'
import { flowHandoffPrompt, flowPhase, nextUnfinished, reopenFailed } from './flow-child.ts'
import { topSteps } from './flow.ts'
import { clipToFile } from './helper-batch.ts'
import { t } from './i18n.ts'
import { clip } from './text.ts'

/** 引擎里跑流程图、写消息、收尾的那几样 */
export interface FlowRunDeps {
  startPlan: (
    host: EngineHost,
    plan: { workflowId: string; input: string },
    again?: number,
  ) => Promise<{
    ok: boolean
    text: string
    error?: string
    paused?: boolean
    stopped?: { why: string; changes: string }
  }>
  putMail: (host: EngineHost, id: string, text: string) => void
  system: (host: EngineHost, text: string, step?: string) => void
  finish: (host: EngineHost, r: Fail) => void
}

/**
 * 跑完返回交给执行角色收尾的话；停下、失败、被终止时这一轮在这里收口（任务状态已经写好），返回 undefined。
 * - 停下（暂停、面板重启、卡住重开）：节点按暂停收，继续时同一次运行从没做完的节点接着跑
 * - 节点失败：子对话按失败交回，父对话交回意见后失败的节点带着意见重跑
 * - 被父对话终止（stop_workflow）：没跑的节点不再跑，之后的消息交给执行角色
 */
export async function runChildFlow(host: EngineHost, d: FlowRunDeps): Promise<string | undefined> {
  const { task } = host
  const f = task.flow!
  const phase = flowPhase(task)!
  // 父对话这次交来的话（面板自己的续接说明不算）：交给重跑 / 接着跑的那个节点
  const said = phase !== 'start' && !host.resume ? host.prompt.trim() : ''
  const at =
    phase === 'retry' ? reopenFailed(task, f.run) : phase === 'continue' ? nextUnfinished(task, f.run) : undefined
  if (at && said) d.putMail(host, at.id, `父对话：${said}`)
  if (phase === 'start') f.run = (task.runSeq ?? 0) + 1
  const out = await d.startPlan(host, { workflowId: f.workflowId, input: f.input }, phase === 'start' ? 0 : f.run)
  if (out.ok) {
    f.handed = true
    d.system(host, t('工作流「{name}」跑完了，交给执行角色收尾', { name: f.workflowName }))
    host.changed(true)
    const id = `flow-${host.newId()}`
    return flowHandoffPrompt(
      f,
      await clipToFile(host.saveHandoff, { id, title: '工作流结果' }, out.text, 12000, '先读完。'),
    )
  }
  if (out.paused && !out.stopped) {
    d.finish(host, { ok: false, stopped: true, error: '' })
    return undefined
  }
  if (out.stopped) {
    f.cancelled = true
    const changes = out.stopped.changes ? `\n${t('这次运行改动了这些文件：')}\n${clip(out.stopped.changes, 4000)}` : ''
    d.finish(host, { ok: false, error: t('工作流被终止：{why}', { why: out.stopped.why }) + changes })
    return undefined
  }
  const node = topSteps(task, f.run).find((s) => s.status === 'failed')?.title
  d.finish(host, {
    ok: false,
    error: node
      ? t('工作流停在「{node}」：节点失败，原因见节点里的错误。父对话交回意见后从这个节点重跑。', { node })
      : out.error || t('执行失败'),
  })
  return undefined
}
