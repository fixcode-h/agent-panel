/**
 * 工作流运行的一轮（docs/openspec/changes/workflow-runs/design.md 第 3 节）：面板按流程图推着走，没有主 Agent、
 * 没有执行角色的对话。停下（暂停、面板重启、父对话停了）后再跑就从没做完的节点接着走；停在等确认的节点直接回到确认。
 * 阶段（Task.flowRun.phase）在这里推进；交回父对话的信由宿主在这一轮结束后按阶段发（server/tasks/flow-runs.ts）。
 * 从 engine.ts 拆出来：跑流程图、写系统消息、收尾这几样由引擎当参数传进来，这里不 import 引擎的实现。
 */
import type { FlowResult, Invocation } from '../engine.ts'
import type { EngineHost, Fail } from '../engine/host.ts'
import { blockedStep, planTask, taskFlow } from '../flow.ts'
import { decisionsText, overLimit, RUN_ENDED, RUN_NO } from './run.ts'
import { t } from '../i18n.ts'
import { ensureTaskRun } from '../run/state.ts'
import { clip } from '../text.ts'

export interface FlowRunDeps {
  runFlow: (host: EngineHost, inv: Invocation) => Promise<FlowResult>
  system: (host: EngineHost, text: string, step?: string, error?: boolean, transient?: boolean) => void
  finish: (host: EngineHost, r: Fail) => void
}

const now = () => new Date().toISOString()

export async function runFlowRunTurn(host: EngineHost, d: FlowRunDeps): Promise<void> {
  const { task } = host
  const f = task.flowRun!
  // 结束了的运行不再往下跑（界面上输入框已经灰掉；直接调接口发来的话没有地方交）
  if (RUN_ENDED.includes(f.phase) || f.phase === 'ready') {
    task.status = 'done'
    d.system(host, t('这次运行已经结束了，要再做一次请从父对话发起'), '', false, true)
    host.changed(true)
    return
  }
  const wf = host.workflow
  const flow = taskFlow(task, wf)
  if (!wf || !flow) return d.finish(host, { ok: false, error: t('找不到这次运行用的工作流，可能已被删除') })

  // 节点按流程图排好（新建运行时已经排好的不重复加）；运行只有一次，修改、退回都在这次运行里改节点状态
  for (const s of planTask(wf, RUN_NO).steps) if (!task.steps.some((x) => x.id === s.id)) task.steps.push(s)
  task.runSeq = RUN_NO
  // 上一轮某个节点失败时叫停过其余分支：这一轮重新开始，不能还带着叫停（同一个宿主连着跑两轮时会留着）
  host.halted = false
  const rec = ensureTaskRun(host, wf, RUN_NO, task.skillSlots)
  ;[rec.status, rec.endedAt] = ['running', '']
  // 决定记录和运行级说明：每个节点开始时现取（运行中途确认、修改、补充的也带得上）
  host.nodeNote = () => decisionsText(task.flowRun ?? f)
  // 节点失败等决定时重启：失败的节点改回待执行（父对话 revise_workflow 交的意见已经记进决定记录）
  // 停在某个节点的结论上（前置检查不通过、没有能走的连线）的也一样：从那个节点重新检查
  if (f.phase === 'failed') {
    const blocked = blockedStep(task, flow)
    for (const s of task.steps.filter((x) => !x.parentId && (x.status === 'failed' || x === blocked))) {
      s.status = 'pending'
      s.endedAt = ''
      s.branch = ''
    }
  }
  f.phase = 'running'
  f.pausedBy = undefined
  host.changed(true)

  // 收尾（评审 → 测试 → 修复）是流程图末尾的一个节点（建运行时接上的，见 flow-run-wrap.ts），和别的节点一起跑
  {
    const inv: Invocation = {
      workflow: wf,
      flow,
      parentId: '',
      slot: '',
      round: 0,
      input: f.input,
      depth: 0,
      run: RUN_NO,
    }
    const r = await d.runFlow(host, inv)
    if (!r.ok) {
      rec.status = r.stopped || r.halted ? 'stopped' : 'failed'
      rec.endedAt = now()
      // 停下：停在等确认的节点保持「等确认」，其余照旧是在跑（继续时从这里接着走）；
      // 父对话终止的（先记了 cancelled 再停）保持终止
      // （阶段在这一轮里可能被宿主改掉，所以现读，不用上面收窄过的值）
      const cancelled = (task.flowRun ?? f).phase === 'cancelled'
      if (!cancelled && (r.stopped || r.halted)) {
        if (task.steps.some((s) => s.awaitConfirm)) f.phase = 'confirm'
        // 谁停的：用户在运行上点的暂停只有用户能接着跑；随父对话停、面板重启停的，父对话继续时一起拉起
        const why = host.stopReason?.()
        f.pausedBy ??= why === 'user' ? 'user' : why === 'restart' ? 'restart' : 'parent'
      } else if (!cancelled) f.phase = 'failed'
      host.changed(true)
      return d.finish(host, r)
    }
    rec.status = 'done'
    rec.endedAt = now()
    f.summary = clip(r.output, 4000)
    // 流程停在某个节点的结论上，没走到结束：不算做完，等父对话决定（带意见重跑或终止）
    const blocked = blockedStep(task, flow)
    if (blocked) {
      f.phase = 'failed'
      rec.status = 'failed'
      return d.finish(host, {
        ok: false,
        error: t('流程停在「{title}」：结论不通过，后面的节点还没执行', { title: blocked.title }),
      })
    }
  }

  // 改代码的跑完（含收尾）停在待合回，由父对话 finish_workflow 合回或放弃；只读的直接完成
  f.phase = f.kind === 'readonly' ? 'done' : 'ready'
  // 修改超过上限的节点只在结尾提示，不强制终止（用户 2026-11-05 定）
  const over = overLimit(f)
  if (over.length)
    d.system(
      host,
      t('这些节点改了超过 {n} 轮：{nodes}。下次可以先在父对话里把需求聊清楚再起工作流', {
        n: String(f.reviseLimit),
        nodes: over.map((n) => `「${n}」`).join('、'),
      }),
    )
  task.status = 'done'
  host.changed(true)
}
