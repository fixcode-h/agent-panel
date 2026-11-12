import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { capture } from './exec/process.ts'
import { runShell as runShellIn } from './merge-build.ts'
import { currentShell } from './shells.ts'
import type { ShellInfo } from '../shared/shells.ts'
import { log } from './log.ts'
import { createSlotPool } from './slots.ts'
import { bgJobIds, bgPendingIds, bgResultHead, opensWindow } from '../shared/panel-tools.ts'
import { fmtDuration } from '../shared/duration.ts'
import { failLostWaits } from '../shared/plan-lost.ts'
import type { Task, TaskJob, TaskJobView } from '../shared/schema.ts'
import { createDigest, digestText, type LogDigest } from '../shared/log-digest.ts'
import { openJobLog } from './bg-log.ts'
import { notRunReason } from './bg-sanity.ts'
import { lostJobNote, type createBgPersist, type PersistedJob } from './bg-persist.ts'

/**
 * 后台命令：CLI 把要跑很久的命令（完整测试、编译）交给面板，自己接着干别的；
 * 面板跑完把结果推回那个对话。CLI 各自的后台能力不统一（Claude Code 有，Codex、Command Code 没有），放在面板这层所有 CLI 都能用。
 */

export interface BgJob {
  id: string
  taskId: string
  /** 发起它的子任务步骤（TaskStep.id）；父对话自己起的不带，运行区据此把子任务的后台命令单独列出 */
  step?: string
  name: string
  command: string
  cwd: string
  exclusive: boolean
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  code: number | null
  /** 交给面板的时间：排队也算在等结果的时间里 */
  createdAt: string
  startedAt: string
  endedAt: string
  /** 最后一次有输出（stdout 或 stderr）的时间：太久没输出要提醒对话，可能卡住了 */
  lastOutputAt: string
  /** 已经提醒过对话「很久没输出」：同一段沉默只提醒一次，有了新输出再重新计 */
  stalled?: boolean
  /** 这条命令最多跑多久（毫秒）：到点面板停掉它，结果照常推回 */
  timeoutMs: number
  /** 下一次「跑了很久，看一眼」的时间点（从开始跑算的毫秒数），见 CHECK_FIRST_MS */
  nextCheckMs?: number
  /** 最近的输出（只留结尾） */
  lines: string[]
  /** 整段输出里认出来的错误和警告行（边跑边收，不受 lines 只留结尾的限制），见 shared/log-digest.ts */
  digest?: LogDigest
  /** 完整日志落盘的路径（面板给了日志目录时才有），推回结果里写明让模型去搜 */
  logFile?: string
  /** 跑的期间工作目录里的文件变了：结果可能已经不准 */
  changed: boolean
  /**
   * 被停止时也要把结果交回发起方：面板代子对话跑的父对话测试带它。
   * 不带的命令（对话自己起的）被停下时不推回——对话自己停了，一条结果会把它重新拉起。
   * 父对话测试没有这个就没人推进队列，等它的子对话永远停在「等父对话测试」（见 docs/modules/server/bugs/）
   */
  notifyOnStop?: boolean
  /**
   * 用户 / 对话明确停掉这一条（stopOne）：只有这种停法对 notifyOnStop 的命令回传结果。
   * 面板退出、归档、删除这些生命周期停（stop(taskId)）不回调，父对话测试由重启后的 recoverParentTests 重排
   */
  stopRequested?: boolean
  /** 额外的环境变量（子对话的独立分支禁止推送） */
  env?: { key: string; value: string }[]
  /**
   * 常驻服务（开发服务器、监听）：一直跑到被停掉，不是「交出去等结果」。不提醒没输出 / 跑了很久，
   * 不算对话在等它（awaitedJob），计划不挂等待；中途自己退出了照常把结果推回（多半是起不来或崩了）
   */
  service?: boolean
  /**
   * 指定用哪个 shell 起进程（面板自己跑的项目测试步骤，按步骤标的环境，见 server/step-run.ts）；
   * 不带的（Agent 交来的命令）用设置里选的命令行环境，Agent 是按那个 shell 的语法写的命令
   */
  shell?: ShellInfo & { distro?: string }
}

/**
 * 对话在等它的结果：还在排队或在跑、且不是常驻服务。侧栏转圈、「完成未读」、计划推进、收尾门禁都按它算；
 * 常驻服务一直跑到被停掉，算进去的话对话永远显示在等结果
 */
export const awaitedJob = (j: Pick<BgJob, 'state' | 'service'>) =>
  (j.state === 'queued' || j.state === 'running') && !j.service

/**
 * 发给界面的后台命令（只带还在跑的）：映射只写这一处，测试直接测它。
 * step 只在有值时带：老记录和父对话自己起的都不带，界面上按它区分来源（见 shared/task.ts 的 splitStepJobs）
 */
