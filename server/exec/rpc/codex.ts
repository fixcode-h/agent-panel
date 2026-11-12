import { commandRule, fileRule } from '../../../shared/allow-rules.ts'
import path from 'node:path'
import type { BuildOptions } from '../../../shared/clis.ts'
import { t } from '../../../shared/i18n.ts'
import { HOOK_SCRIPT_ENV, HOOK_URL_ENV } from '../../../shared/hooks.ts'
import { clipDetail, codexLimits, codexUsage, oneLine, toolText, type AskReply, type CliEvent } from '../parsers.ts'
import { createRpcSession, type RpcSession } from './session.ts'
import type { RpcAdapter, RpcContext } from './types.ts'
import { unwrapShell } from '../../../shared/shell-command.ts'

const START_TIMEOUT_MS = 60_000

/**
 * 模型又在出内容了（新条目开始、回复或推理的 delta）：之前的自动重试算成功。
 * 不看 item/completed 和命令输出：Codex 边读流边执行工具，出错前就在跑的命令会在重试期间继续输出、结束，
 * 说明不了模型请求接上了
 */
// 模块状态：常量，加载后不改
const PROGRESS = new Set([
  'item/started',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
])

/**
 * thread/resume 的报错像「会话没了」：Codex 原文是「no rollout found for thread id …」或「thread not found: …」。
 * 只看第一行：面板自己的超时报错后面附着 stderr，里面的 not found 和会话无关
 */
const THREAD_GONE = /no rollout found|\b(?:thread|session|rollout)\b[^\n]{0,40}\b(?:not found|does not exist)\b/i

/**
 * 信任面板自己的钩子（ADR 0049 第三期）：Codex 的钩子要用户信任过（按命令内容算的哈希记在 ~/.codex/config.toml 的
 * hooks.state 里）才会跑，-c 传进去的也一样，没信任的静静地不跑。开始前查一遍这一轮的钩子，只把来自参数（sessionFlags）、
 * 命令里引用了转发脚本环境变量的那几条记成信任：用户自己配的、项目里的钩子一条都不碰。
 * 命令每轮相同（路径走环境变量），哈希不变，信任过一次以后这里只是查一下；记的键按事件和序号固定，不会越积越多。
 * 没信任成（旧版本没有这些接口、写配置失败）时照常执行：这一轮的钩子不生效，面板一轮结束后的提醒照样兜底，但要告诉用户
 */
