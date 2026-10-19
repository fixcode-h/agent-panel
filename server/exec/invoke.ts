import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getCli, type BuildOptions } from '../../shared/clis.ts'
import { codexAppSession } from './codex-app.ts'
import { clipDetail, oneLine, parserFor, type CliEvent } from './parsers.ts'
import { runProcess, type ProcessResult } from './process.ts'
import { t } from '../../shared/i18n.ts'
import { AUTO_ANSWER } from '../asks.ts'
import { prepareAuth } from '../accounts.ts'
import { mcpConfig } from '../../shared/cli-spec.ts'
import { applyConfigFiles, merge, openAskBridge, type Ask } from '../ask-mcp.ts'
import { supportedEffort } from '../models.ts'
import { log } from '../log.ts'

/** 交给没有提问通道的 CLI 的一句用法说明 */
const ASK_HINT = '（需要向用户提问时，用工具 ask_user，不要把问题写成普通文字。）'
/** 没有插话协议的 CLI：用户可能中途补充要求，让它自己多次取 */
const NOTES_HINT =
  '（重要：开始动手前先调用 read_user_notes；之后每完成 2~3 个工具调用、以及准备执行耗时操作前再调用一次。' +
  '用户可能在你执行中补充要求，取到就结合它继续当前的任务，不要从头重做。）'

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
  /**
   * CLI 的提问要不要交给用户（会话上的「提问」开关，执行中也能改，所以每次问的时候再看）；
   * 不交时让 CLI 自己选最合适的做法。审批（命令、改文件）按设置里的权限，CLI 要确认时总是交给用户
   */
  askUser?: () => boolean
  /** 不给没有提问通道的 CLI 加提问工具（调用方自己带了提问的办法，例如 UI 设计的 ask_user） */
  noAskTool?: boolean
  /** 审批和要交给用户的提问；不给时作为 ask 事件交给 onEvent（任务页自己存在任务里） */
  onAsk?: (ev: Extract<CliEvent, { type: 'ask' }>) => void
  /** 拿到执行中控制 CLI 的方法 */
  onControl?: (c: CliControl) => void
  /**
   * 用户在执行中补充的信息（CLI 配置里 notes 为真时由调用方挂上）：
   * 这一轮里模型可以用面板的工具 read_user_notes 取走，取走的那些不再排队
   */
  readNotes?: () => string[]
  /** 随这一轮一起给模型看的图片（本机路径）：Codex 用 localImage，Claude Code 把图片放进消息里 */
  images?: string[]
  /** 这一轮额外交给 CLI 的面板工具（例如工作流的编排工具）；CLI 定义里没写怎么接 MCP 时忽略 */
  mcp?: { name: string; url: string }[]
}): Promise<ProcessResult> {
  const def = getCli(o.cliId)!
  // 模型不认的思考强度会让 CLI 启动即报错退出（退出码 1），整个任务白跑：按读到的模型能力挡一下，这一轮不传
  const effort = await supportedEffort(o.cliId, o.build.model ?? '', o.build.effort)
  if (effort !== (o.build.effort ?? ''))
    log.info('agent', `模型 ${o.build.model} 不支持 ${o.build.effort}，这次不带思考强度`, { cli: o.cliId })
  const build = effort === o.build.effort ? o.build : { ...o.build, effort }
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
  // 没有提问通道的 CLI（无界面运行的 Command Code、Gemini CLI）：这一轮临时接一个提问工具，
  // 模型调用时一直等到用户回答。Claude Code、Codex 走自己的协议，不需要
  let restore: (() => Promise<void>) | undefined
  let bridge: ReturnType<typeof openAskBridge> | undefined
  let run = { ...o, build }
  const servers = def.mcp ? [...(o.mcp ?? [])] : []
  let input = o.input
  const askable = !!o.askUser && !o.noAskTool
  const notes = def.notes ? o.readNotes : undefined
  if (def.mcp && (askable || notes) && def.protocol !== 'claude-stream' && def.protocol !== 'codex-app') {
    // 用户开着「提问」时把问题交给页面；关着时让模型自己选最合适的做法
    const ask: Ask = (ev) => (o.askUser?.() ? (o.onAsk ? o.onAsk(ev) : o.onEvent(ev)) : ev.reply(AUTO_ANSWER))
    bridge = openAskBridge({ ...(askable ? { ask } : {}), ...(notes ? { notes } : {}) })
    servers.unshift({ name: 'panel', url: bridge.url })
    // 用户开着「提问」时告诉模型有这个工具，免得它把问题写成普通文字
    if (askable && o.askUser?.()) input = `${input}\n\n${ASK_HINT}`
    // 没有插话协议的 CLI：补充排在队列里，让模型中途自己取
    if (notes) input = `${input}\n\n${NOTES_HINT}`
  }
  if (def.mcp && servers.length) {
    const tools = servers.map((s) => mcpConfig(def.mcp!, s.name, s.url))
    // 几个工具写进同一个配置文件（Gemini CLI 的 settings.json）时先合在一起，一次写进去
    const files = new Map<string, unknown>()
    for (const f of tools.flatMap((x) => x.files))
      files.set(
        f.path,
        files.has(f.path) && typeof f.content !== 'string' ? merge(files.get(f.path), f.content) : f.content,
      )
    restore = await applyConfigFiles(
      o.cwd,
      [...files].map(([p, content]) => ({ path: p, content })),
    ).catch(() => undefined)
    run = {
      ...o,
      build: { ...build, extraArgs: [...(build.extraArgs ?? []), ...tools.flatMap((x) => x.args)] },
      input,
    }
  }
  try {
    return await invoke(run, def, setControl, hard.signal)
  } finally {
    o.signal?.removeEventListener('abort', onStop)
    bridge?.close()
    await restore?.().catch(() => {})
  }
}

