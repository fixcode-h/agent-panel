import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { capture } from './exec/process.ts'
import { runShell } from './merge-build.ts'
import { currentShell } from './shells.ts'

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
}

/** 没有限时的后台命令最多跑多久 */
const MAX_MS = 2 * 3600_000
const KEEP_LINES = 300
/** 每个对话最多留多少条记录（做完的旧记录丢掉） */
const KEEP_JOBS = 20

/** 工作目录的指纹：跟踪的文件内容（git stash create）+ 未跟踪的文件列表；不是 git 仓库时返回空，不做比较 */
async function fingerprint(dir: string) {
  const stash = await capture('git', ['stash', 'create'], dir, process.env, 30_000)
  if (stash.code !== 0) return ''
  const head = await capture('git', ['rev-parse', 'HEAD'], dir, process.env, 10_000)
  const untracked = await capture('git', ['ls-files', '--others', '--exclude-standard'], dir, process.env, 30_000)
  return createHash('sha1')
    .update(`${stash.stdout.trim() || head.stdout.trim()}\n${untracked.stdout}`)
    .digest('hex')
}

export function createBackground(onDone: (job: BgJob, text: string) => void) {
  const jobs = new Map<string, BgJob>()
  const aborts = new Map<string, AbortController>()
  /** 正在跑的命令什么时候真正结束：停止后要等进程退出再删工作目录（Windows 上进程占着目录删不掉） */
  const runs = new Map<string, Promise<void>>()
  /** 独占的命令（编译这类）按项目目录排队 */
  const chains = new Map<string, Promise<unknown>>()

  const resultText = (j: BgJob) => {
    const secs = Math.round((Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 1000)
    const head =
      j.state === 'stopped'
        ? `后台命令「${j.name}」被停止了`
        : `后台命令「${j.name}」跑完了：${j.state === 'done' ? '成功' : '失败'}（退出码 ${j.code ?? '无'}，用时 ${secs} 秒）`
    const warn = j.changed ? '\n注意：它跑的期间工作目录里的文件被改过，结果可能已经不准，必要时重跑一次。' : ''
    const tail = j.lines.join('\n').slice(-(j.state === 'done' ? 1500 : 6000))
    return `【面板】${head}${warn}\n命令：${j.command}${tail ? `\n输出结尾：\n\`\`\`\n${tail}\n\`\`\`` : ''}`
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
      j.state = 'stopped'
      j.endedAt = new Date().toISOString()
      return
    }
    const r = await runShell(j.command, j.cwd, {
      shell: await currentShell(),
      timeoutMs: MAX_MS,
      signal: ac.signal,
      onLine: (l) => {
        j.lines.push(l)
        if (j.lines.length > KEEP_LINES) j.lines.splice(0, j.lines.length - KEEP_LINES)
      },
    })
    aborts.delete(j.id)
    if (r.stderr.trim()) j.lines.push(...r.stderr.trim().split('\n').slice(-40))
    const after = before ? await fingerprint(root).catch(() => '') : ''
    j.changed = !!before && !!after && before !== after
    j.code = r.code
    j.state = r.killed === 'stopped' ? 'stopped' : r.code === 0 && !r.spawnError ? 'done' : 'failed'
    if (r.spawnError) j.lines.push(r.spawnError)
    if (r.killed === 'timeout') j.lines.push('（超过两小时，已停止）')
    j.endedAt = new Date().toISOString()
    // 被停止的是对话自己结束了（停止、归档、删除）：不再把结果推回去，不然会把刚停下的对话又拉起新的一轮
    if (j.state !== 'stopped') onDone(j, resultText(j))
  }

  function run(j: BgJob, root: string) {
    const p = exec(j, root).finally(() => runs.delete(j.id))
    runs.set(j.id, p)
    return p
  }

  return {
    /** 排一条后台命令，马上返回；root 是对话的目录（cwd 相对它），也是比较文件有没有变的范围 */
    start(input: { taskId: string; name: string; command: string; cwd: string; root: string; exclusive: boolean }) {
      const cwd = path.resolve(input.root, input.cwd || '.')
      if (path.relative(input.root, cwd).startsWith('..')) return { ok: false, info: 'cwd 不能跳出当前目录' }
      const j: BgJob = {
        id: randomUUID().slice(0, 8),
        taskId: input.taskId,
        name: input.name,
        command: input.command,
        cwd,
        exclusive: input.exclusive,
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
        const next = prev.catch(() => {}).then(() => (j.state === 'stopped' ? undefined : run(j, input.root)))
        chains.set(
          input.root,
          next.catch(() => {}),
        )
      } else void run(j, input.root)
      return {
        ok: true,
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
     * 返回的 Promise 等正在跑的进程真正退出
     */
    stop(taskId: string) {
      const waits: Promise<void>[] = []
      for (const j of jobs.values()) {
        if (j.taskId !== taskId) continue
        if (j.state === 'queued') {
          j.state = 'stopped'
          j.endedAt = new Date().toISOString()
        }
        aborts.get(j.id)?.abort()
        const p = runs.get(j.id)
        if (p) waits.push(p)
      }
      return Promise.allSettled(waits).then(() => {})
    },
    /** 对话被删掉以后它的记录也不用留了 */
    forget(taskId: string) {
      for (const j of [...jobs.values()]) if (j.taskId === taskId && j.state !== 'running') jobs.delete(j.id)
    },
  }
}