async function trustPanelHooks(ctx: RpcContext, cwd: string) {
  const list = await ctx.request({ method: 'hooks/list', params: { cwds: [cwd] } }, { timeoutMs: START_TIMEOUT_MS })
  const hooks: any[] = (list?.result?.data ?? []).flatMap((d: any) => d.hooks ?? [])
  const mine = hooks.filter(
    (h) =>
      h.source === 'sessionFlags' &&
      h.trustStatus !== 'trusted' &&
      typeof h.key === 'string' &&
      typeof h.currentHash === 'string' &&
      // 面板自己的钩子：命令引用转发脚本（node）或面板地址（curl）的环境变量
      [HOOK_SCRIPT_ENV, HOOK_URL_ENV].some((k) => String(h.command ?? '').includes(k)),
  )
  const err = list?.error?.message
  if (!err && !mine.length) return
  const w = err
    ? undefined
    : await ctx.request(
        {
          method: 'config/batchWrite',
          params: {
            edits: mine.map((h) => ({
              keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`,
              mergeStrategy: 'upsert',
              value: h.currentHash,
            })),
            reloadUserConfig: true,
          },
        },
        { timeoutMs: START_TIMEOUT_MS },
      )
  const fail = err ?? w?.error?.message
  if (fail)
    ctx.emit({
      type: 'notice',
      text: t('面板的钩子没能在 Codex 里生效（{error}），这一轮改用一轮结束后的提醒', { error: String(fail) }),
      failed: true,
    })
}

/**
 * Codex 用 `codex app-server`（stdin / stdout 上的 JSON-RPC）执行。
 * 流程：initialize → thread/start（续接时 thread/resume，分叉时 thread/fork）→ turn/start
 * （压缩时 thread/compact/start，审查时 review/start）→ 收通知直到 turn/completed。
 * 执行中可以插话（turn/steer）和中断（turn/interrupt）。
 */
export function codexAdapter(
  o: BuildOptions & { cwd: string; input: string; images?: string[]; platform?: string; trustHooks?: boolean },
): RpcAdapter {
  let thread = ''
  let turnId = ''
  let startedCmds = new Set<string>()
  // 每个条目开始的时刻：完成时才发的条目（改文件、MCP、搜索）用它算耗时
  const itemStart = new Map<string, number>()
  const review = o.op?.kind === 'review'
  // 回复（streamed）和推理摘要（thought）是否已经流式输出过：输出过的在 item/completed 时不再重复整段。
  // 两边分开记：有的网关把推理 delta 记在回复条目的 id 下，混在一起会把没流式输出过的回复正文当成输出过而丢掉
  const streamed = new Set<string>()
  const thought = new Set<string>()
  // 已经开始的回复条目：有的网关（deepseek 中转）同一条回复会发两次 item/started，第二次不能再空一段
  const startedMsgs = new Set<string>()
  // 还没完成的推理条目：有的网关把推理 delta 记在回复条目的 id 下，推理条目完成时按这里认出已经流式输出过
  const openReasoning = new Set<string>()
  let textSeen = false
  let thinkingSeen = false
  // 用量按累计值做差，重复推送不会算两遍
  let prevTotal: Record<string, number> | undefined
  // Codex 自己在重试（error 通知带 willRetry）：第几次。之后模型又出内容就算重试成功，发 retry_ok 把「正在重试」收掉
  let retrying = 0
  const sandbox = o.permission === 'danger-full-access' ? 'danger-full-access' : o.permission || 'workspace-write'
  const overrides = {
    cwd: o.cwd,
    model: o.model || undefined,
    // 需要越过沙箱时由 Codex 发来审批请求，任务页上弹出让用户确认；完全访问时不会有审批
    approvalPolicy: sandbox === 'danger-full-access' ? 'never' : 'on-request',
    sandbox,
    developerInstructions: o.systemPrompt || undefined,
  }

  /** 在已经开好的 thread 里开始一轮；下一轮（保活）也走这里，只换文字 */
  const startTurn = async (ctx: RpcContext, text: string, images: string[] = []) => {
    const turn = await ctx.request({
      method: 'turn/start',
      params: {
        threadId: thread,
        input: [
          { type: 'text', text, text_elements: [] },
          // 附上的图片（参考图、截图）直接给模型看
          ...images.map((p) => ({ type: 'localImage', path: p })),
        ],
        effort: o.effort || undefined,
      },
    })
    if (turn?.error) {
      ctx.finish(false, String(turn.error.message))
      return false
    }
    if (turn?.result?.turn?.id) {
      turnId = turn.result.turn.id
      ctx.emit({ type: 'turn', id: turnId })
    }
    return true
  }

  const startThread = async (ctx: RpcContext) => {
    const [method, params] =
      o.resume && o.fork
        ? ['thread/fork', { threadId: o.resume, lastTurnId: o.fork.turnId || undefined, ...overrides }]
        : o.resume
          ? ['thread/resume', { threadId: o.resume, ...overrides }]
          : ['thread/start', overrides]
    const r = await ctx.request({ method, params }, { timeoutMs: START_TIMEOUT_MS })
    if (r?.error) {
      const msg = String(r.error.message ?? t('启动会话失败'))
      // 报错像「会话被清理了」时带上 thread not found，让上层丢掉旧会话重来。
      // 别的失败（thread/resume 超时、进程崩了）不能包：那是环境问题，丢掉会话只会让对话白白重开
      const gone = o.resume && THREAD_GONE.test(msg.split('\n')[0])
      ctx.emit({
        type: 'error',
        message: gone ? t('无法续接之前的会话（thread not found）：{error}', { error: msg }) : msg,
      })
      ctx.finish(false)
      return
    }
    thread = r?.result?.thread?.id ?? o.resume ?? ''
    if (thread) ctx.emit({ type: 'session', id: thread })
    if (o.op?.kind === 'compact') {
      const c = await ctx.request({ method: 'thread/compact/start', params: { threadId: thread } })
      if (c?.error) ctx.finish(false, String(c.error.message))
    } else if (review) {
      const rv = await ctx.request({
        method: 'review/start',
        params: { threadId: thread, target: reviewTarget(), delivery: 'inline' },
      })
      if (rv?.error) ctx.finish(false, String(rv.error.message))
    } else {
      await startTurn(ctx, o.input, o.images ?? [])
    }
  }

  const reviewTarget = () => {
    const tg = o.op?.kind === 'review' ? o.op.target : { type: 'uncommitted' as const }
    if (tg.type === 'base') return { type: 'baseBranch', branch: tg.branch }
    if (tg.type === 'custom') return { type: 'custom', instructions: tg.instructions }
    return { type: 'uncommittedChanges' }
  }
  // Windows 上沙箱要先初始化一次（Codex 自己的界面会弹提示），没初始化时每条命令都报 helper_unknown_error
  const needsWinSandbox = (o.platform ?? process.platform) === 'win32' && sandbox !== 'danger-full-access'
  const sandboxFailed = (ctx: RpcContext, why: string) => {
    ctx.emit({
      type: 'error',
      message: t(
        'Codex 的 Windows 沙箱初始化失败（{reason}），命令和改文件都无法执行。可以在终端里运行一次 codex 按提示完成沙箱设置，或在设置里把 Codex 的权限改成「完全访问」。',
        { reason: why },
      ),
    })
    ctx.finish(false)
  }

  const steerTurn = async (ctx: RpcContext, text: string) => {
    if (ctx.finished || !thread || !turnId || review || o.op) return false
    const r = await ctx.request({
      method: 'turn/steer',
      params: { threadId: thread, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId: turnId },
    })
    return !r?.error
  }
  /**
   * 审批的回答只有 decline，带不了原话：用户拒绝后的提醒（别原样重试、被拒多次停下来问，见 deny-advice.ts）
   * 先回 decline，再插话交给还在跑的这一轮，模型下一次请求就能看到。这一轮已经结束时 turn/steer 会被拒，不开新的一轮
   */
  const decided = (ctx: RpcContext, r: AskReply, send: () => void) => {
    send()
    if (!r.allow && r.advice) void steerTurn(ctx, r.advice).catch(() => false)
  }

  const onRequest = (ctx: RpcContext, m: any) => {
    const p = m.params ?? {}
    const answer = (result: unknown) => ctx.send({ id: m.id, result })
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'execCommandApproval') {
      const legacy = m.method === 'execCommandApproval'
      const cmd = unwrapShell(p.command ?? '')
      ctx.emit({
        type: 'ask',
        kind: 'command',
        title: cmd ? t('运行命令：{cmd}', { cmd: oneLine(cmd) }) : t('运行一条需要越过沙箱的命令'),
        detail: [p.reason, cmd && clipDetail(cmd), p.cwd && t('目录：{dir}', { dir: p.cwd })]
          .filter(Boolean)
          .join('\n\n'),
        rule: commandRule(cmd),
        reply: (r) =>
          decided(ctx, r, () =>
            answer({ decision: legacy ? (r.allow ? 'approved' : 'denied') : r.allow ? 'accept' : 'decline' }),
          ),
      })
      return
    }
    if (m.method === 'item/fileChange/requestApproval' || m.method === 'applyPatchApproval') {
      const legacy = m.method === 'applyPatchApproval'
      ctx.emit({
        type: 'ask',
        kind: 'file',
        title: p.grantRoot ? t('允许写入目录：{dir}', { dir: p.grantRoot }) : t('修改沙箱以外的文件'),
        detail: String(p.reason ?? ''),
        // 只有「允许写入某个目录」能一直允许（按那个目录）；没说目录的沙箱外修改每次都问
        rule: p.grantRoot ? fileRule(`${String(p.grantRoot).replace(/[\\/]+$/, '')}/`) : undefined,
        reply: (r) =>
          decided(ctx, r, () =>
            answer({ decision: legacy ? (r.allow ? 'approved' : 'denied') : r.allow ? 'accept' : 'decline' }),
          ),
      })
      return
    }
    // 沙箱里要额外的权限（联网、写沙箱外的目录）：同意就按请求的范围给这一轮，拒绝就一项都不给
    if (m.method === 'item/permissions/requestApproval') {
      const want = p.permissions ?? {}
      const fsPaths = [...(want.fileSystem?.write ?? []), ...(want.fileSystem?.read ?? [])].map(String)
      const what = [
        want.network?.enabled && t('联网'),
        fsPaths.length && t('访问 {paths}', { paths: fsPaths.join(t('、')) }),
      ].filter(Boolean)
      ctx.emit({
        type: 'ask',
        kind: 'command',
        title: t('需要额外权限：{what}', { what: what.join(t('，')) || t('越过沙箱') }),
        detail: String(p.reason ?? ''),
        reply: (r) =>
          decided(ctx, r, () => answer(r.allow ? { permissions: want, scope: 'turn' } : { permissions: {} })),
      })
      return
    }
    ctx.send({ id: m.id, error: { code: -32601, message: `面板不支持 ${m.method}` } })
  }

  const onItem = (item: any): CliEvent[] => {
    const evs = itemEvents(item)
    // 耗时：Codex 报了 durationMs 就用它，否则按 item/started 到 item/completed 算
    const t0 = item?.id ? itemStart.get(item.id) : undefined
    if (item?.id) itemStart.delete(item.id)
    const ms = typeof item?.durationMs === 'number' ? item.durationMs : t0 !== undefined ? Date.now() - t0 : undefined
    if (ms === undefined) return evs
    return evs.map((ev) =>
      ev.type === 'tool' && ev.tool.ms === undefined
        ? { ...ev, tool: { ...ev.tool, ms } }
        : ev.type === 'thinking'
          ? { ...ev, ms }
          : ev,
    )
  }

  const itemEvents = (item: any): CliEvent[] => {
    switch (item?.type) {
      case 'agentMessage':
        // 审查时审查员的原始输出不显示，结果在 exitedReviewMode 里
        if (review) return []
        return !streamed.has(item.id) && item.text ? [{ type: 'text', text: item.text }] : []
      case 'exitedReviewMode':
        return item.review ? [{ type: 'text', text: String(item.review) }] : []
      case 'contextCompaction':
        return [{ type: 'compacted' }]
      case 'reasoning': {
        const parts: string[] = item.summary?.length ? item.summary : (item.content ?? [])
        const text = parts.join('\n\n')
        openReasoning.delete(item.id)
        return !thought.has(item.id) && text ? [{ type: 'thinking', text: sep('thinking') + text, delta: true }] : []
      }
      case 'commandExecution': {
        const code = item.exitCode
        const cmd = unwrapShell(item.command)
        const failed = item.status === 'failed' || item.status === 'declined' || (code !== null && code !== 0)
        const detail = item.status === 'declined' ? t('被拒绝') : code ? t('退出码 {code}', { code }) : ''
        if (startedCmds.has(item.id))
          return [
            {
              type: 'tool_result',
              id: item.id,
              output: item.aggregatedOutput ? clipDetail(String(item.aggregatedOutput)) : '',
              failed: failed || undefined,
              detail,
            },
          ]
        return [
          {
            type: 'tool',
            tool: {
              kind: 'run',
              label: oneLine(cmd),
              detail,
              input: clipDetail(cmd),
              output: item.aggregatedOutput ? clipDetail(String(item.aggregatedOutput)) : undefined,
              failed: failed || undefined,
            },
          },
        ]
      }
      case 'fileChange':
        return (item.changes ?? []).map((c: any): CliEvent => {
          const p = rel(o.cwd, c.path)
          const { add, del } = diffStat(c.diff)
          const kind = { add: t('新建'), delete: t('删除'), update: t('修改') }[c.kind?.type as string] ?? ''
          return {
            type: 'tool',
            tool: {
              kind: 'edit',
              name: c.kind?.type === 'add' ? t('写入') : c.kind?.type === 'delete' ? t('删除') : undefined,
              label: p,
              detail: add || del ? `+${add} -${del}` : kind,
              input: c.diff ? clipDetail(String(c.diff)) : undefined,
              failed: item.status === 'failed' || item.status === 'declined' || undefined,
            },
            file: { path: p, add, del },
          }
        })
      case 'mcpToolCall':
        return [
          {
            type: 'tool',
            tool: {
              kind: 'other',
              name: 'MCP',
              label: `${item.server ?? 'mcp'} · ${item.tool ?? ''}`,
              detail: item.error ? t('失败') : '',
              input: item.arguments ? clipDetail(JSON.stringify(item.arguments, null, 2)) : undefined,
              output: item.error
                ? clipDetail(toolText(item.error.message ?? item.error))
                : item.result
                  ? clipDetail(toolText(item.result.content ?? item.result))
                  : undefined,
              failed: !!item.error || undefined,
            },
          },
        ]
      case 'dynamicToolCall':
        return [
          {
            type: 'tool',
            tool: {
              kind: 'other',
              name: String(item.tool ?? t('工具')),
              label: '',
              detail: '',
              input: item.arguments ? clipDetail(JSON.stringify(item.arguments, null, 2)) : undefined,
              output: item.contentItems ? clipDetail(toolText(item.contentItems)) : undefined,
              failed: item.success === false || undefined,
            },
          },
        ]
      case 'webSearch':
        return [
          { type: 'tool', tool: { kind: 'web', name: t('网页搜索'), label: String(item.query ?? ''), detail: '' } },
        ]
      case 'imageGeneration': {
        const failed =
          item.status === 'failed' || item.failure
            ? String(item.failure?.message ?? item.failure?.reason ?? item.failure ?? t('生成失败'))
            : undefined
        return [
          {
            type: 'tool',
            tool: {
              kind: 'other',
              name: t('生成图片'),
              label: oneLine(String(item.revisedPrompt ?? '')),
              detail: failed ? t('失败') : '',
              output: failed,
              failed: !!failed || undefined,
            },
          },
          failed
            ? { type: 'image', failed }
            : { type: 'image', path: item.savedPath || undefined, data: item.result || undefined },
        ]
      }
      case 'imageView':
        return [{ type: 'tool', tool: { kind: 'read', name: t('查看图片'), label: rel(o.cwd, item.path), detail: '' } }]
      default:
        return []
    }
  }

  // 同一轮里第二段回复 / 推理和前一段之间空一行
  const sep = (kind: 'text' | 'thinking') => {
    if (kind === 'text') {
      const s = textSeen ? '\n\n' : ''
      textSeen = true
      return s
    }
    const s = thinkingSeen ? '\n\n' : ''
    thinkingSeen = true
    return s
  }

  /** 重试接上了：发 retry_ok，runner 把这一轮的「正在重试」收成已恢复 */
  const retried = (ctx: RpcContext) => {
    ctx.emit({ type: 'retry_ok', text: t('第 {n} 次重试成功了，接着做。', { n: retrying }), attempt: retrying })
    retrying = 0
  }

  const onNotification = (ctx: RpcContext, m: any) => {
    const p = m.params ?? {}
    // Codex 没有「重试成功」的通知：重试后模型又出内容了，就是这次请求接上了
    if (retrying && PROGRESS.has(m.method)) retried(ctx)
    switch (m.method) {
      case 'windowsSandbox/setupCompleted':
        if (thread || ctx.finished) return
        if (p.success === false) return sandboxFailed(ctx, String(p.error ?? t('未知错误')))
        void startThread(ctx)
        return
      case 'item/started':
        if (p.item?.id) itemStart.set(p.item.id, Date.now())
        if (p.item?.type === 'reasoning' && p.item.id) openReasoning.add(p.item.id)
        // 新的一段回复开始，之前的段落要和它分开；同一条回复重复的 item/started 不算新段落
        if (p.item?.type === 'agentMessage' && !startedMsgs.has(p.item.id)) {
          if (p.item.id) startedMsgs.add(p.item.id)
          if (textSeen && !review) ctx.emit({ type: 'text_delta', text: '\n\n' })
        }
        if (p.item?.type === 'commandExecution' && p.item.id) {
          startedCmds.add(p.item.id)
          const cmd = unwrapShell(p.item.command)
          ctx.emit({
            type: 'tool',
            id: p.item.id,
            tool: { kind: 'run', label: oneLine(cmd), detail: '', input: clipDetail(cmd), running: true },
          })
        }
        return
      case 'item/commandExecution/outputDelta':
        if (p.itemId && p.delta) ctx.emit({ type: 'tool_delta', id: p.itemId, text: String(p.delta) })
        return
      case 'turn/diff/updated':
        ctx.emit({ type: 'files_changed' })
        return
      case 'account/rateLimits/updated': {
        const l = codexLimits(p.rateLimits)
        if (l) ctx.emit({ type: 'limits', limits: l })
        return
      }
      case 'thread/compacted':
        ctx.emit({ type: 'compacted' })
        return
      case 'turn/started':
        if (!p.turn?.id || p.turn.id === turnId) return
        turnId = p.turn.id
        ctx.emit({ type: 'turn', id: turnId })
        return
      case 'item/agentMessage/delta':
        if (!p.delta || review) return
        streamed.add(p.itemId)
        textSeen = true
        ctx.emit({ type: 'text_delta', text: p.delta })
        return
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        if (!p.delta) return
        const first = !thought.has(p.itemId)
        thought.add(p.itemId)
        // delta 记在别的 id 下（网关把推理挂在回复条目上）：正开着的推理条目也算输出过，完成时不再整段重发一遍
        if (!openReasoning.has(p.itemId)) for (const id of openReasoning) thought.add(id)
        ctx.emit({ type: 'thinking', text: (first ? sep('thinking') : '') + p.delta, delta: true })
        return
      }
      case 'item/reasoning/summaryPartAdded':
        if (thought.has(p.itemId)) ctx.emit({ type: 'thinking', text: '\n\n', delta: true })
        return
      case 'item/completed':
        for (const ev of onItem(p.item)) ctx.emit(ev)
        return
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage
        if (!u?.total) return
        const base = prevTotal ?? minus(u.total, u.last ?? {})
        prevTotal = u.total
        ctx.emit(codexUsage(minus(u.total, base), u.last ?? u.total, u.modelContextWindow))
        return
      }
      case 'turn/plan/updated':
        ctx.emit({
          type: 'todos',
          todos: (p.plan ?? []).map((s: any) => ({
            text: String(s.step ?? ''),
            status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'running' : 'pending',
          })),
        })
        return
      case 'model/rerouted':
        if (p.toModel) ctx.emit({ type: 'usage', model: String(p.toModel) })
        return
      case 'error': {
        const msg = String(p.error?.message ?? t('执行出错'))
        if (!p.willRetry) {
          ctx.emit({ type: 'error', message: msg })
          return
        }
        // 会自动重试的错误不算失败，但要让用户看到（不悄悄重试）：画成「正在重试」，接上后收成已恢复。
        // 断流重连时 message 是「Reconnecting... 2/5」，真正的原因在 additionalDetails
        const why = oneLine(String(p.error?.additionalDetails || msg), 300)
        const nm = /reconnecting\D{0,8}(\d+)\s*\/\s*(\d+)/i.exec(msg)
        retrying = nm ? Number(nm[1]) : retrying + 1
        ctx.emit({
          type: 'notice',
          text: nm
            ? t('模型请求失败，正在自动重试（第 {n}/{max} 次）：{error}', { n: retrying, max: nm[2], error: why })
            : t('模型请求失败，正在自动重试：{error}', { error: why }),
          kind: 'retry',
          attempt: retrying,
          ...(nm ? { maxAttempts: Number(nm[2]) } : {}),
          error: why,
        })
        return
      }
      case 'turn/completed': {
        const turn = p.turn ?? {}
        // 重试后没再出内容就直接成功结束了（比如重试的正好是最后一次请求）：同样算接上了
        if (turn.status === 'completed' && retrying) retried(ctx)
        if (turn.status === 'completed') return ctx.finish(true)
        ctx.finish(false, turn.error?.message ?? (turn.status === 'interrupted' ? t('已中断') : t('执行失败')))
        return
      }
    }
  }

  return {
    async start(ctx) {
      const init = await ctx.request(
        { method: 'initialize', params: { clientInfo: { name: 'agent-panel', version: '1' } } },
        { timeoutMs: START_TIMEOUT_MS },
      )
      if (init?.error) {
        void ctx.finish(false, String(init.error.message))
        return
      }
      ctx.send({ method: 'initialized' })
      if (o.trustHooks) await trustPanelHooks(ctx, o.cwd)
      if (needsWinSandbox) {
        const ready = await ctx.request(
          { method: 'windowsSandbox/readiness', params: {} },
          { timeoutMs: START_TIMEOUT_MS },
        )
        // 旧版本没有这个接口，直接开始
        if (!ready?.error && ready?.result?.status !== 'ready') {
          // 用不需要管理员权限的方式初始化，不会弹出系统授权框；完成后会收到 windowsSandbox/setupCompleted
          const setup = await ctx.request(
            { method: 'windowsSandbox/setupStart', params: { mode: 'unelevated', cwd: o.cwd } },
            { timeoutMs: START_TIMEOUT_MS },
          )
          if (setup?.error) {
            sandboxFailed(ctx, String(setup.error.message ?? t('未知错误')))
            return
          }
          if (setup?.result?.started === false) await startThread(ctx)
          return
        }
      }
      await startThread(ctx)
    },
    message: onNotification,
    request: onRequest,
    async next(ctx, text) {
      // 同一 thread 开下一轮：上一轮的 turn id、工具记录和用量累计（按累计值做差）都不能带过去
      if (!thread) return void ctx.finish(false, t('启动会话失败'))
      turnId = ''
      // 上一轮没收口的重试计数不能串到这一轮：否则这一轮第一条输出会被当成「重试成功」
      retrying = 0
      startedCmds.clear()
      itemStart.clear()
      streamed.clear()
      thought.clear()
      startedMsgs.clear()
      openReasoning.clear()
      textSeen = false
      thinkingSeen = false
      prevTotal = undefined
      await startTurn(ctx, text)
    },
    steer: steerTurn,
    interrupt(ctx) {
      if (ctx.finished || !thread || !turnId) return false
      void ctx.request({ method: 'turn/interrupt', params: { threadId: thread, turnId } })
      return true
    },
  }
}

/** 给测试用的入口：返回和原来一样的 start / handle / steer / interrupt */
export function codexAppSession(
  o: BuildOptions & {
    cwd: string
    input: string
    images?: string[]
    platform?: string
    onEvent?: (e: CliEvent) => void
  },
): RpcSession {
  return createRpcSession({
    adapter: codexAdapter(o),
    cwd: o.cwd,
    input: o.input,
    images: o.images,
    onEvent: (e) => o.onEvent?.(e),
  })
}

const minus = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.max(0, (a[k] ?? 0) - (b[k] ?? 0))]))

/** unified diff 的增删行数（不算 ---/+++ 文件头） */
function diffStat(diff: unknown) {
  let add = 0
  let del = 0
  if (typeof diff !== 'string') return { add, del }
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) add++
    else if (l.startsWith('-')) del++
  }
  return { add, del }
}

// 剥外壳的规则和钩子按命令前缀比共用一份（shared/shell-command.ts），这里照旧导出给测试
export { unwrapShell }

function rel(cwd: string, p: unknown) {
  if (typeof p !== 'string' || !p) return ''
  const r = path.isAbsolute(p) ? path.relative(cwd, p) : p
  return (r.startsWith('..') ? p : r).replaceAll('\\', '/')
}
