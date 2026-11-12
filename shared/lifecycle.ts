/**
 * 状态诊断（对话菜单「状态」）的判定：一个对话 / 子任务现在到底在干什么、CLI 进程还在不在、不在的话为什么、
 * 哪里自相矛盾。前后端共用的纯函数：服务端收集事实（server/tasks/lifecycle.ts），这里只下结论。
 *
 * 用户报过三类「卡死」：这一轮说完了在等子对话却一直不动；全部做完了还显示在等；上一秒还在输出、
 * 下一秒就「等待模型」发消息也进不去。以前只看得到「等待模型 · 已 54s」，说不清卡在哪一步。
 * 这里把每一类都写成一条检查（anomalies），诊断文件交给开发时一眼能看出是网关、CLI 还是面板的问题。
 * 判定复用已有的 convState / stopReasonText，不另写一套「算不算在跑」。
 */
import { t } from './i18n.ts'
import type { StopReason, TaskMode, TaskStatus } from './schema.ts'
import type { NeedKind } from './tasks/word.ts'
import { convStateText, stopReasonText, type ConvState } from './task.ts'
import type { TrailItem } from './end-turn.ts'
import type { EndTurnRecord } from './turn-end.ts'

/** 对话日志里的一行（server/task-log.ts 写的格式：`2026-10-30 09:07:12.123 [事件] 键=值 …`） */
export interface LogLine {
  at: number
  event: string
  fields: Record<string, string>
  raw: string
}

/** 解析一行对话日志；不是这个格式的行（多行字段的续行）返回 undefined */
export function parseLogLine(raw: string): LogLine | undefined {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) \[([^\]]+)\](.*)$/.exec(raw)
  if (!m) return undefined
  const at = Date.parse(`${m[1]}T${m[2]}`)
  const fields: Record<string, string> = {}
  // 值有空格时是 JSON 字符串（见 task-log.ts 的 field）
  for (const f of m[4].matchAll(/ ([\w.]+)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
    let v = f[2]
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v) as string
      } catch {
        // 截断过的 JSON 串：原样留着
      }
    }
    fields[f[1]] = v
  }
  return { at, event: m[3], fields, raw }
}

/** 最近一次 CLI 进程退出（日志里的「CLI 进程退出」） */
export interface ProcessExit {
  at: number
  pid?: number
  code?: number | null
  signal?: string
  /** 面板主动结束的原因：stopped（停止）/ timeout（超时）/ idle（太久没输出） */
  killed?: string
  aliveMs?: number
  stderr?: string
}

/** 从日志里取最近一次进程退出 */
export function lastExit(lines: LogLine[], step = ''): ProcessExit | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (l.event !== 'CLI 进程退出' || (l.fields.step ?? '') !== step) continue
    const num = (k: string) => (l.fields[k] === undefined || l.fields[k] === 'null' ? undefined : Number(l.fields[k]))
    return {
      at: l.at,
      pid: num('pid'),
      code: l.fields.code === 'null' ? null : num('code'),
      signal: l.fields.signal,
      killed: l.fields.killed,
      aliveMs: num('aliveMs'),
      stderr: l.fields.stderr,
    }
  }
  return undefined
}

/**
 * 日志事件按类计数：弹窗顶上的数字块、日志的筛选和配色、诊断文件里的 counts 都按这一份分，免得三处口径不一。
 * 只认事件名（server 里 taskLog 的第二个参数），新增事件时在这里归类；归不了类的不计数。
 * done（它说做完了）不从日志数：按对话记下的 end_turn(done)（Task.turnEnds）算，见 countDone
 */
