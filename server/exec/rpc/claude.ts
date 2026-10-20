import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { t } from '../../../shared/i18n.ts'
import { clipDetail, oneLine, type CliEvent, type Parser } from '../parsers.ts'
import type { RpcAdapter, RpcContext } from './types.ts'

/**
 * Claude Code 的控制协议：任务描述是 stdin 上的一条 user 消息，审批请求是 control_request（can_use_tool），
 * 回 control_response；执行中插话是再写一条 user 消息（priority next），中断是 control_request（interrupt）。
 */
export function claudeAdapter(o: { cwd: string; input: string; images?: string[]; parse: Parser }): RpcAdapter {
  let steered = false
  const respond = (ctx: RpcContext, requestId: string, response: object) =>
    ctx.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })

  return {
    start(ctx) {
      ctx.send({ type: 'user', message: { role: 'user', content: withImages(o.input, o.images) } })
    },
    message(ctx, m) {
      // 审批的回答不需要面板再处理
      if (m.type === 'control_response') return
      // 插过话：这一轮结束后 CLI 可能接着处理插进来的要求，有新输出就先不关
      ctx.hold()
      for (const ev of o.parse(m)) {
        // 结果由 finish 统一发，避免和解析出来的一条重复
        if (ev.type === 'result') ctx.finish(ev.ok, ev.error, steered ? 2500 : 0)
        else ctx.emit(ev)
      }
    },
    request(ctx, m) {
      if (m.request?.subtype !== 'can_use_tool')
        return ctx.send({
          type: 'control_response',
          response: { subtype: 'error', request_id: m.request_id, error: '面板不支持这个请求' },
        })
      const name = String(m.request.tool_name ?? '')
      const input = m.request.input ?? {}
      ctx.emit({
        type: 'ask',
        ...claudeAsk(name, input),
        reply: (r) =>
          respond(
            ctx,
            m.request_id,
            r.allow
              ? { behavior: 'allow', updatedInput: claudeAnswer(name, input, r.answer, r.answers) }
              : {
                  behavior: 'deny',
                  message: r.message ?? (r.answer ? `用户拒绝了：${r.answer}` : '用户拒绝了这个操作'),
                },
          ),
      })
    },
    async steer(ctx, text) {
      steered = true
      ctx.send({ type: 'user', message: { role: 'user', content: text }, priority: 'next', parent_tool_use_id: null })
      return true
    },
    interrupt(ctx) {
      ctx.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
      return true
    },
    isRequest: (m) => m?.type === 'control_request',
  }
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
