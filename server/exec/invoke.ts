import { getCli, type BuildOptions } from '../../shared/clis.ts'
import { codexAppSession } from './codex-app.ts'
import { clipDetail, oneLine, parserFor, type CliEvent } from './parsers.ts'
import { runProcess, type ProcessResult } from './process.ts'
import { t } from '../../shared/i18n.ts'

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
}): Promise<ProcessResult> {
  const def = getCli(o.cliId)!
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
    const r = await runProcess({
      command: o.command,
      args,
      cwd: o.cwd,
      env: o.env,
      signal: o.signal,
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
  // 回 control_response；stdin 要一直开着，收到 result 再关掉，CLI 读到 EOF 退出
  if (args.includes('--permission-prompt-tool')) {
    let io: { write: (s: string) => void; end: () => void } | undefined
    const line = (m: object) => io?.write(JSON.stringify(m) + '\n')
    return runProcess({
      command: o.command,
      args,
      cwd: o.cwd,
      env: o.env,
      onSpawn: (w) => {
        io = w
        line({ type: 'user', message: { role: 'user', content: o.input } })
      },
      signal: o.signal,
      timeoutMs: o.timeoutMs,
      idle: o.idle,
      onLine: (l) => {
        const obj = toJson(l)
        if (!obj) return
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
          if (ev.type === 'result') setTimeout(() => io?.end(), 0)
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
    signal: o.signal,
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