export function uiJobs(list: BgJob[]): TaskJob[] {
  return list
    .filter((j) => j.state === 'queued' || j.state === 'running')
    .map((j) => ({
      id: j.id,
      ...(j.step ? { step: j.step } : {}),
      name: j.name,
      command: j.command,
      state: j.state as 'queued' | 'running',
      startedAt: j.startedAt,
      ...(j.service ? { service: true } : {}),
    }))
}

/** 没写限时的后台命令最多跑多久 */
const DEFAULT_TIMEOUT_MS = 2 * 3600_000
/** 限时最多能写多长：再长的事（等发布、长时间压测）也不该无人看管地挂着 */
export const MAX_TIMEOUT_MS = 8 * 3600_000
const KEEP_LINES = 300
/** 每个对话最多留多少条记录（做完的旧记录丢掉） */
const KEEP_JOBS = 20
/**
 * 停止之后给进程退出的时间。孙进程（npm → node → 测试进程）被重新挂接、还握着继承来的 stdout 时，
 * close 可能永远不来；记录不能跟着一起挂，到点先置终态，残留进程交给下次启动的遗留清理
 */
const KILL_GRACE_MS = 8000
/**
 * 整个面板同时跑的后台命令上限的默认值（设置里的 backgroundLimit）。独占命令只按目录排队，可每个子对话的
 * 独立分支是不同的目录，按目录排队拦不住几十条编译、测试一起跑，所以还要一个全局兜底。
 * 超过上限的照样马上返回、记成排队，前面的跑完一条就开始
 */
const MAX_RUNNING = 64
/**
 * 跑着的命令多久没有任何输出就提醒发起的对话：命令卡住（下载完了却不退出、等输入）时，
 * 对话不能一直以为它还在正常跑，要看一眼、必要时停掉重跑。只提醒，不替它停
 */
const STALL_MS = 10 * 60_000
/**
 * 跑得久的命令（就算一直有输出）到这些时间点提醒对话看一眼进度：第一次 15 分钟，之后每次翻倍（30、60、120 分钟……）。
 * 一直在刷输出的死循环、重试不停的下载不会被「没输出」认出来，靠这个让对话主动检查；翻倍是为了正常的长编译不被反复打扰
 */
const CHECK_FIRST_MS = 15 * 60_000

const STATE_TEXT: Record<BgJob['state'], string> = {
  queued: '排队中',
  running: '运行中',
  done: '成功',
  failed: '失败',
  stopped: '已停止',
}

/** 真正的用时：从开始跑到结束；没跑起来（排队时被停）就从交给面板算 */
export const jobMs = (j: BgJob) => Math.max(0, Date.parse(j.endedAt) - Date.parse(j.startedAt || j.createdAt))

function headText(j: BgJob) {
  return j.state === 'stopped'
    ? `后台命令「${j.name}」被停止了（跑了 ${fmtDuration(jobMs(j))}）`
    : `后台命令「${j.name}」跑完了：${j.state === 'done' ? '成功' : '失败'}（退出码 ${j.code ?? '无'}，用时 ${fmtDuration(jobMs(j))}）`
}

/** 推回给 Agent 的日志部分：错误和警告行、结尾、完整日志路径（shared/log-digest.ts）；没提炼过（老记录、没跑起来）按空的算 */
export function jobDigestText(j: BgJob) {
  const d = j.digest ?? { errors: [], warnings: [], errorCount: 0, warningCount: 0 }
  return digestText(j.lines, d, j.state === 'done', j.logFile)
}

/** 对话里发起这条命令的那一行工具调用跑完后显示什么：结果和输出结尾 */
export function jobOutput(j: BgJob) {
  const tail = j.lines.join('\n').slice(-6000)
  return `${bgResultHead(j.id)}${headText(j)}${j.changed ? '\n注意：跑的期间工作目录里的文件被改过，结果可能已经不准。' : ''}${tail ? `\n\n${tail}` : ''}`
}

/**
 * 兜底计时用的定时器。默认是真实的 setTimeout；测试换成可控的假时钟，推进时间就能到点，
 * 不靠真实等待（等真实定时器时事件循环先空掉，node:test 会把用例判成 cancelledByParent）
 */
export interface BgTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: BgTimers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms)
    // 兜底计时不许拖住进程退出：进程里只剩它时该退就退
    t.unref?.()
    return t
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/**
 * 工作目录的指纹：git 状态（改了、删了、多了文件都算，忽略掉的文件不算）加当前提交号；不是 git 仓库时返回空，不做比较。
 * 只用只读命令：git stash create 会写 index.lock，同一个目录并发跑后台命令时两边抢锁，失败一侧被 catch 成空指纹，
 * 于是「跑的期间文件被改过」这个提醒会偶发漏报。
 */
