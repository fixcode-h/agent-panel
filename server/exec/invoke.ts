import { getCli, type BuildOptions } from '../../shared/clis.ts'
import { apiModelIdFor } from '../../shared/accounts.ts'
import { cliSettings } from '../../shared/settings.ts'
import { rpcSessionFor } from './rpc/index.ts'
import { parserFor, type CliEvent } from './parsers.ts'
import { runProcess, type ProcessResult } from './process.ts'
import { t } from '../../shared/i18n.ts'
import { AUTO_ANSWER } from '../asks.ts'
import { prepareAuth } from '../accounts.ts'
import { getSettings } from '../settings.ts'
import { mcpConfig } from '../../shared/cli-spec.ts'
import { applyConfigFiles, merge, openAskBridge, type Ask } from '../ask-mcp.ts'
import { supportedEffort } from '../models.ts'
import { log } from '../log.ts'

/** 交给没有提问通道的 CLI 的一句用法说明 */
const ASK_HINT = '（需要向用户提问时，用工具 ask_user，不要把问题写成普通文字。）'
/** 没有插话协议的 CLI：用户可能中途补充要求，让它自己多次取 */
const NOTES_HINT =
  '（重要：开始动手前先调用 read_user_notes；之后每完成 2~3 个工具调用、以及准备执行耗时操作前再调用一次。' +
  '用户可能在你执行中补充要求：相关的按它调整方向继续当前任务，无关的先做完手上的事再处理，不要从头重做。）'
/** 对话页开着时：回复完停在进程里等下一句，不用结束进程再 --resume */
const WAIT_HINT =
  '（每轮回复完成后调用 wait_user_message 等用户的下一条消息：返回用户消息时接着处理，返回「用户已经离开了这个对话」时结束本轮。没有新要求时不要自己开始别的工作。）'