export const EVENT_KINDS = ['requests', 'nudges', 'done', 'retries', 'errors', 'stops', 'exits'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export function eventKind(event: string, fields: Record<string, string> = {}): EventKind | undefined {
  if (event === '模型请求开始') return 'requests'
  // 面板真推出去的「接着做」（server/tasks/drive.ts）：计划推进、收尾提醒记 action=continue，收尾自检记 action=check；
  // 只是判断了没推（cancel、stuck、send-failed）的不算
  if ((event === '计划推进' || event === '收尾提醒') && fields.action === 'continue') return 'nudges'
  if (event === '收尾自检' && fields.action === 'check') return 'nudges'
  // 结束前钩子在同一轮里拦住（server/tasks/before-end.ts）：和一轮结束后补发的一样算一次面板提醒
  if (event === '结束前钩子：拦住') return 'nudges'
  if (event === 'CLI 重试模型请求' || event === '模型请求没有输出就换了下一次') return 'retries'
  if (event === 'CLI 进程退出') return 'exits'
  if (event === 'CLI 报这一轮结束') return fields.ok === 'false' ? 'errors' : undefined
  // 先认出错再认停止：「卡住：问过状态没回复，停掉重启」算出错
  if (/出错|报错|失败|被拒|拒收|没建起来|卡住/.test(event)) return 'errors'
  if (/停止|停掉|直接结束|结束 CLI/.test(event)) return 'stops'
  return undefined
}

export interface EventCount {
  n: number
  /** 最近一次：时间和一句摘要（事件名之外最要紧的两个字段） */
  last?: { at: number; text: string }
}
export type LifeCounts = Record<EventKind, EventCount>

/** 一行日志的摘要：去掉序号、pid、步骤这类定位字段，留前两个 */
function brief(l: LogLine) {
  const kv = Object.entries(l.fields).filter(([k]) => k !== 'n' && k !== 'pid' && k !== 'step')
  const tail = kv.slice(0, 2).map(([k, v]) => `${k}=${v.length > 80 ? `${v.slice(0, 80)}…` : v}`)
  return [l.event, ...tail].join(' ')
}

/**
 * 按完整日志数各类事件（服务端读整份日志时算，弹窗只拿到最近 200 行，自己数会少）。
 * step 为空时数对话自己这一轮（日志里没有 step 的行），否则只数这一步的
 */
export function countEvents(lines: LogLine[], step = ''): LifeCounts {
  const out = Object.fromEntries(EVENT_KINDS.map((k) => [k, { n: 0 }])) as LifeCounts
  for (const l of lines) {
    if ((l.fields.step ?? '') !== step) continue
    const k = eventKind(l.event, l.fields)
    if (!k) continue
    out[k].n++
    out[k].last = { at: l.at, text: brief(l) }
  }
  return out
}

/**
 * 「它说做完了」：Agent 用 end_turn(outcome: done) 交代做完的次数（用户 2026-11-06 要在计数里看到、点开定位）。
 * 只认这次工具调用的记录，不读回复文字（ADR 0041、0049）；记录只留最近 50 条（shared/end-turn.ts 的 pushTurnEnd）
 */
export function countDone(counts: LifeCounts, ends: EndTurnRecord[] = []): LifeCounts {
  const done = ends.filter((e) => e.outcome === 'done')
  const last = done.at(-1)
  const ms = last ? Date.parse(last.at) : NaN
  return {
    ...counts,
    done: { n: done.length, ...(!Number.isNaN(ms) && { last: { at: ms, text: 'end_turn outcome=done' } }) },
  }
}

/** 模型请求轨迹（server/exec/cli-trace.ts 的 CliTrace，时间是毫秒时间戳） */
export interface TraceFacts {
  /** 这次 CLI 调用开始的时间：不报「请求开始」的 CLI（Codex、Pi）按它算等了多久 */
  startedAt?: number
  requests: number
  requestAt?: number
  firstOutputAt?: number
  lastOutputAt?: number
  lastEvent?: string
  retry?: { attempt: number; error?: string; at: number }
  resultAt?: number
  resultOk?: boolean
  /** 上一轮怎么停的：stop_reason、最后一段输出是什么、调了几次工具（见 cli-trace.ts 的 lastTurn） */
  lastTurn?: { stopReason?: string; endedOn?: string; tools: number }
}

/** 一个节点（对话或子任务）的事实：服务端收集，诊断文件里原样保存 */
export interface LifeFacts {
  kind: 'conversation' | 'helper'
  status: TaskStatus
  stopReason?: StopReason
  /** 对外状态（convState）；子任务没有 */
  state?: ConvState
  working: boolean
  awaitingUser: boolean
  resolved?: boolean
  /** 排队等 API 名额 */
  apiWait?: boolean
  /** 子任务被打断、还没重新开始 */
  interrupted?: boolean
  /** 内存里的执行位（这一份执行还在面板里）；没有就是 undefined */
  live?: { stop: boolean; stopReason?: StopReason; stopAt?: number; prewarming?: boolean }
  /** 排着等这一轮结束后处理的消息条数 */
  held: number
  /** CLI 进程还活着（按进程登记，不按状态猜） */
  cliAlive: boolean
  /** 正在跑的工具（CLI 报的） */
  runningTool?: string
  /** 还在跑 / 排着的子任务数 */
  helpers: number
  /** 还在跑的后台命令数 */
  jobs: number
  /** 计划里正在等的子对话，以及它们现在的状态 */
  waitsOn: {
    id: string
    title: string
    state: ConvState
    /** 它已经请父对话收尾、还在等父对话处理（见 shared/task.ts 的 wrapUpPending）：请求的时间 */
    wrapAt?: string
  }[]
  trace?: TraceFacts
  exit?: ProcessExit
  /** 面板计划（没有就是 undefined）：做了几步、一共几步、在等几步、还剩几步要做、进度指纹（短） */
  plan?: { title: string; done: number; total: number; waiting: number; open: number; key: string }
  /** 面板推进（自驱）的计数：最后一个进度指纹（短）、这个进度推了几次（不限次数，2026-11-05 起） */
  nudge?: { key: string; n: number }
  /** runner 已经把这一轮标成卡住（没有响应检测，见 server/exec/stall-watch.ts）：从什么时候起没输出 */
  stalled?: { since: number }
  // 下面几项给「状态」窗口最上面那一句（shared/life-next.ts）：只有对话有，旧的诊断文件里没有
  /** 和标题栏、侧栏同一个短词（shared/tasks/word.ts 的 taskWord） */
  word?: string
  /** 等你处理的是哪一类 */
  need?: NeedKind
  /** 交了诊断报告等你确认 */
  report?: boolean
  /** 这个状态从什么时候开始（毫秒）：等你处理是请求发出的时间，其余是这一轮结束的时间 */
  since?: number
  mode?: TaskMode
  /** 额度用完 / 被限流后在等到点自动继续：到这个时刻（毫秒），见 shared/quota-resume.ts */
  quotaUntil?: number
}

export type AnomalyLevel = 'danger' | 'warning' | 'info'

export interface Anomaly {
  /** 稳定的编号：诊断文件里按它找对应的检查 */
  code: string
  level: AnomalyLevel
  text: string
}

export interface LifeVerdict {
  /** 一句话：现在在干什么 */
  headline: string
  /** CLI 进程不在时，为什么不在 */
  why?: string
  anomalies: Anomaly[]
}

const sec = (ms: number) => Math.max(0, Math.round(ms / 1000))

/** 模型多久没回算异常：大上下文的第一段输出几十秒很常见，一分半还没有就该看一眼了 */
export const MODEL_SILENT_MS = 90_000
/** 工具结果交回后多久没等到下一次回复算异常：和 runner 标卡住的 90 秒一致，免得面板已标卡住、诊断还说在输出 */
export const OUTPUT_STALL_MS = 90_000
/** 输出到一半停住多久算异常（没有工具在跑时）：和 runner 的 MIDWAY_STALL_MS（30 秒）一致 */
export const MIDWAY_STALL_MS = 30_000
/** 停止发出后多久还没收完算异常（正常几十毫秒，兜底 3 秒收口） */
export const STOP_SLOW_MS = 5_000

/** 进程为什么不在了 */
export function exitText(f: Pick<LifeFacts, 'exit' | 'stopReason' | 'status'>): string {
  const e = f.exit
  if (!e) return f.status === 'stopped' ? stopReasonText(f.stopReason) : t('这次面板运行期间没有启动过它的 CLI 进程')
  const alive = e.aliveMs !== undefined ? t('（活了 {s} 秒）', { s: sec(e.aliveMs) }) : ''
  if (e.killed === 'stopped') return t('面板结束了进程：{why}{alive}', { why: stopReasonText(f.stopReason), alive })
  if (e.killed === 'timeout') return t('超过单步时限，面板结束了进程{alive}', { alive })
  if (e.killed === 'idle') return t('太久没有任何输出，面板结束了进程{alive}', { alive })
  if (e.signal) return t('进程被信号 {signal} 结束{alive}', { signal: e.signal, alive })
  if (e.code && e.code !== 0)
    return t('进程异常退出（退出码 {code}）{alive}{err}', {
      code: e.code,
      alive,
      err: e.stderr ? `：${e.stderr}` : '',
    })
  return t('CLI 这一轮说完后正常退出{alive}', { alive })
}

/** 对一个节点下结论；now 是生成诊断的时刻 */
export function verdictOf(f: LifeFacts, now = Date.now()): LifeVerdict {
  const out: Anomaly[] = []
  const add = (code: string, level: AnomalyLevel, text: string) => out.push({ code, level, text })
  const tr = f.trace
  let headline = ''

  if (f.status === 'running') {
    if (!f.live && f.kind === 'conversation') {
      headline = t('记录写着在执行，但面板里没有人在跑它')
      add('running-no-slot', 'danger', t('落盘状态是执行中，内存里却没有这一份执行：面板定时核对时会收口成「已中断」'))
    } else if (f.live?.stop) {
      const ms = f.live.stopAt ? now - f.live.stopAt : 0
      headline = t('正在停下（{why}），已 {s} 秒', { why: stopReasonText(f.live.stopReason), s: sec(ms) })
      if (ms > STOP_SLOW_MS)
        add(
          'stop-slow',
          'warning',
          t('停止发出 {s} 秒了还没收完：进程{alive}', { s: sec(ms), alive: f.cliAlive ? t('还在') : t('已经没了') }),
        )
    } else if (f.state === 'needs')
      // 在等用户确认操作或回答提问（CLI 报了 ask）：本来就没有输出，不算卡住，不能说成「输出到一半停了」（2026-11-02 真实测试撞到）
      headline = t('在等你处理：确认操作或回答提问')
    else if (f.apiWait) headline = t('排队等 API 并发名额')
    else if (f.live?.prewarming) headline = t('正在预热 CLI')
    else if (f.working) {
      if (f.runningTool) headline = t('在跑工具：{tool}', { tool: f.runningTool })
      else if (tr?.retry)
        headline = t('CLI 在自己重试模型请求（第 {n} 次）：{error}', {
          n: tr.retry.attempt,
          error: tr.retry.error || t('原因未知'),
        })
      else if (tr && !tr.firstOutputAt && (tr.requestAt || tr.startedAt)) {
        const ms = now - (tr.requestAt ?? tr.startedAt!)
        headline = tr.requestAt
          ? t('等模型回复：第 {n} 次请求发出 {s} 秒，还没有任何输出', { n: tr.requests, s: sec(ms) })
          : t('等模型回复：CLI 启动 {s} 秒，还没有任何输出', { s: sec(ms) })
        if (ms > MODEL_SILENT_MS)
          add(
            'model-silent',
            'warning',
            t('模型请求 {s} 秒没有任何输出，CLI 也没报重试：多半是网关没回或连接挂住了', { s: sec(ms) }),
          )
      } else if (tr?.lastOutputAt) {
        const ms = now - tr.lastOutputAt
        // 最后收到的是工具结果：卡的是模型的下一次请求没回来，不是流到一半断了（2026-11-03 用户报的子任务）
        const afterTool = tr.lastEvent === 'tool_result'
        // 两秒内的算「正在输出」，不写「0 秒前」
        headline =
          ms < 2000
            ? t('模型在输出')
            : afterTool
              ? t('工具结果交回 {s} 秒了，等模型的下一次回复', { s: sec(ms) })
              : t('模型在输出：最后一段输出在 {s} 秒前', { s: sec(ms) })
        if (ms > (afterTool ? OUTPUT_STALL_MS : MIDWAY_STALL_MS) || f.stalled)
          add(
            'output-stalled',
            'warning',
            [
              afterTool
                ? t('工具结果交回 {s} 秒了，模型的下一次请求没有任何输出，CLI 也没报重试：多半是网关没回或连接挂住了', {
                    s: sec(ms),
                  })
                : t('输出到一半停了 {s} 秒，没有工具在跑，也没有新的请求：CLI 可能卡在流式输出里', { s: sec(ms) }),
              f.stalled
                ? f.kind === 'helper'
                  ? t('面板已标成卡住，再没有输出会停掉它、接回会话重试')
                  : t('面板已标成卡住：再发一条消息会停掉它、接回会话重开')
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          )
      } else headline = t('这一轮在执行，还没有模型请求的记录')
      if (!f.cliAlive)
        add('working-no-process', 'danger', t('这一轮标着在执行，但它的 CLI 进程已经不在了：执行位没有收口'))
    } else if (f.awaitingUser)
      headline = f.cliAlive ? t('这一轮说完了，CLI 停在等下一句（进程活着）') : t('这一轮说完了，在等下一句')
    else if (f.helpers) headline = t('在等 {n} 个子任务', { n: f.helpers })
    else if (f.waitsOn.length) headline = t('在等子对话：{list}', { list: kidsText(f.waitsOn) })
    else headline = t('这一轮在收尾')
  } else if (f.status === 'done') headline = f.resolved ? t('已完成') : t('这一轮已说完')
  else if (f.status === 'stopped') headline = t('已停止：{why}', { why: stopReasonText(f.stopReason) })
  else headline = t('失败')

  // 子任务被打断还没重新开始：只在对话又跑起来时才会接着做
  if (f.kind === 'helper' && f.interrupted) headline = t('被打断了，还没重新开始')

  // ---- 不论状态都要查的矛盾 ----
  if (f.state === 'waiting' || f.state === 'running' || f.status === 'running') {
    // 计划在等的子对话已经不动了，父对话却没被叫醒：交回的结果没送到，或者送到了没开新的一轮
    const idle = f.waitsOn.filter(
      (k) => !k.wrapAt && k.state !== 'running' && k.state !== 'waiting' && k.state !== 'needs',
    )
    if (idle.length && !f.working)
      add(
        'child-idle-parent-waiting',
        'danger',
        t('计划还在等子对话 {list}，它们已经不在跑了，父对话却没被叫醒', { list: kidsText(idle) }),
      )
  }
  // 子对话请父对话收尾了，父对话这一轮却没合回也没退回：等的其实是父对话自己（用户 2026-11-03 报的互相等）
  const wrap = f.working ? [] : f.waitsOn.filter((k) => k.wrapAt)
  if (wrap.length) {
    const oldest = Math.min(...wrap.map((k) => Date.parse(k.wrapAt!) || now))
    add(
      'wrapup-unhandled',
      'danger',
      [
        t('子对话 {list} 已经请父对话收尾 {m} 分钟了，父对话没有合回也没有退回', {
          list: kidsText(wrap),
          m: Math.max(0, Math.round((now - oldest) / 60000)),
        }),
        f.nudge ? t('面板已提醒 {n} 次', { n: f.nudge.n }) : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  if (f.status !== 'running' && f.waitsOn.some((k) => k.state === 'running' || k.state === 'waiting'))
    add('waiting-children', 'info', t('这一轮说完了，在等子对话：{list}', { list: kidsText(f.waitsOn) }))
  if (f.held && !f.live)
    add(
      'held-unhandled',
      'danger',
      t('有 {n} 条消息排着等「这一轮结束后处理」，可这一轮已经结束了，没人接', { n: f.held }),
    )
  if (f.apiWait && f.status !== 'running') add('apiwait-stale', 'warning', t('已经不在执行，排队等 API 的标记却还留着'))
  if (f.cliAlive && !f.live && f.status !== 'running')
    add('process-leftover', 'warning', t('对话已经收口，它名下的 CLI 进程却还活着'))
  if (
    f.kind === 'conversation' &&
    f.status === 'running' &&
    !f.working &&
    !f.awaitingUser &&
    !f.helpers &&
    !f.jobs &&
    !f.waitsOn.length &&
    f.live &&
    !f.live.stop &&
    !f.apiWait &&
    !f.live.prewarming
  )
    add('slot-idle', 'warning', t('执行位占着，但既没在执行也没在等什么：发来的消息会排在「这一轮结束后」'))

  // 计划没做完，这一轮却已经停下、也不在等什么：推进推满了就是卡住，没推满说明推进没有接上
  const pl = f.plan
  const idle = !f.working && !f.helpers && !f.jobs && !f.waitsOn.length && (f.status !== 'running' || f.awaitingUser)
  if (pl && pl.open && !pl.waiting && idle)
    add(
      'plan-stalled',
      'warning',
      // 面板提醒不限次数（2026-11-05）：停在这里多半是它说了卡住、或者空转保护停下了，提醒次数写在后面
      f.nudge && f.nudge.key === pl.key
        ? t('计划才做了 {done}/{total}，面板按这个进度提醒了 {n} 次，停在这里', {
            done: pl.done,
            total: pl.total,
            n: f.nudge.n,
          })
        : t('计划才做了 {done}/{total}，这一轮已经停下，也不在等任何结果', { done: pl.done, total: pl.total }),
    )
  const lt = tr?.lastTurn
  if (lt && !lt.tools && lt.stopReason && lt.stopReason !== 'end_turn')
    add('turn-cut', 'warning', t('上一轮因为 {why} 停下，这一轮没有调用工具：可能是输出被截断', { why: lt.stopReason }))

  const why = f.cliAlive ? undefined : exitText(f)
  return { headline, why, anomalies: out }
}

function kidsText(kids: LifeFacts['waitsOn']) {
  return kids.map((k) => `「${k.title}」（${convStateText(k.state)}）`).join(t('、'))
}

/* ---- 诊断报告（GET /tasks/:id/lifecycle 和诊断文件的内容） ---- */

export interface LifeProcess {
  pid: number
  startedAt: number | null
  rss: number | null
  command: string
}

export interface LifeNode {
  /** 对话是任务 id；子任务、工作流节点是「任务 id#步骤 id」 */
  id: string
  parentId?: string
  taskId: string
  stepId?: string
  title: string
  /** conversation：对话 / 子对话；helper：子任务；node：工作流节点 */
  kind: 'conversation' | 'helper' | 'node'
  cli?: string
  model?: string
  /** 会话 id（--resume 接的那个） */
  session?: string
  /** 对话页开着（前台）/ 一小时内看过（宽限期里） */
  viewer?: { viewing: boolean; watched: boolean }
  reruns?: number
  startedAt?: string
  endedAt?: string
  facts: LifeFacts
  verdict: LifeVerdict
  processes: LifeProcess[]
  /** 按完整日志数的各类事件（旧的诊断文件没有；面板提醒是后加的，更旧的文件里也没有） */
  counts?: LifeCounts
  /** 面板提醒和 Agent 用 end_turn 交代的结束，按时间排（对话才有；提醒不画进对话，只在这里看） */
  trail?: TrailItem[]
  /** 最近的日志行（原样） */
  log: string[]
}

export interface LifeReport {
  format: string
  generatedAt: string
  panel: { version: string; platform: string; node: string; pid: number }
  settings: Record<string, unknown>
  rootId: string
  nodes: LifeNode[]
}
