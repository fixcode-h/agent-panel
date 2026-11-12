import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fmtDuration } from '../../shared/duration.ts'
import { log } from '../log.ts'

/**
 * 后台命令的记录落盘（后台命令重新设计第三步，用户 2026-11-12 定）：以前记录只在内存里，面板被强杀、崩溃后重启，
 * 对话里那一行只能收口成「结果丢失」，看不出它跑到哪、日志在哪。现在没结束的记录（排队中、运行中）随状态变化写进
 * 数据目录的 bg-jobs.json，重启时读回来，收口说明写清它当时在排队还是在跑、跑了多久、最后的输出和完整日志的路径。
 *
 * 不自动重跑：重启后对话都是「被打断、点继续才接着做」，面板自己把编译、测试重新跑起来再把结果推回去，
 * 会在用户没点继续时开新的一轮。要不要重跑由对话按收口说明决定。
 * 正常退出时面板先停掉所有后台命令并收口（那一行写「已停止」），文件里不会留下没结束的记录
 */
export interface PersistedJob {
  id: string
  taskId: string
  name: string
  command: string
  state: 'queued' | 'running'
  createdAt: string
  startedAt: string
  logFile?: string
  /** 最近几行输出：日志文件写不进去时的兜底 */
  lines: string[]
}

const KEEP_TAIL = 20

export function createBgPersist(file: string) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let next: PersistedJob[] = []
  const write = () => {
    timer = null
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next))
    } catch (e) {
      log.warn('background', '后台命令记录没能写盘', { file, error: (e as Error).message })
    }
  }
  return {
    /** 上次运行留下的、没结束的记录（读一次，读不到按没有） */
    load(): PersistedJob[] {
      try {
        const v = JSON.parse(readFileSync(file, 'utf8'))
        return Array.isArray(v) ? (v as PersistedJob[]) : []
      } catch {
        return []
      }
    },
    /** 记下现在还没结束的全部记录：攒 300ms 写一次，状态连着变时只写最后那份 */
    save(jobs: PersistedJob[]) {
      next = jobs.map((j) => ({ ...j, lines: j.lines.slice(-KEEP_TAIL) }))
      if (timer) return
      timer = setTimeout(write, 300)
      timer.unref?.()
    },
    /** 马上写（面板退出前） */
    flush() {
      if (timer) clearTimeout(timer)
      write()
    },
  }
}

/** 日志文件的最后几行；读不到返回空 */
function logTail(file: string | undefined, n: number) {
  if (!file) return []
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    // 第一行是「$ 命令」，不算输出
    return lines.slice(1).slice(-n)
  } catch {
    return []
  }
}

/**
 * 上次运行留下、结果没拿到的后台命令：收口说明（交给 Agent 的提示词，不翻译）。
 * 排队中的说没开始跑；运行中的写跑到了哪（最后的输出）和完整日志的路径，让对话判断要不要重跑
 */
export function lostJobNote(j: PersistedJob, endedAt: string) {
  if (j.state === 'queued')
    return `后台命令「${j.name}」还在排队、没开始跑，面板就异常退出了，重启后没有自动重跑：需要的话重新交一次。`
  const ran = j.startedAt ? fmtDuration(Math.max(0, Date.parse(endedAt) - Date.parse(j.startedAt))) : ''
  const tail = logTail(j.logFile, KEEP_TAIL)
  const out = tail.length ? tail : j.lines
  return [
    `后台命令「${j.name}」跑着的时候面板异常退出了${ran ? `（到面板重启时已经过了 ${ran}）` : ''}，进程跟着没了，结果没有拿到；面板重启后没有自动重跑。`,
    out.length ? `退出前最后的输出：\n\`\`\`\n${out.join('\n')}\n\`\`\`` : '',
    j.logFile ? `完整日志：${j.logFile}` : '',
    '需要的话按上面的情况重跑一次。',
  ]
    .filter(Boolean)
    .join('\n')
}