/** 执行中控制 CLI：插话（把要求交给正在跑的这一轮）、中断（让 CLI 自己停下这一轮，会话保存完整） */
export interface CliControl {
  steer: (text: string) => Promise<boolean>
  interrupt: () => boolean
  /** 插话要等 CLI 的下一个模型请求才取走（Command Code）：确认接受不等于已经读到 */
  deferSteer?: boolean
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
   * 这一轮里模型可以用面板的工具 read_user_notes 取走
   */
  readNotes?: () => string[]
  /**
   * 对话页还开着时：回复完让模型停在 wait_user_message 上等用户下一句，
   * 用户发消息时由面板直接交回这个进程（不用结束再 --resume）；用户离开时返回空
   */
  waitUser?: () => Promise<string | null>
  /**
   * 面板保活：这一轮结束后先不关进程，用户的下一条消息在同一进程里开下一轮（不用重启 CLI 再 --resume）。
   * 对话页还开着、用户还在这个对话里时返回 true；用户离开后返回 null，进程正常退出
   */
  keepAlive?: () => Promise<string | null>
  /** 模型这一轮已经调过 wait_user_message 等过下一句：结束时不用再保活一次 */
  waited?: () => boolean
  /** 随这一轮一起给模型看的图片（本机路径）：Codex 用 localImage，Claude Code 把图片放进消息里 */
  images?: string[]
  /** 这一轮额外交给 CLI 的面板工具（例如工作流的编排工具）；CLI 定义里没写怎么接 MCP 时忽略 */
  mcp?: { name: string; url: string }[]
}): Promise<ProcessResult> {
  const def = getCli(o.cliId)!
  // 旧设置里的模型可能没带 API 的 provider 前缀（例如 deepseek/...），执行前按当前 API 归一化
  const cs = cliSettings(await getSettings(), o.cliId)
  const model = apiModelIdFor(o.build.model ?? '', def.auth, cs.api)
  const req = model === o.build.model ? o.build : { ...o.build, model }
  // 模型不认的思考强度会让 CLI 启动即报错退出（退出码 1），整个任务白跑：按读到的模型能力挡一下，这一轮不传
  const effort = await supportedEffort(o.cliId, model, req.effort)
  if (effort !== (req.effort ?? ''))
    log.info('agent', `模型 ${model} 不支持 ${req.effort}，这次不带思考强度`, { cli: o.cliId })
  const build = effort === req.effort ? req : { ...req, effort }
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
  // 常驻 RPC 有真正的插话通道（turn/steer、Pi 的 steer），补充不用再靠 MCP 工具拉取；
  // 「等下一句」现在由面板在自己这一轮结束时保活（见 keepAlive），工具留着给模型主动等的场景：
  // 模型在回复里调用它时，这一轮不结束、把进程留住，用户下一句交回同一个进程
  const nativeAsk = def.rpc?.nativeAsk
  const notes = def.notes && !def.steer ? o.readNotes : undefined
  const wait = def.notes && !nativeAsk ? o.waitUser : undefined
  if (def.mcp && (askable || notes || wait) && !nativeAsk) {
    // 用户开着「提问」时把问题交给页面；关着时让模型自己选最合适的做法
    const ask: Ask = (ev) => (o.askUser?.() ? (o.onAsk ? o.onAsk(ev) : o.onEvent(ev)) : ev.reply(AUTO_ANSWER))
    bridge = openAskBridge({
      ...(askable ? { ask } : {}),
      ...(notes ? { notes } : {}),
      ...(wait ? { wait } : {}),
    })
    servers.unshift({ name: 'panel', url: bridge.url })
    // 用户开着「提问」时告诉模型有这个工具，免得它把问题写成普通文字
    if (askable && o.askUser?.()) input = `${input}\n\n${ASK_HINT}`
    // 没有插话协议的 CLI：补充登记给它，让模型中途自己取
    if (notes) input = `${input}\n\n${NOTES_HINT}`
    // 对话页开着：回复完停在等下一句的工具上
    if (wait) input = `${input}\n\n${WAIT_HINT}`
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

  const parse = parserFor(o.cliId, o.cwd)

  if (def.protocol === 'rpc') {
    // 所有常驻协议走同一个会话引擎：握手、请求/回复配对、超时、插话、中断、收尾都一样，
    // 各家发什么、怎么判断结束由定义里的 rpc 配置或 codex / claude 适配器决定
    const session = rpcSessionFor(def, {
      cwd: o.cwd,
      input: o.input,
      images: o.images,
      build: o.build,
      onEvent: emit,
      // 对话页还开着、用户也没点停止：一轮结束后留住进程，下一条消息在同一进程里开下一轮
      hold: () => !!o.keepAlive && !signal.aborted && !o.signal?.aborted,
      next: () =>
        signal.aborted || o.signal?.aborted ? Promise.resolve(null) : (o.keepAlive?.() ?? Promise.resolve(null)),
      waited: o.waited,
    })
    setControl({
      steer: (text) => session.steer(text),
      interrupt: () => session.interrupt(),
      deferSteer: def.rpc?.deferSteer,
    })
    // 面板保活：一轮结束后不关进程，用户的下一条消息在同一进程里开下一轮。
    // 只在适配器支持时启用；不支持的一轮一个进程
    try {
      const r = await runProcess({
        command: o.command,
        args,
        cwd: o.cwd,
        env: o.env,
        signal,
        timeoutMs: o.timeoutMs,
        // 保活期间在等用户下一句，不算卡住
        idle: o.idle && o.keepAlive ? { ...o.idle, busy: () => session.waiting || !!o.idle?.busy?.() } : o.idle,
        onSpawn: (io) =>
          session.start({
            write: (s) => io.write(s),
            end: () => io.end(),
          }),
        onLine: (line) => session.line(line),
      })
      // 没等到这一轮结束就退出了（崩溃、配置错误），算失败
      if (!session.finished && !r.killed && !r.spawnError)
        o.onEvent({ type: 'result', ok: false, error: t('{cli} 没有完成这一轮就退出了', { cli: def.name }) })
      return r
    } finally {
      session.close()
    }
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
