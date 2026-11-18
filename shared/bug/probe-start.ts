/**
 * 补排查开窗口（用户点「马上加」「让它改」）：只改任务数据、返回交给 Agent 的话，不碰文件。
 * 正式后端（server/tasks/probe-routes.ts）和演示后端（web/src/lib/demo/demo-probe.ts）共用这一份
 */
import type { z } from 'zod'
import { t } from '../i18n.ts'
import type { Task } from '../schema.ts'
import type { BugProbe, ProbeStart } from './probe-schema.ts'
import { nextProbeId, openProbe, probeAddPrompt, probeRetryPrompt } from './probe.ts'
import { revOf } from './phase.ts'
import { bugOf } from './task-bug.ts'

export type ProbeInput = z.output<typeof ProbeStart>

export type ProbeOut = { ok: true; message: string } | { ok: false; error: string }

/** 能不能开窗口：要交报告的 Bug、报告已经交过、没关、它没在回复、没有别的窗口开着 */
export function canOpenProbe(task: Task): string {
  if (task.bug?.kind !== 'report') return t('只有走诊断报告的 Bug 才能补排查')
  const d = task.bug.diagnoses?.at(-1)
  if (!d) return t('它还没交诊断报告：等报告出来再补排查')
  if (d.status === 'cancelled') return t('这份报告已经关了（不修了），不能再补排查')
  if (task.working) return t('它正在回复，等这一轮结束再补排查')
  if (openProbe(task.bug)) return t('上一次补排查还没结束，等它这一轮做完')
  return ''
}

/** 用户点「马上加」：记一条，返回交给 Agent 的话（页面把它作为用户消息发过去） */
export function startProbe(task: Task, input: ProbeInput, now = new Date()): ProbeOut {
  const why = canOpenProbe(task)
  if (why) return { ok: false, error: why }
  const bug = bugOf(task)
  const d = bug.diagnoses!.at(-1)!
  const p: BugProbe = {
    id: nextProbeId(bug.probes),
    kind: input.kind,
    ask: input.ask.trim(),
    at: now.toISOString(),
    targets: input.targets,
    workspace: input.workspace,
    remind: input.remind,
    state: 'adding',
    rev: revOf(d),
    spots: [],
    problems: [],
  }
  ;(bug.probes ??= []).push(p)
  return { ok: true, message: probeAddPrompt(p, revOf(d)) }
}

/** 没按规则加的那一条：让它照核对结果改，窗口再开一轮（快照还是最早那份） */
export function retryProbe(task: Task, id: string): ProbeOut {
  const why = canOpenProbe(task)
  if (why) return { ok: false, error: why }
  const p = task.bug?.probes?.find((x) => x.id === id)
  if (!p || p.state !== 'bad') return { ok: false, error: t('这一条现在不用改') }
  const message = probeRetryPrompt(p)
  p.state = 'adding'
  p.doneAt = undefined
  return { ok: true, message }
}
