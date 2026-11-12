import { log } from '../log.ts'
import { taskLog } from '../tasks/log.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { t } from '../../shared/i18n.ts'
import { clip } from '../../shared/text.ts'
import type { Task, TaskMessage } from '../../shared/schema.ts'

/** 交给 CLI 后多久没有真正的输出算卡住；测试用环境变量缩短 */
export const NO_RESPONSE_MS = Number(process.env.AGENT_PANEL_NO_RESPONSE_MS) || 90_000
/**
 * 模型已经在输出（思考、正文、工具入参）又停住多久算断流。流式输出时各段之间正常只隔几秒
 * （Claude Code 自己隔 30 秒就记一次 stall）；网关多半等满它的读超时（常见 60 秒）才断开，
 * CLI 断开后才报重试，所以这里先提醒，不等网关（用户 2026-11-06 报失败提醒晚了快一分钟）
 */
// 测试缩短 NO_RESPONSE_MS 时跟着缩短，不比它长
export const MIDWAY_STALL_MS = Number(process.env.AGENT_PANEL_MIDWAY_STALL_MS) || Math.min(30_000, NO_RESPONSE_MS)

/** 卡住的记录：对话按任务 id，子任务按「任务#步骤」，免得子任务和派它的对话互相覆盖 */
const stalled = new Map<string, { input: string; since: number }>() // 模块状态：会话，跟着进程或连接一起没
const keyOf = (taskId: string, step = '') => (step ? `${taskId}#${step}` : taskId)
export const stalledTurn = (taskId: string, step = '') => stalled.get(keyOf(taskId, step))

export interface StallWatchOpts {
  task: Task
  step: string
  agentId: string
  cli: string
  /** 查不查：对话本身，和带 stallRetry 的子任务 */
  watch: boolean
  /** 子任务：标卡住后再等 NO_RESPONSE_MS 还没输出就 kill（由 runStalled 接回会话重试）；对话等用户再发消息时重开 */
  helper: boolean
  input: string
  /** 本来就没有输出的时候（等用户、等子任务、等确认、工具在跑、排队等 API 名额）：从现在重新计时 */
  busy: () => boolean
  /** 这次调用已经结束或在预热：不查 */
  off: () => boolean
  newId: () => string
  changed: () => void
  kill: () => void
}

/**
 * 没有响应的检测：交出一句话、一个工具结果，或 CLI 开始一次模型请求时开始计时，之后有任何真正的输出就停。
 * 超时写一行警告、标成卡住；后来又有输出了，警告标成已恢复。工作流节点不查（几个节点同时跑，由空闲检测管）。
 * 子任务以前也不查，卡在网关上只剩 30 分钟的空闲超时兜底，派它的对话一直干等（用户 2026-11-03 报）
 */
export function createStallWatch(o: StallWatchOpts) {
  const { task, step } = o
  const key = keyOf(task.id, step)
  let armedAt = 0
  let armedInput = o.input
  let msg: TaskMessage | undefined
  /** 计时起点之后已经有过输出：再停住就是「输出到一半停了」，不是「一直没开始」 */
  let midway = false
  /** 子任务标成卡住后到这个时间还没输出：停掉这次调用 */
  let killAt = 0
  /** 最近一次有输出或开始计时的时间：重试提示里说明「之前多久没有输出」 */
  let quietSince = 0

  const arm = (input?: string) => {
    if (!o.watch) return
    armedAt = Date.now()
    quietSince = armedAt
    midway = false
    if (input !== undefined) armedInput = input
  }
  /** 这一轮结束了：之后没有输出是在等下一句，不算卡住 */
  const disarm = () => (armedAt = 0)
  const heard = () => {
    // 有了输出也接着计时：模型（多是第三方网关）流到半句就断了、进程还活着时，页面会一直停在「等待模型」，
    // 用户只能自己停下再发。这一轮还在跑就从这次输出重新算，到点同样告诉用户
    quietSince = Date.now()
    armedAt = o.watch && (o.helper || task.working) ? quietSince : 0
    midway = !!armedAt
    killAt = 0
    const st = stalled.get(key)
    if (!st) return
    stalled.delete(key)
    if (msg?.alert && !msg.alert.resolved) {
      msg.alert = {
        ...msg.alert,
        resolved: t('{s} 秒后有输出了，接着在处理', { s: Math.round((Date.now() - st.since) / 1000) }),
      }
      o.changed()
    }
  }
  const tick = () => {
    if (killAt && !o.off() && Date.now() >= killAt) {
      killAt = 0
      taskLog(task.id, '子任务卡住：停掉这次调用', { step })
      o.kill()
      return
    }
    if (!armedAt || o.off()) return
    if (o.busy()) {
      armedAt = Date.now()
      return
    }
    const quiet = Date.now() - armedAt
    if (quiet < (midway ? MIDWAY_STALL_MS : NO_RESPONSE_MS)) return
    const since = armedAt
    armedAt = 0
    stalled.set(key, { input: armedInput, since })
    const secs = Math.round(quiet / 1000)
    const cli = o.cli
    if (o.helper) killAt = Date.now() + NO_RESPONSE_MS
    msg = {
      id: o.newId(),
      role: 'system',
      agentId: o.agentId,
      step,
      text: o.helper
        ? t('{cli} {s} 秒没有新的输出。再过 {k} 秒还是没有，面板会停掉它、接回会话重试。', {
            cli,
            s: secs,
            k: Math.round(NO_RESPONSE_MS / 1000),
          })
        : midway
          ? t('{cli} 输出到一半停了，{s} 秒没有新的内容。直接再发一条消息，面板会停掉它、接回这个会话重新开始。', {
              cli,
              s: secs,
            })
          : t('{cli} 收到消息 {s} 秒了还没有任何输出。直接再发一条消息，面板会停掉它、接回这个会话重新开始。', {
              cli,
              s: secs,
            }),
      tools: [],
      alert: makeAlert(
        'warn',
        [
          midway
            ? t('{cli} 输出到一半后 {s} 秒没有新的输出（没有思考、正文或工具调用），模型的流可能断了。', {
                cli,
                s: secs,
              })
            : t('{cli} 在 {s} 秒里没有任何输出（没有思考、正文或工具调用）。', { cli, s: secs }),
          t('交给它的最后一条内容：'),
          clip(armedInput, 800),
        ].join('\n'),
        'no_response',
      ),
      at: new Date().toISOString(),
    }
    task.messages.push(msg)
    log.warn('agent', `${cli} 交出消息后 ${secs} 秒没有输出，标成卡住`, { task: task.id, step })
    taskLog(task.id, '标成卡住', { step: step || undefined, secs, midway: midway || undefined })
    o.changed()
  }
  const timer = setInterval(tick, Math.min(5000, Math.max(50, NO_RESPONSE_MS / 4)))
  timer.unref?.()
  const stop = () => {
    clearInterval(timer)
    stalled.delete(key)
  }
  /** 从上次输出（或开始等模型）到现在过了多久；没在计时返回 0 */
  const quietMs = () => (quietSince ? Date.now() - quietSince : 0)
  return { arm, disarm, heard, stop, quietMs }
}
