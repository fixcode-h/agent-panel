/**
 * CLI 进程没有正常跑完一轮时交回什么：起不来、卡住被面板停掉、用户停止、超时、长时间没有输出。
 * 从 runner.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md）；返回 undefined 表示不是这几种，
 * 交给 runAgent 接着按退出码 / 报错判断（会话找不到、断流续接这些重试仍在 runner.ts）。
 * 长时间没有输出、停掉之前的那行提醒（idleWarning）也在这里
 */
import type { getCli } from '../../shared/clis.ts'
import type { AgentResult } from '../../shared/engine.ts'
import type { effectiveTimeoutMinutes } from '../../shared/schedule.ts'
import { t } from '../../shared/i18n.ts'
import { clip } from '../../shared/text.ts'
import { makeAlert } from '../../shared/alerts.ts'
import type { TaskMessage } from '../../shared/schema.ts'
import { stderrTail, type ProcessResult } from './process.ts'
import { failureHints } from './retry-policy.ts'
import { NO_RESPONSE_MS } from './stall-watch.ts'

export interface ExitFacts {
  r: ProcessResult
  def: NonNullable<ReturnType<typeof getCli>>
  /** 子任务卡住被面板停掉（用户没有同时停止） */
  stalled: boolean
  /** 停止信号（整个任务的或这次调用的） */
  aborted: boolean
  cap: ReturnType<typeof effectiveTimeoutMinutes>
  /** 这一轮 CLI 报的错误事件 */
  errors: string[]
  idleMinutes: number
}

export function exitResult({ r, def, stalled, aborted, cap, errors, idleMinutes }: ExitFacts): AgentResult | undefined {
  // CLI 根本没起来（可执行文件找不到、node_modules 被清空、路径不对）：这是失败，不是停止。
  // 必须排在 abort 判定前面：进程起不来时面板也可能同时收到过停止信号，
  // 那时写成 stopped 就会显示成「已暂停」，用户还以为自己按了暂停
  if (r.spawnError)
    return {
      ok: false,
      error: t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写可执行文件的完整路径。', {
        error: r.spawnError,
        cli: def.name,
        hint: def.installHint,
      }),
    }
  // 子任务卡住被面板停掉（用户没有同时停止）：交回 stalled，由 runStalled 接回会话重试
  if (stalled)
    return {
      ok: false,
      stalled: true,
      error: t('{cli} 连续 {s} 秒没有任何输出，面板停掉了这次调用', {
        cli: def.name,
        s: Math.round((NO_RESPONSE_MS * 2) / 1000),
      }),
    }
  // 停止时 CLI 自己中断了这一轮（进程正常退出），也算停止
  if (r.killed === 'stopped' || (aborted && !r.killed)) return { ok: false, stopped: true, error: t('已停止') }
  if (r.killed === 'timeout')
    return cap.by === 'budget'
      ? {
          ok: false,
          stopped: true,
          budget: true,
          error: t('这次执行超过计划设定的 {n} 分钟上限，已停止。已经产出的内容都保留着，点「继续执行」会重新计时。', {
            n: cap.minutes,
          }),
        }
      : { ok: false, error: t('超过 {n} 分钟没有完成，已停止', { n: cap.minutes }) }
  if (r.killed === 'idle') {
    const detail = [...errors, stderrTail(r.stderr, 6, def.stderrNoise)].filter(Boolean).join('\n')
    return {
      ok: false,
      error: [
        t('{cli} 连续 {n} 分钟没有任何输出，已停止。', { cli: def.name, n: idleMinutes * 2 }),
        ...failureHints(detail, def),
        detail ? `\n${t('最后的输出：')}\n${clip(detail, 1500)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  return undefined
}

/**
 * 长时间没有输出的前一半：到了 idleMinutes 先在对话里提醒一行，再过同样久还没输出才按上面的 idle 停掉。
 * 在等用户确认、回答或下一句时不算（调用方的 busy 判定）
 */
export function idleWarning(a: { id: string; agentId: string; step: string; cli: string; idleMinutes: number }) {
  const { id, agentId, step, cli, idleMinutes } = a
  const msg: TaskMessage = {
    id,
    role: 'system',
    agentId,
    step,
    text: t(
      '{cli} 已经 {n} 分钟没有任何输出，可能卡在登录、网络重连或交互式确认上。再过 {n} 分钟还没有输出会自动停止；也可以现在停止后检查一下。',
      { cli, n: idleMinutes },
    ),
    tools: [],
    alert: makeAlert('warn', t('最后一次输出在 {n} 分钟前', { n: idleMinutes }), 'idle'),
    at: new Date().toISOString(),
  }
  return msg
}
