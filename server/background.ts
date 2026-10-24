import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { capture } from './exec/process.ts'
import { runShell as runShellIn } from './merge-build.ts'
import { currentShell } from './shells.ts'
import { log } from './log.ts'
import { createSlotPool } from './slots.ts'

/**
 * 后台命令：CLI 把要跑很久的命令（完整测试、编译）交给面板，自己接着干别的；
 * 面板跑完把结果推回那个对话。CLI 各自的后台能力不统一（Claude Code 有，Codex、Command Code 没有），放在面板这层所有 CLI 都能用。
 */

export interface BgJob {
  id: string
  taskId: string
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
  /** 跑的期间工作目录里的文件变了：结果可能已经不准 */
  changed: boolean
  /** 额外的环境变量（子对话的独立分支禁止推送） */
  env?: { key: string; value: string }[]
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
 * 独立分支是不同的目录：父对话派出十几个子对话、各自交一条完整测试或编译，CPU、内存会被吃满，
 * 面板和整台机器一起卡住。超过上限的照样马上返回、记成排队，前面的跑完一条就开始
 */
const MAX_RUNNING = 16
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

/** 用时的说法：不到一分钟写秒，再长写「几分几秒」 */
function fmtSecs(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/** 真正的用时：从开始跑到结束；没跑起来（排队时被停）就从交给面板算 */
export const jobMs = (j: BgJob) => Math.max(0, Date.parse(j.endedAt) - Date.parse(j.startedAt || j.createdAt))

function headText(j: BgJob) {
  return j.state === 'stopped'
    ? `后台命令「${j.name}」被停止了（跑了 ${fmtSecs(jobMs(j))}）`
    : `后台命令「${j.name}」跑完了：${j.state === 'done' ? '成功' : '失败'}（退出码 ${j.code ?? '无'}，用时 ${fmtSecs(jobMs(j))}）`
}

/** 对话里发起这条命令的那一行工具调用跑完后显示什么：结果和输出结尾 */
export function jobOutput(j: BgJob) {
  const tail = j.lines.join('\n').slice(-6000)
  return `${headText(j)}${j.changed ? '\n注意：跑的期间工作目录里的文件被改过，结果可能已经不准。' : ''}${tail ? `\n\n${tail}` : ''}`
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
    const every = Math.min(60_000, Math.max(50, Math.min(stallMs, checkFirstMs) / 4))
    const tick = () => {
      stallTimers.delete(j.id)
      if (j.endedAt) return
      const t = now()
      const ran = t - Date.parse(j.startedAt)
      const quiet = t - Date.parse(j.lastOutputAt || j.startedAt)
      const last = j.lines.slice(-10).join('\n')
      const out = last ? `\n最后的输出：\n\`\`\`\n${last}\n\`\`\`` : ''
      const left = `面板会在跑满 ${fmtSecs(j.timeoutMs)} 时停掉它。`
      if (quiet >= stallMs && !j.stalled) {
        j.stalled = true
        j.nextCheckMs = Math.max(j.nextCheckMs ?? 0, ran + checkFirstMs)
        deps.onNotice?.(
          j,
          `【面板】后台命令「${j.name}」（编号 ${j.id}）已经跑了 ${fmtSecs(ran)}，最近 ${fmtSecs(quiet)} 没有任何输出，可能卡住了（下载或解压完了却没退出、在等输入、死锁）。\n命令：${j.command}${out}\n先用 check_background 看它现在的状态，再用只读命令核对它该产出的东西（文件、进程）在不在；确认卡住就用 stop_background 停掉，查清原因再重跑。它还在正常干活（只是不输出）就不用管，结果照样会推回来。${left}`,
        )
      } else if (j.nextCheckMs !== undefined && ran >= j.nextCheckMs) {
        j.nextCheckMs = ran * 2
        deps.onNotice?.(
          j,
          `【面板】后台命令「${j.name}」（编号 ${j.id}）已经跑了 ${fmtSecs(ran)}，还没结束（最近一次输出在 ${fmtSecs(quiet)} 前）。\n命令：${j.command}${out}\n看一眼进度是否正常：输出一直在重复（反复重试、死循环）或者明显跑偏就用 stop_background 停掉；正常就不用管，结束后结果会推回来，下一次提醒在跑满 ${fmtSecs(j.nextCheckMs)} 时。${left}`,
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
      const note = `（进程未在 ${Math.round(killGraceMs / 1000)} 秒内退出：记录已置终态，但它可能还在跑）`
      if (!finish(j, 'stopped', { note })) return
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
    const tail = j.lines.join('\n').slice(-(j.state === 'done' ? 1500 : 6000))
    // 结果回来是新的一轮：界面上这一轮的回复就是最新的总结（上一轮的总结说的还是「在等结果」），所以要整体重写
    const ask =
      '\n处理完这个结果后，重新总结整段工作：现在的结论、验证结果、还在后台跑或还在等的事，不要只说这一条命令。'
    return `【面板】${head}${warn}\n命令：${j.command}${tail ? `\n输出结尾：\n\`\`\`\n${tail}\n\`\`\`` : ''}${ask}`
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
      finish(j, 'stopped')
      return
    }
    const r = await runShell(j.command, j.cwd, {
      shell: await currentShell(),
      timeoutMs: j.timeoutMs,
      signal: ac.signal,
      env: j.env,
      onLine: (l) => {
        heard(j)
        j.lines.push(l)
        if (j.lines.length > KEEP_LINES) j.lines.splice(0, j.lines.length - KEEP_LINES)
      },
      // 进度条、下载进度多写在 stderr：也算有动静，不然下载着的命令会被当成卡住
      onStderr: () => heard(j),
    })
    aborts.delete(j.id)
    if (r.stderr.trim()) j.lines.push(...r.stderr.trim().split('\n').slice(-40))
    const after = before ? await fingerprint(root).catch(() => '') : ''
    j.changed = !!before && !!after && before !== after
    if (r.spawnError) j.lines.push(r.spawnError)
    if (r.killed === 'timeout') j.lines.push(`（跑满 ${fmtSecs(j.timeoutMs)} 的限时还没结束，面板已停止它）`)
    const state = r.killed === 'stopped' ? 'stopped' : r.code === 0 && !r.spawnError ? 'done' : 'failed'
    // 已经被停止兜底置过终态（close 来晚了）：不再改状态，也不重复推结果
    if (!finish(j, state, { code: r.code })) return
    // 被停止的是对话自己结束了（停止、归档、删除）：不再把结果推回去，不然会把刚停下的对话又拉起新的一轮
    if (state !== 'stopped') onDone(j, resultText(j))
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
    })().finally(() => runs.delete(j.id))
    runs.set(j.id, p)
    return p
  }

  return {
    /** 排一条后台命令，马上返回；root 是对话的目录（cwd 相对它），也是比较文件有没有变的范围 */
    start(input: {
      taskId: string
      name: string
      command: string
      cwd: string
      root: string
      exclusive: boolean
      env?: { key: string; value: string }[]
      /** 最多跑多少分钟：不写按默认两小时，最多八小时 */
      timeoutMinutes?: number
    }) {
      const cwd = path.resolve(input.root, input.cwd || '.')
      if (path.relative(input.root, cwd).startsWith('..')) return { ok: false, info: 'cwd 不能跳出当前目录' }
      const j: BgJob = {
        id: randomUUID().slice(0, 8),
        taskId: input.taskId,
        name: input.name,
        command: input.command,
        cwd,
        exclusive: input.exclusive,
        timeoutMs:
          input.timeoutMinutes && input.timeoutMinutes > 0
            ? Math.min(MAX_TIMEOUT_MS, Math.round(input.timeoutMinutes * 60_000))
            : DEFAULT_TIMEOUT_MS,
        ...(input.env?.length ? { env: input.env } : {}),
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
      return {
        ok: true,
        id: j.id,
        info: `已放到后台（编号 ${j.id}）${ahead ? `，前面还有 ${ahead} 条独占命令在排队` : ''}${full ? `，面板同时最多跑 ${maxRunning} 条后台命令，它可能要等前面的跑完` : ''}。面板盯着它直到真正结束，结果（成功、失败、被停止、长时间没输出）都会推回给你：先去做不依赖它的事，没有别的事就结束这一轮等结果，不要用 sleep 轮询。`,
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
            ? `，用时 ${fmtSecs(Date.parse(j.endedAt) - Date.parse(j.startedAt || j.createdAt))}`
            : j.startedAt
              ? `，已经跑了 ${fmtSecs(t - Date.parse(j.startedAt))}，最近一次输出在 ${fmtSecs(t - Date.parse(j.lastOutputAt || j.startedAt))} 前`
              : `，排队 ${fmtSecs(t - Date.parse(j.createdAt))}`
          return `- ${j.id}「${j.name}」：${STATE_TEXT[j.state]}${j.code !== null ? `（退出码 ${j.code}）` : ''}${when}${tail ? `\n${tail}` : ''}`
        })
        .join('\n')
    },
    /** 停掉这个对话的一条后台命令（对话判断它卡住了）：结果照常推回，说明是被停止的 */
    stopOne(taskId: string, id: string) {
      const j = jobs.get(id)
      if (!j || j.taskId !== taskId) return { ok: false, info: `没有编号 ${id} 的后台命令` }
      if (j.endedAt) return { ok: false, info: `编号 ${id} 已经结束了（${STATE_TEXT[j.state]}）` }
      if (j.state === 'queued') finish(j, 'stopped')
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
          finish(j, 'stopped')
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