async function invoke(
  o: Parameters<typeof invokeCli>[0],
  def: NonNullable<ReturnType<typeof getCli>>,
  setControl: (c: CliControl) => void,
  signal: AbortSignal,
): Promise<ProcessResult> {
  // 按这个 CLI 现在用账号还是 API，先把它的配置文件改成对应的样子
  await prepareAuth(o.cliId)
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

  const emit = (ev: CliEvent) => {
    if (ev.type !== 'ask') return o.onEvent(ev)
    if (ev.kind === 'question' && !o.askUser?.()) return ev.reply(AUTO_ANSWER)
    return o.onAsk ? o.onAsk(ev) : o.onEvent(ev)
  }

  if (def.protocol === 'codex-app') {
    const session = codexAppSession({ ...o.build, cwd: o.cwd, input: o.input, images: o.images })
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
      o.onEvent({ type: 'result', ok: false, error: t('{cli} 没有完成这一轮就退出了', { cli: def.name }) })
    return r
  }

  const parse = parserFor(o.cliId, o.cwd)

  // Claude Code 的控制协议：任务描述是 stdin 上的一条 user 消息，审批请求是 control_request（can_use_tool），
  // 回 control_response；stdin 要一直开着，收到 result 再关掉，CLI 读到 EOF 退出。
  // 执行中插话是再写一条 user 消息（priority next：在这一轮里接着处理），中断是 control_request（interrupt）
  if (def.protocol === 'claude-stream') {
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
        line({ type: 'user', message: { role: 'user', content: withImages(o.input, o.images) } })
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
                  ? { behavior: 'allow', updatedInput: claudeAnswer(name, input, r.answer, r.answers) }
                  : {
                      behavior: 'deny',
                      message: r.message ?? (r.answer ? `用户拒绝了：${r.answer}` : '用户拒绝了这个操作'),
                    },
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
    const qs = (Array.isArray(input?.questions) ? input.questions : []).map((q: any) => ({
      header: str(q?.header),
      question: str(q?.question),
      options: (Array.isArray(q?.options) ? q.options : [])
        .map((x: any) => ({ label: str(x?.label), description: str(x?.description) }))
        .filter((x: { label: string }) => x.label),
      multiSelect: !!q?.multiSelect,
    }))
    const q = qs[0] ?? { header: '', question: '', options: [] }
    return {
      kind: 'question',
      title: q.question || t('有一个问题需要你回答'),
      detail: q.header,
      options: q.options.map((x: { label: string }) => x.label),
      questions: qs.length ? qs : undefined,
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

/** 允许时交回给 CLI 的参数：问题要带上用户的回答（一次问了几个时每个问题一条） */
function claudeAnswer(name: string, input: any, answer?: string, answers?: string[]) {
  if (name !== 'AskUserQuestion' || (!answer && !answers?.length)) return input
  const qs: any[] = Array.isArray(input?.questions) ? input.questions : []
  const got = answers?.length ? answers : [answer ?? '']
  const map = Object.fromEntries(qs.map((q, i) => [String(q?.question ?? ''), got[i] ?? '']).filter(([, v]) => v))
  return { ...input, answers: { ...(input.answers ?? {}), ...map } }
}

/** Claude Code 的用户消息：有图片时把图片（base64）跟文字放在一起，模型直接看得到 */
function withImages(text: string, images: string[] | undefined) {
  const blocks = (images ?? []).flatMap((p) => {
    const ext = p.split('.').pop()?.toLowerCase() ?? ''
    const media = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext]
    if (!media) return []
    try {
      return [
        { type: 'image', source: { type: 'base64', media_type: media, data: readFileSync(p).toString('base64') } },
      ]
    } catch {
      return []
    }
  })
  return blocks.length ? [{ type: 'text', text }, ...blocks] : text
}