async function fingerprint(dir: string) {
  // --no-optional-locks：status 默认会顺手刷新索引并加锁，这里禁止它写
  const status = await capture(
    'git',
    ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'],
    dir,
    process.env,
    30_000,
  )
  if (status.code !== 0) return ''
  const head = await capture('git', ['rev-parse', 'HEAD'], dir, process.env, 10_000)
  return createHash('sha1').update(`${head.stdout.trim()}\n${status.stdout}`).digest('hex')
}

export function createBackground(
  onDone: (job: BgJob, text: string) => void,
  /** 测试用：换掉真正跑命令的实现、缩短停止后的等待上限、换成假时钟 */
  deps: {
    run?: typeof runShellIn
    killGraceMs?: number
    timers?: BgTimers
    /**
     * 每条命令置终态时（成功、失败、被停止都算）：对话里发起它的那一行工具调用要换成真实的用时和结果，
     * 不然界面上一直是交出去那一刻的「完成 0.09s」
     */
    onSettle?: (job: BgJob) => void
    /** 跑着的命令要对话看一眼：太久没有输出（见 STALL_MS）、跑了很久（见 CHECK_FIRST_MS） */
    onNotice?: (job: BgJob, text: string) => void
    stallMs?: number
    checkFirstMs?: number
    /** 测试用：现在的时间（配合假时钟） */
    now?: () => number
    /** 同时跑的上限：每次排名额时重新取（设置里改了马上生效） */
    maxRunning?: number | (() => number | Promise<number>)
    /** 完整日志落盘的目录（每个对话一个子目录，见 bg-log.ts）；不给就不落盘（测试） */
    logDir?: string
    /** 没结束的记录落盘（bg-persist.ts）：面板异常退出后重启，收口说明写清它当时跑到了哪；不给就只在内存里（测试） */
    persist?: ReturnType<typeof createBgPersist>
  } = {},
) {
  const runShell = deps.run ?? runShellIn
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS
  const timers = deps.timers ?? realTimers
  const stallMs = deps.stallMs ?? STALL_MS
  const checkFirstMs = deps.checkFirstMs ?? CHECK_FIRST_MS
  const now = deps.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  /** 最近一次取到的上限：排队提示是同步拼的，用它 */
  let maxRunning = typeof deps.maxRunning === 'number' ? deps.maxRunning : MAX_RUNNING
  const limit = async () => {
    const v = typeof deps.maxRunning === 'function' ? await deps.maxRunning() : maxRunning
    if (Number.isInteger(v) && v >= 1) maxRunning = v
    return maxRunning
  }
  /** 全局名额（见 MAX_RUNNING）：所有对话的后台命令共用一个键 */
  const gate = createSlotPool(limit)
  /** 每条命令占着的名额：置终态时就还（见 finish），不等 close——close 不来的进程不能永久占一个名额 */
  const gateFree = new Map<string, () => void>()
  const releaseGate = (id: string) => {
    const free = gateFree.get(id)
    gateFree.delete(id)
    free?.()
  }
  const jobs = new Map<string, BgJob>()
  /** 上次运行留下、还没收口的记录（异常退出前在排队或在跑）：对话里那一行收口时按它写说明，收完就删 */
  const prior = new Map((deps.persist?.load() ?? []).map((x) => [x.id, x]))
  const toRec = (j: BgJob): PersistedJob => ({
    id: j.id,
    taskId: j.taskId,
    name: j.name,
    command: j.command,
    state: j.state === 'running' ? 'running' : 'queued',
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    ...(j.logFile ? { logFile: j.logFile } : {}),
    lines: j.lines,
  })
  /** 没结束的记录写盘：交出去、开始跑、置终态时各写一次；都结束了马上写，免得退出时还留着旧记录 */
  const persist = () => {
    if (!deps.persist) return
    const open = [...jobs.values()].filter((j) => !j.endedAt)
    deps.persist.save([...open.map(toRec), ...prior.values()])
    if (!open.length) deps.persist.flush()
  }
  const aborts = new Map<string, AbortController>()
  /** 正在跑的命令什么时候真正结束：停止后要等进程退出再删工作目录（Windows 上进程占着目录删不掉） */
  const runs = new Map<string, Promise<void>>()
  /** 独占的命令（编译这类）按项目目录排队 */
  const chains = new Map<string, Promise<unknown>>()
  /** 停止后等进程退出的计时（见 armKillGrace） */
  const killTimers = new Map<string, unknown>()
  /** 盯着「多久没输出」的计时（见 watchStall） */
  const stallTimers = new Map<string, unknown>()

  /**
   * 一次后台命令的终态只从这里定：进程真结束、被停止、启动就失败、等不到进程退出，全走这里。
   * 幂等——先到的那次说了算，后到的（例如 close 终于来了）不再改状态；
   * 记录先终态、进程可能还在时，由调用方写日志说明（见 armKillGrace / recover）
   */
  function finish(j: BgJob, state: BgJob['state'], info: { code?: number | null; note?: string } = {}) {
    if (j.endedAt) return false
    j.state = state
    if (info.code !== undefined) j.code = info.code
    if (info.note) j.lines.push(info.note)
    j.endedAt = iso()
    releaseGate(j.id)
    persist()
    const t = killTimers.get(j.id)
    if (t !== undefined) {
      timers.clearTimeout(t)
      killTimers.delete(j.id)
    }
    const st = stallTimers.get(j.id)
    if (st !== undefined) {
      timers.clearTimeout(st)
      stallTimers.delete(j.id)
    }
    try {
      deps.onSettle?.(j)
    } catch (e) {
      log.warn('background', '后台命令结束后更新对话失败', { id: j.id, error: (e as Error).message })
    }
    return true
  }

  /**
   * 跑着的时候一直盯着：超过 stallMs 没有任何输出提醒对话一次（有了新输出再重新计）；
   * 跑到 nextCheckMs 提醒对话看一眼进度，之后间隔翻倍。只提醒，停不停由对话决定（stop_background）。
   * 用一串 setTimeout 而不是 setInterval：假时钟只有 setTimeout
   */
  function watch(j: BgJob) {
    // 常驻服务本来就一直跑、可以很久不输出：催它「可能卡住」「跑了很久」都是误报
    if (j.service) return
    const every = Math.min(60_000, Math.max(50, Math.min(stallMs, checkFirstMs) / 4))
    const tick = () => {
      stallTimers.delete(j.id)
      if (j.endedAt) return
      const t = now()
      const ran = t - Date.parse(j.startedAt)
      const quiet = t - Date.parse(j.lastOutputAt || j.startedAt)
      const last = j.lines.slice(-10).join('\n')
      const out = last ? `\n最后的输出：\n\`\`\`\n${last}\n\`\`\`` : ''
      const left = `面板会在跑满 ${fmtDuration(j.timeoutMs)} 时停掉它。`
      if (quiet >= stallMs && !j.stalled) {
        j.stalled = true
        j.nextCheckMs = Math.max(j.nextCheckMs ?? 0, ran + checkFirstMs)
        deps.onNotice?.(
          j,
          `【面板】后台命令「${j.name}」（编号 ${j.id}）已经跑了 ${fmtDuration(ran)}，最近 ${fmtDuration(quiet)} 没有任何输出，可能卡住了（下载或解压完了却没退出、在等输入、死锁）。\n命令：${j.command}${out}\n先用 check_background 看它现在的状态，再用只读命令核对它该产出的东西（文件、进程）在不在；确认卡住就用 stop_background 停掉，查清原因再重跑。它还在正常干活（只是不输出）就不用管，结果照样会推回来。${left}`,
        )
      } else if (j.nextCheckMs !== undefined && ran >= j.nextCheckMs) {
        j.nextCheckMs = ran * 2
        deps.onNotice?.(
          j,
          `【面板】后台命令「${j.name}」（编号 ${j.id}）已经跑了 ${fmtDuration(ran)}，还没结束（最近一次输出在 ${fmtDuration(quiet)} 前）。\n命令：${j.command}${out}\n看一眼进度是否正常：输出一直在重复（反复重试、死循环）或者明显跑偏就用 stop_background 停掉；正常就不用管，结束后结果会推回来，下一次提醒在跑满 ${fmtDuration(j.nextCheckMs)} 时。${left}`,
        )
      }
      stallTimers.set(j.id, timers.setTimeout(tick, every))
    }
    stallTimers.set(j.id, timers.setTimeout(tick, every))
  }

  /** 有输出：记下时间，之前提醒过「没输出」的重新计 */
  const heard = (j: BgJob) => {
    j.lastOutputAt = iso()
    j.stalled = false
  }

  /** 停止后开始计时：到点记录还不是终态就先置 stopped，不让门禁和「彻底完成」等一个不来的 close */
  function armKillGrace(j: BgJob) {
    if (j.endedAt || killTimers.has(j.id)) return
    const t = timers.setTimeout(() => {
      killTimers.delete(j.id)
      const note = `（进程未在 ${fmtDuration(killGraceMs)} 内退出：记录已置终态，但它可能还在跑）`
      if (!settle(j, 'stopped', { note })) return
      log.warn('background', '后台命令的进程没在限期内退出，记录先置终态', {
        id: j.id,
        task: j.taskId,
        command: j.command,
      })
    }, killGraceMs)
    killTimers.set(j.id, t)
  }

  const resultText = (j: BgJob) => {
    const head = headText(j)
    const warn = j.changed ? '\n注意：它跑的期间工作目录里的文件被改过，结果可能已经不准，必要时重跑一次。' : ''
    // 只给提炼后的日志（错误和警告行、结尾几十行、完整日志路径；成功只给最后几行），不再整段 6000 字进上下文
    const body = jobDigestText(j)
    // 结果回来是新的一轮：界面上这一轮的回复就是最新的总结（上一轮的总结说的还是「在等结果」），所以收尾时要整体重写。
    // 但只能要求「结束这一轮时」再总结：以前写「处理完这个结果后，重新总结整段工作」，模型一收到结果就先写一段总结，
    // 没有工具调用的回复会直接结束这一轮，计划还没做完就停（用户 2026-11-06 报结束前钩子反复拦住，一半紧跟在推回结果之后）
    const ask =
      '\n按这个结果接着做，不用先写总结；要结束这一轮时，最后那条回复再重新总结整段工作：现在的结论、验证结果、还在后台跑或还在等的事，不要只说这一条命令。'
    return `【面板】${head}${warn}\n命令：${j.command}${body ? `\n${body}` : ''}${ask}`
  }

  /**
   * 置终态并把结果交给发起方：除了「被停止且不需要通知」的命令，其余都走这里收口。
   * 被停止的命令默认不推回（对话自己停下、或用户停了一条不想要结果的命令）；
   * 带 notifyOnStop 的命令（面板代子对话跑的父对话测试）被**用户明确停掉**时必须有结论，
   * 否则等它的子对话永远停在「等父对话测试」。生命周期停（退出、归档、删除）不在这里回传：
   * 那类停法由重启后的 recoverParentTests 把还在 testing 的批次重排，不能误判成「测试未通过」
   */
  function settle(j: BgJob, state: BgJob['state'], info: { code?: number | null; note?: string } = {}) {
    if (!finish(j, state, info)) return false
    if (state === 'stopped' && !(j.notifyOnStop && j.stopRequested)) return true
    onDone(j, resultText(j))
    return true
  }

  async function exec(j: BgJob, root: string) {
    const ac = new AbortController()
    aborts.set(j.id, ac)
    j.state = 'running'
    j.startedAt = iso()
    j.lastOutputAt = j.startedAt
    j.nextCheckMs = checkFirstMs
    watch(j)
    const before = await fingerprint(root).catch(() => '')
    // 算指纹的时候对话可能已经被删了：不再启动
    if (ac.signal.aborted) {
      aborts.delete(j.id)
      settle(j, 'stopped')
      return
    }
    const digest = createDigest()
    const file = deps.logDir ? openJobLog(deps.logDir, j.taskId, j.id, j.command) : null
    if (file) j.logFile = file.file
    persist()
    const r = await runShell(j.command, j.cwd, {
      shell: j.shell ?? (await currentShell()),
      timeoutMs: j.timeoutMs,
      signal: ac.signal,
      env: j.env,
      onLine: (l) => {
        heard(j)
        digest.add(l)
        file?.write(l)
        j.lines.push(l)
        if (j.lines.length > KEEP_LINES) j.lines.splice(0, j.lines.length - KEEP_LINES)
      },
      // 进度条、下载进度多写在 stderr：也算有动静，不然下载着的命令会被当成卡住
      onStderr: () => heard(j),
    })
    aborts.delete(j.id)
    if (r.stderr.trim()) {
      // 错误常写在 stderr：完整的进日志和提炼，内存里照旧只留最后 40 行
      const err = r.stderr.trim().split('\n')
      for (const l of err) {
        digest.add(l)
        file?.write(l)
      }
      j.lines.push(...err.slice(-40))
    }
    file?.flush()
    j.digest = digest.digest()
    const after = before ? await fingerprint(root).catch(() => '') : ''
    j.changed = !!before && !!after && before !== after
    if (r.spawnError) j.lines.push(r.spawnError)
    if (r.killed === 'timeout') j.lines.push(`（跑满 ${fmtDuration(j.timeoutMs)} 的限时还没结束，面板已停止它）`)
    let state: BgJob['state'] = r.killed === 'stopped' ? 'stopped' : r.code === 0 && !r.spawnError ? 'done' : 'failed'
    // 退出码 0 却明显没跑起来（cmd 只打了版本横幅、UE 编译几秒就完还没有 UBT 日志）：按失败算，不报成功（bg-sanity.ts）
    const why = state === 'done' ? notRunReason(j.command, j.lines, now() - Date.parse(j.startedAt)) : ''
    if (why) {
      j.lines.push(why)
      state = 'failed'
    }
    // 已经被停止兜底置过终态（close 来晚了）：不再改状态，也不重复推结果
    if (!settle(j, state, { code: r.code })) return
    // 被停止之后：普通命令不再把结果推回去，否则会把刚停下的对话又拉起新的一轮；父对话测试要交回去（见 settle）
  }

  function run(j: BgJob, root: string) {
    const p = (async () => {
      gateFree.set(j.id, await gate.take(''))
      try {
        // 排队等名额期间被停掉（对话停止、删除）：不再启动
        if (!j.endedAt) await exec(j, root)
      } finally {
        releaseGate(j.id)
      }
    })()
      .catch((e: Error) => {
        // 启动前就出错了（读不到 shell 设置、拼不出命令行……）：命令根本没跑起来。
        // 不收口的话这条记录一直是「运行中」，结果永远不会推回，计划里等它的那一步也一直在等（用户报过对话卡在这里）
        aborts.delete(j.id)
        log.warn('background', '后台命令没能启动', { id: j.id, task: j.taskId, error: e.message })
        settle(j, 'failed', { note: `（面板没能启动这条命令：${e.message}）` })
      })
      .finally(() => runs.delete(j.id))
    runs.set(j.id, p)
    return p
  }

  return {
    /** 排一条后台命令，马上返回；root 是对话的目录（cwd 相对它），也是比较文件有没有变的范围 */
    start(input: {
      taskId: string
      /** 子任务（slot='sub' 的步骤）发起时传它自己的步骤 id：结果推回和运行区都要认出是谁起的 */
      step?: string
      name: string
      command: string
      cwd: string
      root: string
      exclusive: boolean
      env?: { key: string; value: string }[]
      /** 最多跑多少分钟：不写按默认两小时，最多八小时 */
      timeoutMinutes?: number
      /** 被停止时也要把结果交回发起方（见 BgJob.notifyOnStop） */
      notifyOnStop?: boolean
      /** 常驻服务（见 BgJob.service） */
      service?: boolean
      /** 指定 shell（见 BgJob.shell） */
      shell?: BgJob['shell']
    }) {
      const cwd = path.resolve(input.root, input.cwd || '.')
      if (path.relative(input.root, cwd).startsWith('..')) return { ok: false, info: 'cwd 不能跳出当前目录' }
      // 后台命令在面板里静默跑、输出交回对话：新开窗口的写法（start、cmd /k、Start-Process、wt）结果拿不回来，还会弹到用户面前
      if (opensWindow(input.command))
        return {
          ok: false,
          info: '不要新开命令行窗口（start、cmd /k、Start-Process、wt 这类）：去掉开窗口的那部分，直接写要跑的命令，面板在后台静默跑并把结果推回给你。',
        }
      const j: BgJob = {
        id: randomUUID().slice(0, 8),
        taskId: input.taskId,
        // 老的 jobs 文件里没有 step，读出来是 undefined：只在有值时写入，保持记录形状不变
        ...(input.step?.trim() ? { step: input.step.trim() } : {}),
        name: input.name,
        command: input.command,
        cwd,
        exclusive: input.exclusive,
        timeoutMs:
          input.timeoutMinutes && input.timeoutMinutes > 0
            ? Math.min(MAX_TIMEOUT_MS, Math.round(input.timeoutMinutes * 60_000))
            : input.service
              ? MAX_TIMEOUT_MS
              : DEFAULT_TIMEOUT_MS,
        ...(input.service ? { service: true } : {}),
        ...(input.shell ? { shell: input.shell } : {}),
        ...(input.env?.length ? { env: input.env } : {}),
        // 没带就不写：普通后台命令被停下时结果照旧不推回
        ...(input.notifyOnStop ? { notifyOnStop: true } : {}),
        state: 'queued',
        code: null,
        createdAt: iso(),
        startedAt: '',
        endedAt: '',
        lastOutputAt: '',
        lines: [],
        changed: false,
      }
      jobs.set(j.id, j)
      persist()
      // 旧记录只留最近的
      const mine = [...jobs.values()].filter((x) => x.taskId === input.taskId && x.endedAt)
      for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_JOBS))) jobs.delete(old.id)
      let ahead = 0
      if (input.exclusive) {
        ahead = [...jobs.values()].filter(
          (x) =>
            x.exclusive &&
            x.id !== j.id &&
            x.state !== 'done' &&
            x.state !== 'failed' &&
            x.state !== 'stopped' &&
            x.cwd.startsWith(input.root),
        ).length
        const prev = chains.get(input.root) ?? Promise.resolve()
        // 排队期间被停掉或者被置了终态（停止、上次退出清理）：不再执行
        const next = prev.catch(() => {}).then(() => (j.endedAt ? undefined : run(j, input.root)))
        const tail = next.catch(() => {})
        chains.set(input.root, tail)
        // 队尾跑完了就把这个目录的记录去掉：子对话的独立分支用完即删，目录一个个攒在这里不放
        void tail.then(() => chains.get(input.root) === tail && chains.delete(input.root))
      } else void run(j, input.root)
      // 名额是异步拿的，这会儿还没算上刚排的这几条：直接数还没结束的记录
      const full = [...jobs.values()].filter((x) => x.id !== j.id && !x.endedAt).length >= maxRunning
      // 常驻服务不用「已放到后台（编号…）」：界面按那句认「还在等结果」的行（bgJobIds），服务那一行该马上收口
      if (j.service)
        return {
          ok: true,
          id: j.id,
          info: `已在后台启动常驻服务「${j.name}」（服务编号 ${j.id}）。它一直跑到对话停止或你用 stop_background 停掉，面板不会催；用 check_background 看输出确认它起来了（端口、地址、报错），中途退出了结果会推回给你。不用等它，接着做下一步。`,
        }
      return {
        ok: true,
        id: j.id,
        info: `已放到后台（编号 ${j.id}）${ahead ? `，前面还有 ${ahead} 条独占命令在排队` : ''}${full ? `，面板同时最多跑 ${maxRunning} 条后台命令，它可能要等前面的跑完` : ''}。面板盯着它直到真正结束，结果（成功、失败、被停止、长时间没输出）都会推回给你：先去做不依赖它的事，没有别的事就结束这一轮等结果，不要用 sleep 轮询。`,
      }
    },
    /**
     * 按编号读一条后台命令的当前样子（界面上点命令行打开的窗口轮询它）。
     * 只给输出正文、不做任何拼接：这一段是用户要看的命令输出，和推回对话的 jobOutput 不同，
     * 不掺「跑完了」「退出码」这些面板的话。只认自己对话的编号，跨对话读别人的命令读不到
     */
    view(taskId: string, id: string): TaskJobView | null {
      const j = jobs.get(id)
      if (!j || j.taskId !== taskId) return null
      return {
        id: j.id,
        name: j.name,
        command: j.command,
        state: j.state,
        code: j.code,
        output: j.lines.join('\n'),
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        lastOutputAt: j.lastOutputAt,
      }
    },
    /** 查状态；不传编号列出这个对话的全部 */
    check(taskId: string, id: string) {
      const list = [...jobs.values()].filter((j) => j.taskId === taskId && (!id || j.id === id))
      if (!list.length) return id ? `没有编号 ${id} 的后台命令` : '这个对话没有后台命令'
      const t = now()
      return list
        .map((j) => {
          const tail = j.lines.slice(-15).join('\n')
          // 用时和「多久没输出」一起给：只看状态分不清是在正常跑还是卡住了
          const when = j.endedAt
            ? `，用时 ${fmtDuration(Date.parse(j.endedAt) - Date.parse(j.startedAt || j.createdAt))}`
            : j.startedAt
              ? `，已经跑了 ${fmtDuration(t - Date.parse(j.startedAt))}，最近一次输出在 ${fmtDuration(t - Date.parse(j.lastOutputAt || j.startedAt))} 前`
              : `，排队 ${fmtDuration(t - Date.parse(j.createdAt))}`
          return `- ${j.id}「${j.name}」：${STATE_TEXT[j.state]}${j.code !== null ? `（退出码 ${j.code}）` : ''}${when}${tail ? `\n${tail}` : ''}`
        })
        .join('\n')
    },
    /** 停掉这个对话的一条后台命令（对话判断它卡住了）：结果照常推回，说明是被停止的 */
    stopOne(taskId: string, id: string) {
      const j = jobs.get(id)
      if (!j || j.taskId !== taskId) return { ok: false, info: `没有编号 ${id} 的后台命令` }
      if (j.endedAt) return { ok: false, info: `编号 ${id} 已经结束了（${STATE_TEXT[j.state]}）` }
      // 记下是「明确停这一条」：父对话测试靠它判断要不要把结论交回子对话（见 settle）
      j.stopRequested = true
      if (j.state === 'queued') settle(j, 'stopped')
      else {
        aborts.get(j.id)?.abort()
        armKillGrace(j)
      }
      return { ok: true, info: `已停止后台命令「${j.name}」（编号 ${j.id}）` }
    },
    /**
     * 这个目录里还没结束的独占命令（正在跑的在前）：UE 编译按目录占位，申请时告诉申请方现在谁占着、
     * 也让占着的一方知道后面有人在等。不同目录（各自的 worktree）互不占位
     */
    occupants(root: string) {
      const dir = path.resolve(root)
      return [...jobs.values()]
        .filter((x) => x.exclusive && !x.endedAt && (x.cwd === dir || x.cwd.startsWith(dir + path.sep)))
        .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1))
    },
    /** 还没结束的全部后台命令（面板退出前要一条条收口） */
    active() {
      return [...jobs.values()].filter((j) => !j.endedAt)
    },
    /**
     * 上次运行留下、结果没拿到的这条命令的收口说明（bg-persist.ts）：当时在排队还是在跑、最后的输出、日志路径。
     * 取一次就从待收口的记录里删掉；不认识的返回 undefined，按「结果丢失」的老说法
     */
    lostNote(id: string) {
      const rec = prior.get(id)
      if (!rec) return undefined
      prior.delete(id)
      persist()
      return lostJobNote(rec, iso())
    },
    /** 面板认不认识这个编号：不认识的是上次运行留下、结果已经丢了的（见 reapLostJobs） */
    known(id: string) {
      return jobs.has(id)
    },
    /** 这个对话还在跑的后台命令（界面上显示） */
    list(taskId: string) {
      return [...jobs.values()].filter((j) => j.taskId === taskId)
    },
    /**
     * 后台命令跟着对话的生命周期走：对话停止、归档、删除、独立分支被删时结束它的后台命令，排队的不再执行。
     * 返回的 Promise 尽量等进程真正退出（好让调用方接着删工作目录），但不无限等：
     * 孙进程握着 stdout 时 close 可能永远不来，记录已经先置终态了，这里到上限就放
     */
    stop(taskId: string, note?: string) {
      const waits: Promise<void>[] = []
      for (const j of jobs.values()) {
        if (j.taskId !== taskId) continue
        if (note && !j.endedAt) j.lines.push(note)
        if (j.state === 'queued') {
          settle(j, 'stopped')
          continue
        }
        if (j.state !== 'running') continue
        aborts.get(j.id)?.abort()
        armKillGrace(j)
        const p = runs.get(j.id)
        if (p) waits.push(p)
      }
      const wait = Promise.allSettled(waits).then(() => {})
      let capTimer: unknown
      const cap = new Promise<void>((r) => {
        capTimer = timers.setTimeout(r, killGraceMs + 2000)
      })
      // 进程真退出了就撤掉上限计时，别留一个没人等的定时器（测试里靠它断言没有残留）
      return Promise.race([wait, cap]).finally(() => timers.clearTimeout(capTimer))
    },
    /**
     * 上一次退出（被强杀、崩溃）时还没结束的记录：进程已经不在了，不能再算「还在跑」。
     * 记录只存在内存里，正常重启本来就拿不到；留着这个入口给「同一进程里中断后重新收口」和测试注入
     */
    recover(stale: BgJob[] = [...jobs.values()]) {
      let n = 0
      for (const j of stale) {
        if (j.state !== 'queued' && j.state !== 'running') continue
        // 不走 settle：对话此刻没在跑，结果推不进去；子对话那批由 recoverParentTests 重排，对话的续接说明里列了停掉的命令
        if (finish(j, 'failed', { note: '（面板上次退出时还没结束：记录已置终态，不会再等它）' })) n++
      }
      if (n) log.warn('background', '启动时清理上次遗留的后台命令记录', { count: n })
      return n
    },
    /** 对话被删掉以后它的记录也不用留了 */
    forget(taskId: string) {
      for (const j of [...jobs.values()]) if (j.taskId === taskId && j.state !== 'running') jobs.delete(j.id)
    },
  }
}

