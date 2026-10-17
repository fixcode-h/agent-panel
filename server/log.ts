/**
 * 运行日志：所有报错和关键事件写进程序目录（server.mjs 所在的目录，从源码运行时是仓库根目录）下的 logs/，
 * 出了问题把日志文件发出来就能查。程序目录写不进去时（例如装在只读的目录里）改写到数据目录下的 logs/。
 *
 *   <程序目录>/logs/
 *     agent-panel-20261017-090129-38148.log     每次启动一个新文件（启动时间 + 进程号）
 *     agent-panel-20261017-090129-38148.2.log   同一次运行写满 5 MB 换下一个
 *
 * 只保留最近 30 个文件、合计不超过 100 MB，旧的启动时删掉。
 * 第一次写日志时才建文件：`--self-check` 这种只加载一下就退出的运行不会留下空文件。
 * 不引用 store.ts、update.ts（它们自己也要写日志），程序目录和数据目录按同样的规则算。
 */
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, inspect } from 'node:util'

declare const __APP_VERSION__: string | undefined
/** 程序目录：和 update.ts 的 appDir 一样，出包后是 server.mjs 所在目录 */
const programDir =
  process.env.AGENT_PANEL_APP_DIR ??
  (typeof __APP_VERSION__ === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd())
const FALLBACK_DIR = path.join(process.env.AGENT_PANEL_DATA ?? path.join(homedir(), '.agent-panel'), 'logs')
let dir = path.join(programDir, 'logs')
/** 日志所在的目录 */
export const logDir = () => dir
const MAX_FILE = 5 * 1024 * 1024
const KEEP_FILES = 30
const KEEP_BYTES = 100 * 1024 * 1024

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const started = new Date()
const base = `agent-panel-${started.getFullYear()}${pad(started.getMonth() + 1)}${pad(started.getDate())}-${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}-${process.pid}`

let part = 1
let size = 0
let file = ''
let broken = false

/** 当前写的日志文件；还没写过时为空 */
export const logFile = () => file

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 删掉旧日志：按修改时间保留最近的，当前这次运行的不删 */
function prune() {
  try {
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.log') && !f.startsWith(base))
      .map((f) => {
        const p = path.join(dir, f)
        const s = statSync(p)
        return { p, at: s.mtimeMs, size: s.size }
      })
      .sort((a, b) => b.at - a.at)
    let total = 0
    all.forEach((f, i) => {
      total += f.size
      if (i >= KEEP_FILES - 1 || total > KEEP_BYTES) unlinkSync(f.p)
    })
  } catch {}
}

function open() {
  try {
    mkdirSync(dir, { recursive: true })
    if (!file) appendFileSync(path.join(dir, `${base}.log`), '')
  } catch (e) {
    if (dir === FALLBACK_DIR) throw e
    dir = FALLBACK_DIR
    mkdirSync(dir, { recursive: true })
  }
  if (!file) prune()
  file = path.join(dir, part === 1 ? `${base}.log` : `${base}.${part}.log`)
  size = 0
  const head = [
    `# Agent 面板运行日志${part > 1 ? `（第 ${part} 部分）` : ''}`,
    `# 启动于 ${stamp(started)}，进程 ${process.pid}`,
    `# Node ${process.version} · ${process.platform} ${process.arch} · ${process.argv.slice(1).join(' ')}`,
    '',
  ].join('\n')
  appendFileSync(file, head + '\n')
  size += Buffer.byteLength(head) + 1
}

function write(line: string) {
  if (broken) return
  try {
    if (!file) open()
    else if (size > MAX_FILE) {
      part++
      open()
    }
    appendFileSync(file, line)
    size += Buffer.byteLength(line)
  } catch {
    // 日志写不进去（磁盘满、没权限）不能影响程序本身，之后也不再试
    broken = true
  }
}

/** 附带的信息：字符串原样多行缩进，错误带上调用栈和 cause，其他转成 JSON */
function extra(data: unknown): string {
  if (data === undefined) return ''
  const one = (v: unknown): string => {
    if (v instanceof Error) {
      const cause = (v as Error & { cause?: unknown }).cause
      return (v.stack ?? `${v.name}: ${v.message}`) + (cause ? `\ncause: ${one(cause)}` : '')
    }
    if (typeof v === 'string') return v
    return inspect(v, { depth: 6, breakLength: 160, maxStringLength: 20_000 })
  }
  const body =
    data && typeof data === 'object' && !(data instanceof Error) && !Array.isArray(data)
      ? Object.entries(data as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => {
            const s = one(v)
            return s.includes('\n') ? `${k}:\n${s}` : `${k}: ${s}`
          })
          .join('\n')
      : one(data)
  return body ? '\n' + body.replace(/^/gm, '    ') : ''
}

function emit(level: Level, scope: string, msg: string, data?: unknown) {
  // 日志会发给别人看，访问令牌不写进去
  const line = `${stamp()} ${level.padEnd(5)} [${scope}] ${msg}${extra(data)}\n`.replace(/token=[\w-]+/g, 'token=***')
  write(line)
}

export const log = {
  debug: (scope: string, msg: string, data?: unknown) => emit('DEBUG', scope, msg, data),
  info: (scope: string, msg: string, data?: unknown) => emit('INFO', scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => emit('WARN', scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => emit('ERROR', scope, msg, data),
}

/**
 * 服务端启动时调用一次：console 的输出也抄一份进日志（照常打印到终端），
 * 没接住的异常和 Promise 拒绝都记下来。
 */
export function installLogging() {
  const wrap = (level: Level, orig: (...a: unknown[]) => void) =>
    function (...args: unknown[]) {
      orig.apply(console, args)
      const text = format(...args)
      // 给托盘程序看的握手行不用记
      if (!/^AGENT_PANEL_(READY|OPEN) /.test(text)) emit(level, 'console', text)
    }
  console.log = wrap('INFO', console.log)
  console.info = wrap('INFO', console.info)
  console.warn = wrap('WARN', console.warn)
  console.error = wrap('ERROR', console.error)

  process.on('uncaughtException', (e) => {
    emit('ERROR', 'process', '未处理的异常，程序退出', e)
    process.stderr.write(`${e.stack ?? e}\n`)
    process.exit(1)
  })
  // 漏掉的 Promise 拒绝只记下来，不让整个服务因为一处疏漏退出
  process.on('unhandledRejection', (e) => emit('ERROR', 'process', '未处理的 Promise 拒绝', e))
  process.on('exit', (code) => emit('INFO', 'process', `进程退出，退出码 ${code}`))
}
