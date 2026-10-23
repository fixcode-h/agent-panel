import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { capture } from './exec/process.ts'
import { runShell as runShellIn } from './merge-build.ts'
import { currentShell } from './shells.ts'
import { log } from './log.ts'

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
  startedAt: string
  endedAt: string
  /** 最近的输出（只留结尾） */
  lines: string[]
  /** 跑的期间工作目录里的文件变了：结果可能已经不准 */
  changed: boolean
  /** 额外的环境变量（子对话的独立分支禁止推送） */
  env?: { key: string; value: string }[]
}

/** 没有限时的后台命令最多跑多久 */
const MAX_MS = 2 * 3600_000
const KEEP_LINES = 300
/** 每个对话最多留多少条记录（做完的旧记录丢掉） */
const KEEP_JOBS = 20
/**
 * 停止之后给进程退出的时间。孙进程（npm → node → 测试进程）被重新挂接、还握着继承来的 stdout 时，
 * close 可能永远不来；记录不能跟着一起挂，到点先置终态，残留进程交给下次启动的遗留清理
 */
const KILL_GRACE_MS = 8000

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
  deps: { run?: typeof runShellIn; killGraceMs?: number; timers?: BgTimers } = {},
) {
  const runShell = deps.run ?? runShellIn
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS
  const timers = deps.timers ?? realTimers
  const jobs = new Map<string, BgJob>()
  const aborts = new Map<string, AbortController>()
  /** 正在跑的命令什么时候真正结束：停止后要等进程退出再删工作目录（Windows 上进程占着目录删不掉） */
  const runs = new Map<string, Promise<void>>()
  /** 独占的命令（编译这类）按项目目录排队 */
  const chains = new Map<string, Promise<unknown>>()
  /** 停止后等进程退出的计时（见 armKillGrace） */
  const killTimers = new Map<string, unknown>()

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
    j.endedAt = new Date().toISOString()
    const t = killTimers.get(j.id)
    if (t !== undefined) {
      timers.clearTimeout(t)
      killTimers.delete(j.id)
    }
    return true
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
    const secs = Math.round((Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 1000)
    const head =
      j.state === 'stopped'
        ? `后台命令「${j.name}」被停止了`
        : `后台命令「${j.name}」跑完了：${j.state === 'done' ? '成功' : '失败'}（退出码 ${j.code ?? '无'}，用时 ${secs} 秒）`
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
    j.startedAt = new Date().toISOString()
    const before = await fingerprint(root).catch(() => '')
    // 算指纹的时候对话可能已经被删了：不再启动
    if (ac.signal.aborted) {
      aborts.delete(j.id)
      finish(j, 'stopped')
      return
    }
    const r = await runShell(j.command, j.cwd, {
      shell: await currentShell(),
      timeoutMs: MAX_MS,
      signal: ac.signal,
      env: j.env,
      onLine: (l) => {
        j.lines.push(l)
        if (j.lines.length > KEEP_LINES) j.lines.splice(0, j.lines.length - KEEP_LINES)
      },
    })
    aborts.delete(j.id)
    if (r.stderr.trim()) j.lines.push(...r.stderr.trim().split('\n').slice(-40))
    const after = before ? await fingerprint(root).catch(() => '') : ''
    j.changed = !!before && !!after && before !== after
    if (r.spawnError) j.lines.push(r.spawnError)
    if (r.killed === 'timeout') j.lines.push('（超过两小时，已停止）')
    const state = r.killed === 'stopped' ? 'stopped' : r.code === 0 && !r.spawnError ? 'done' : 'failed'
    // 已经被停止兜底置过终态（close 来晚了）：不再改状态，也不重复推结果
    if (!finish(j, state, { code: r.code })) return
    // 被停止的是对话自己结束了（停止、归档、删除）：不再把结果推回去，不然会把刚停下的对话又拉起新的一轮
    if (state !== 'stopped') onDone(j, resultText(j))
  }

  function run(j: BgJob, root: string) {
    const p = exec(j, root).finally(() => runs.delete(j.id))
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
        ...(input.env?.length ? { env: input.env } : {}),
        state: 'queued',
        code: null,
        startedAt: '',
        endedAt: '',
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
        chains.set(
          input.root,
          next.catch(() => {}),
        )
      } else void run(j, input.root)
      return {
        ok: true,
        id: j.id,
        info: `已放到后台（编号 ${j.id}）${ahead ? `，前面还有 ${ahead} 条独占命令在排队` : ''}。跑完结果会自动推回给你，先去做不依赖它的事。`,
      }
    },
    /** 查状态；不传编号列出这个对话的全部 */
    check(taskId: string, id: string) {
      const list = [...jobs.values()].filter((j) => j.taskId === taskId && (!id || j.id === id))
      if (!list.length) return id ? `没有编号 ${id} 的后台命令` : '这个对话没有后台命令'
      return list
        .map((j) => {
          const tail = j.lines.slice(-15).join('\n')
          return `- ${j.id}「${j.name}」：${j.state}${j.code !== null ? `（退出码 ${j.code}）` : ''}${tail ? `\n${tail}` : ''}`
        })
        .join('\n')
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
    stop(taskId: string) {
      const waits: Promise<void>[] = []
      for (const j of jobs.values()) {
        if (j.taskId !== taskId) continue
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
