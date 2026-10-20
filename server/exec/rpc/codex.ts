import path from 'node:path'
import type { BuildOptions } from '../../../shared/clis.ts'
import { t } from '../../../shared/i18n.ts'
import { clipDetail, codexLimits, codexUsage, oneLine, toolText, type CliEvent } from '../parsers.ts'
import { createRpcSession, type RpcSession } from './session.ts'
import type { RpcAdapter, RpcContext } from './types.ts'

const START_TIMEOUT_MS = 60_000

/**
 * Codex 用 `codex app-server`（stdin / stdout 上的 JSON-RPC）执行。
 * 流程：initialize → thread/start（续接时 thread/resume，分叉时 thread/fork）→ turn/start
 * （压缩时 thread/compact/start，审查时 review/start）→ 收通知直到 turn/completed。
 * 执行中可以插话（turn/steer）和中断（turn/interrupt）。
 */
export function codexAdapter(
  o: BuildOptions & { cwd: string; input: string; images?: string[]; platform?: string },
): RpcAdapter {
  let thread = ''
  let turnId = ''
  let startedCmds = new Set<string>()
  const review = o.op?.kind === 'review'
  // 回复和推理摘要是否已经流式输出过：输出过的在 item/completed 时不再重复整段
  const streamed = new Set<string>()
  let textSeen = false
  let thinkingSeen = false
  // 用量按累计值做差，重复推送不会算两遍
  let prevTotal: Record<string, number> | undefined
  const sandbox = o.permission === 'danger-full-access' ? 'danger-full-access' : o.permission || 'workspace-write'
  const overrides = {
    cwd: o.cwd,
    model: o.model || undefined,
    // 需要越过沙箱时由 Codex 发来审批请求，任务页上弹出让用户确认；完全访问时不会有审批
    approvalPolicy: sandbox === 'danger-full-access' ? 'never' : 'on-request',
    sandbox,
    developerInstructions: o.systemPrompt || undefined,
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
      // 续接失败多半是会话被清理了；带上 thread not found 让上层丢掉旧会话重来
      ctx.emit({
        type: 'error',
        message: o.resume ? t('无法续接之前的会话（thread not found）：{error}', { error: msg }) : msg,
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
      const turn = await ctx.request({
        method: 'turn/start',
        params: {
          threadId: thread,
          input: [
            { type: 'text', text: o.input, text_elements: [] },
            // 附上的图片（参考图、截图）直接给模型看
            ...(o.images ?? []).map((p) => ({ type: 'localImage', path: p })),
          ],
          effort: o.effort || undefined,
        },
      })
      if (turn?.error) {
        ctx.finish(false, String(turn.error.message))
        return
      }
      if (turn?.result?.turn?.id) {
        turnId = turn.result.turn.id
        ctx.emit({ type: 'turn', id: turnId })
      }
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
        reply: (r) => answer({ decision: legacy ? (r.allow ? 'approved' : 'denied') : r.allow ? 'accept' : 'decline' }),
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
        reply: (r) => answer({ decision: legacy ? (r.allow ? 'approved' : 'denied') : r.allow ? 'accept' : 'decline' }),
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
        reply: (r) => answer(r.allow ? { permissions: want, scope: 'turn' } : { permissions: {} }),
      })
      return
    }
    ctx.send({ id: m.id, error: { code: -32601, message: `面板不支持 ${m.method}` } })
  }

  const onItem = (item: any): CliEvent[] => {
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
        return !streamed.has(item.id) && text ? [{ type: 'thinking', text: sep('thinking') + text, delta: true }] : []
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

  const onNotification = (ctx: RpcContext, m: any) => {
    const p = m.params ?? {}
    switch (m.method) {
      case 'windowsSandbox/setupCompleted':
        if (thread || ctx.finished) return
        if (p.success === false) return sandboxFailed(ctx, String(p.error ?? t('未知错误')))
        void startThread(ctx)
        return
      case 'item/started':
        // 新的一段回复开始，之前的段落要和它分开
        if (p.item?.type === 'agentMessage' && textSeen && !review) ctx.emit({ type: 'text_delta', text: '\n\n' })
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
        const first = !streamed.has(p.itemId)
        streamed.add(p.itemId)
        ctx.emit({ type: 'thinking', text: (first ? sep('thinking') : '') + p.delta, delta: true })
        return
      }
      case 'item/reasoning/summaryPartAdded':
        if (streamed.has(p.itemId)) ctx.emit({ type: 'thinking', text: '\n\n', delta: true })
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
      case 'error':
        // 会自动重试的错误不算失败
        if (!p.willRetry) ctx.emit({ type: 'error', message: String(p.error?.message ?? t('执行出错')) })
        return
      case 'turn/completed': {
        const turn = p.turn ?? {}
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
      if (init?.error) return ctx.finish(false, String(init.error.message))
      ctx.send({ method: 'initialized' })
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
          if (setup?.error) return sandboxFailed(ctx, String(setup.error.message ?? t('未知错误')))
          if (setup?.result?.started === false) await startThread(ctx)
          return
        }
      }
      await startThread(ctx)
    },
    message: onNotification,
    request: onRequest,
    async steer(ctx, text) {
      if (ctx.finished || !thread || !turnId || review || o.op) return false
      const r = await ctx.request({
        method: 'turn/steer',
        params: { threadId: thread, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId: turnId },
      })
      return !r?.error
    },
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

/**
 * 去掉外面包的一层 shell，只留真正的命令：bash -lc '…'、Windows 上的 "…\\cmd.exe" /c "…"、
 * "…\\powershell.exe" -Command '…'（可能套好几层）
 */
export function unwrapShell(cmd: unknown) {
  let s = (Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '')).trim()
  const shells = [
    /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/,
    /^"?(?:[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+\/[cCkK]\s+([\s\S]+)$/i,
    /^"?(?:[^"\s]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-(?:NoProfile|NonInteractive|NoLogo|ExecutionPolicy\s+\S+))*\s+-(?:Command|c)\s+([\s\S]+)$/i,
  ]
  for (let i = 0; i < 5; i++) {
    const m = shells.map((r) => s.match(r)).find(Boolean)
    if (!m) break
    s = m[1].trim()
    // 去掉整体包着的一层引号
    if (s.length > 1 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0])) s = s.slice(1, -1)
  }
  // 命令里的路径在 JSON 里转义成了 \\，显示时还原
  return s.replace(/\\\\/g, '\\')
}

function rel(cwd: string, p: unknown) {
  if (typeof p !== 'string' || !p) return ''
  const r = path.isAbsolute(p) ? path.relative(cwd, p) : p
  return (r.startsWith('..') ? p : r).replaceAll('\\', '/')
}