/** 结束时那一行旁边的小字：成功不写，被停止、失败写清楚 */
export const jobDetail = (j: BgJob) =>
  j.state === 'done' ? '' : j.state === 'stopped' ? '已停止' : `退出码 ${j.code ?? '无'}`

/**
 * 把一条后台命令的结果接到对话里发起它的那一行（run_background、request_build）后面。
 * 只认还在等这条结果的那一行；那一行交出去的编号全有结果了才记用时和小字，界面从这时起不再转圈。
 * 返回有没有改到
 */
export function settleJobRow(task: Task, id: string, text: string, ok: boolean, ms: number, detail: string) {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const tool = task.messages[i].tools.find((x) => bgPendingIds(x.output ?? '').includes(id))
    if (!tool) continue
    tool.output = `${(tool.output ?? '').replace(/\s+$/, '')}\n\n${text}`
    if (!ok) tool.failed = true
    if (!bgPendingIds(tool.output).length) {
      tool.running = undefined
      // 一行一条命令时用时就是这条命令的；申请的编译有几条，按最后一条的算（它们按目录排队一条接一条）
      tool.ms = bgJobIds(tool.output).length > 1 ? (tool.ms ?? 0) + ms : ms
      tool.detail = tool.failed ? detail || tool.detail : ''
    }
    return true
  }
  return false
}

/**
 * 对话里还在等结果、但面板已经不认识的后台命令（面板被强杀、崩溃后重启，记录只在内存里）：
 * 收口成「结果丢失」的失败，不让那一行永远转圈，也不让它看着像做完了；计划里等这些命令的步骤一起收口
 * （只收那一行的话，那一步永远「等待中」）。返回收了几处
 */
export function reapLostJobs(
  task: Task,
  known: (id: string) => boolean,
  /** 上次运行留下的记录写得出的收口说明（background.lostNote）；没有就按「结果丢失」 */
  note?: (id: string) => string | undefined,
) {
  let n = 0
  for (const m of task.messages)
    for (const tool of m.tools)
      for (const id of bgPendingIds(tool.output ?? ''))
        if (
          !known(id) &&
          settleJobRow(
            task,
            id,
            `${bgResultHead(id)}${note?.(id) ?? '面板重启前它还没跑完，结果没有拿到：需要的话重跑一次。'}`,
            false,
            0,
            '结果丢失',
          )
        )
          n++
  return n + failLostWaits(task, 'background', known)
}
