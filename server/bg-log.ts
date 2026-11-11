import path from 'node:path'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { log } from './log.ts'

/**
 * 后台命令的完整日志落盘（工作包 I）：内存里只留最近 300 行，推回对话的是提炼后的错误和结尾（shared/log-digest.ts），
 * 模型要看细节时按路径去搜这个文件。每个对话一个目录，只留最近 KEEP_LOGS 份，不无限占盘。
 * 写盘失败只记日志、不影响命令本身：日志是给人和模型查的，丢了不该让编译失败
 */
const KEEP_LOGS = 30

const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_')

export interface JobLog {
  file: string
  write: (line: string) => void
  /** 把攒着的行写进去：命令结束时调一次 */
  flush: () => void
}

/** 攒够这么多行再写一次：编译日志动辄几万行，一行一写太费 */
const BATCH = 200

export function openJobLog(root: string, taskId: string, jobId: string, command: string): JobLog | null {
  const dir = path.join(root, safe(taskId))
  const file = path.join(dir, `${safe(jobId)}.log`)
  try {
    mkdirSync(dir, { recursive: true })
    prune(dir)
    appendFileSync(file, `$ ${command}\n`)
  } catch (e) {
    log.warn('background', '后台命令的日志文件建不起来', { file, error: (e as Error).message })
    return null
  }
  let broken = false
  let pending: string[] = []
  const flush = () => {
    if (broken || !pending.length) return
    const text = `${pending.join('\n')}\n`
    pending = []
    try {
      appendFileSync(file, text)
    } catch (e) {
      broken = true
      log.warn('background', '后台命令的日志写不进去', { file, error: (e as Error).message })
    }
  }
  return {
    file,
    write: (line) => {
      if (broken) return
      pending.push(line)
      if (pending.length >= BATCH) flush()
    },
    flush,
  }
}

/** 只留最近的几份（按修改时间） */
function prune(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const x of files.slice(KEEP_LOGS - 1)) unlinkSync(path.join(dir, x.f))
}
