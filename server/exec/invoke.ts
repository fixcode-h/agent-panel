import { randomUUID } from 'node:crypto'
import { getCli, type BuildOptions } from '../../shared/clis.ts'
import { codexAppSession } from './codex-app.ts'
import { clipDetail, oneLine, parserFor, type CliEvent } from './parsers.ts'
import { runProcess, type ProcessResult } from './process.ts'
import { t } from '../../shared/i18n.ts'

/** 执行中控制 CLI：插话（把要求交给正在跑的这一轮）、中断（让 CLI 自己停下这一轮，会话保存完整） */
export interface CliControl {
  steer: (text: string) => Promise<boolean>
  interrupt: () => boolean
}

/** 中断后等 CLI 自己收尾的时间，超过就直接结束进程 */
const INTERRUPT_GRACE_MS = 8000

/**
 * 调用一次 CLI，把输出统一成 CliEvent。Claude Code、Command Code 是「stdin 写任务描述 + stdout 一行一个事件」，
 * Codex 走 app-server 协议（流式输出只有它有）。任务执行和 AI 创建共用这里。
 */
export async function invokeCli(o: {
  cliId: string
  command: string
  build: BuildOptions
  cwd: string
  env: NodeJS.ProcessEnv
  input: string
  signal?: AbortSignal
  timeoutMs: number
  idle?: Parameters<typeof runProcess>[0]['idle']
  onEvent: (ev: CliEvent) => void
  /** 能把审批请求交给用户（任务页）；不能时（AI 创建）一律拒绝，免得 CLI 一直等 */
  canAsk?: boolean
  /** 拿到执行中控制 CLI 的方法 */
  onControl?: (c: CliControl) => void
}): Promise<ProcessResult> {
  const def = getCli(o.cliId)!
  // 停止时先让 CLI 自己中断这一轮（会话里留下完整的记录，继续时上下文还在），一会儿还没退出再结束进程
  let control: CliControl = { steer: async () => false, interrupt: () => false }
  const setControl = (c: CliControl) => {
    control = c
    o.onControl?.(c)
  }
  const hard = new AbortController()
  const onStop = () => {
    if (!control.interrupt()) return hard.abort()
    setTimeout(() => hard.abort(), INTERRUPT_GRACE_MS).unref?.()
  }
  if (o.signal?.aborted) hard.abort()
  else o.signal?.addEventListener('abort', onStop, { once: true })
  try {
    return await invoke(o, def, setControl, hard.signal)
  } finally {
    o.signal?.removeEventListener('abort', onStop)
  }
}

async function invoke(
  o: Parameters<typeof invokeCli>[0],
  def: NonNullable<ReturnType<typeof getCli>>,
  setControl: (c: CliControl) => void,
  signal: AbortSignal,
): Promise<ProcessResult> {
  const args = def.buildArgs(o.build)
  const toJson = (line: string) => {
    const t = line.trim()
    if (!t.startsWith('{')) return undefined
    try {
      return JSON.parse(t)
    } catch {
      return undefined
    }
  }

  // 没人能确认时直接拒绝
  const emit = (ev: CliEvent) => (ev.type === 'ask' && !o.canAsk ? ev.reply({ allow: false }) : o.onEvent(ev))

  if (o.cliId === 'codex') {
    const session = codexAppSession({ ...o.build, cwd: o.cwd, input: o.input })
    setControl({ steer: (text) => session.steer(text), interrupt: () => session.interrupt() })
    const r = await runProcess({
      command: o.command,
      args,
      cwd: o.cwd,
      env: o.env,
      signal,
      timeoutMs: o.timeoutMs,
      idle: o.idle,
      onSpawn: (io) => session.start(io),
      onLine: (line) => {
        const obj = toJson(line)
        if (obj) for (const ev of session.handle(obj)) emit(ev)
      },
    })
    // 没等到 turn/completed 就退出了（崩溃、配置错误），算失败
    if (!session.finished && !r.killed && !r.spawnError)
      o.onEvent({ type: 'result', ok: false, error: t('Codex 没有完成这一轮就退出了') })
    return r
  }

  const parse = parserFor(o.cliId, o.cwd)

  // Claude Code 的控制协议：任务描述是 stdin 上的一条 user 消息，审批请求是 control_request（can_use_tool），
  // 回 control_response；stdin 要一直开着，收到 result 再关掉，CLI 读到 EOF 退出。
  // 执行中插话是再写一条 user 消息（priority next：在这一轮里接着处理），中断是 control_request（interrupt）
  if (args.includes('--input-format')) {
    let io: { write: (s: string) => void; end: () => void } | undefined
    const line = (m: object) => io?.write(JSON.stringify(m) + '\n')
    let ended = false
    let steered = false
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const close = () => {
      ended = true
      io?.end()
    }
    setControl({
      steer: async (text) => {
        if (ended || !io) return false
        steered = true
        line({ type: 'user', message: { role: 'user', content: text }, priority: 'next', parent_tool_use_id: null })
        return true
      },
      interrupt: () => {
        if (ended || !io) return false
        line({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
        return true
      },
    })
    return runProcess({
      command: o.command,
      args,
      cwd: o.cwd,
      env: o.env,
      onSpawn: (w) => {
        io = w
        line({ type: 'user', message: { role: 'user', content: o.input } })
      },
      signal,
      timeoutMs: o.timeoutMs,
      idle: o.idle,
      onLine: (l) => {
        const obj = toJson(l)
        if (!obj) return
        // 插过话：这一轮结束后 CLI 可能接着处理插进来的要求，有新输出就先不关
        if (closeTimer && obj.type !== 'control_response') {
          clearTimeout(closeTimer)
          closeTimer = undefined
        }
        if (obj.type === 'control_response') return
        if (obj.type === 'control_request') {
          const respond = (response: object) =>
            line({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response } })
          if (obj.request?.subtype !== 'can_use_tool')
            return line({
              type: 'control_response',
              response: { subtype: 'error', request_id: obj.request_id, error: '面板不支持这个请求' },
            })
          const name = String(obj.request.tool_name ?? '')
          const input = obj.request.input ?? {}
          return emit({
            type: 'ask',
            ...claudeAsk(name, input),
            reply: (r) =>
              respond(
                r.allow
                  ? { behavior: 'allow', updatedInput: claudeAnswer(name, input, r.answer) }
                  : { behavior: 'deny', message: r.answer ? `用户拒绝了：${r.answer}` : '用户拒绝了这个操作' },
              ),
          })
        }
        for (const ev of parse(obj)) {
          emit(ev)
          if (ev.type === 'result') closeTimer = setTimeout(close, steered ? 2500 : 0)
        }
      },
    })
  }

  return runProcess({
    command: o.command,
    args,
    cwd: o.cwd,
    env: o.env,
    stdin: o.input,
    signal,
    timeoutMs: o.timeoutMs,
    idle: o.idle,
    onLine: (line) => {
      const obj = toJson(line)
      if (obj) for (const ev of parse(obj)) emit(ev)
    },
  })
}

/** Claude Code 要确认的工具调用，换成给用户看的一句话 */
export function claudeAsk(name: string, input: any): Omit<Extract<CliEvent, { type: 'ask' }>, 'reply' | 'type'> {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (name === 'AskUserQuestion') {
    const q = input?.questions?.[0] ?? {}
    return {
      kind: 'question',
      title: str(q.question) || t('有一个问题需要你回答'),
      detail: str(q.header),
      options: (q.options ?? []).map((x: any) => str(x?.label)).filter(Boolean),
    }
  }
  if (name === 'Bash')
    return {
      kind: 'command',
      title: t('运行命令：{cmd}', { cmd: oneLine(str(input.command)) }),
      detail: str(input.description),
    }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name))
    return {
      kind: 'file',
      title:
        name === 'Write'
          ? t('写入文件：{file}', { file: str(input.file_path || input.notebook_path) })
          : t('修改文件：{file}', { file: str(input.file_path || input.notebook_path) }),
      detail: '',
    }
  if (name === 'WebFetch')
    return { kind: 'tool', title: t('访问网页：{url}', { url: str(input.url) }), detail: str(input.prompt) }
  return { kind: 'tool', title: t('使用工具：{name}', { name }), detail: clipDetail(JSON.stringify(input, null, 2)) }
}

/** 允许时交回给 CLI 的参数：问题要带上用户选的答案 */
function claudeAnswer(name: string, input: any, answer?: string) {
  if (name !== 'AskUserQuestion' || !answer) return input
  const q = input?.questions?.[0]?.question ?? ''
  return { ...input, answers: { ...(input.answers ?? {}), [q]: answer } }
}
