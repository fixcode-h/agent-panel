import { Hono, type Context } from 'hono'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  AssistInput,
  buildAssistPrompt,
  extractJson,
  resolveProposal,
  type AssistContext,
  type AssistJob,
  type AssistMessage,
} from '../shared/assist.ts'
import { getCli } from '../shared/clis.ts'
import type { Agent, Category, Workflow } from '../shared/schema.ts'
import { cliSettings, defaultCli } from '../shared/settings.ts'
import { detectClis } from './detect.ts'
import { parserFor } from './exec/parsers.ts'
import { childEnv, runProcess } from './exec/process.ts'
import { getSettings } from './settings.ts'

type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

/** 生成配置时只需要回答，不需要改文件：每个 CLI 用最保守的权限 */
const READ_ONLY: Record<string, string> = { claude: 'default', codex: 'read-only', commandcode: 'standard' }
const TIMEOUT = 5 * 60_000

/** AI 创建 / 优化 Agent 和工作流：调用本机 CLI 生成，校验格式，不合格时让 CLI 自己修正一次 */
export function assistApi(deps: { agents: Lister<Agent>; categories: Lister<Category>; workflows: Lister<Workflow> }) {
  const jobs = new Map<string, AssistJob & { abort: AbortController; at: number }>()
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  const view = ({ abort, at, ...j }: AssistJob & { abort: AbortController; at: number }): AssistJob => j

  // 一小时前的结果清掉
  setInterval(() => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }, 600_000).unref()

  async function run(job: AssistJob & { abort: AbortController }, input: AssistInput, ctx: AssistContext) {
    const settings = await getSettings()
    const def = getCli(input.cli)!
    const cs = cliSettings(settings, input.cli)
    const installed = (await detectClis()).filter((c) => c.installed && c.enabled).map((c) => c.id)
    const cwd = path.join(tmpdir(), 'agent-panel-assist')
    await mkdir(cwd, { recursive: true })
    let messages: AssistMessage[] = input.messages

    for (let attempt = 1; attempt <= 2; attempt++) {
      job.attempt = attempt
      let text = ''
      const errors: string[] = []
      let result: { ok: boolean; error?: string } | undefined
      const parse = parserFor(input.cli, cwd)
      const r = await runProcess({
        command: cs.command,
        args: def.buildArgs({
          model: input.model || cs.defaultModel,
          permission: READ_ONLY[input.cli] ?? cs.permission,
          extraArgs: cs.extraArgs,
        }),
        cwd,
        env: childEnv(cs.env),
        stdin: buildAssistPrompt(input.kind, ctx, messages, installed),
        signal: job.abort.signal,
        timeoutMs: TIMEOUT,
        onLine: (line) => {
          const t = line.trim()
          if (!t.startsWith('{')) return
          let obj: unknown
          try {
            obj = JSON.parse(t)
          } catch {
            return
          }
          for (const ev of parse(obj)) {
            if (ev.type === 'text_delta') text += ev.text
            else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
            else if (ev.type === 'error') errors.push(ev.message)
            else if (ev.type === 'result') result = ev
          }
          // 执行中只显示说明部分，JSON 写到一半时不显示
          job.text = text.split('```')[0].trim()
        },
      })
      if (r.killed === 'stopped') return fail(job, '已停止')
      if (r.killed === 'timeout') return fail(job, '超过 5 分钟没有完成，已停止')
      if (r.spawnError)
        return fail(job, `${r.spawnError}。请确认已安装 ${def.name}（${def.installHint}），或在设置里填写路径。`)
      if (result ? !result.ok : r.code !== 0)
        return fail(
          job,
          `${def.name} 执行失败：${[result?.error, ...errors, r.stderr.trim().split('\n').slice(-4).join('\n')].filter(Boolean).join('\n') || '没有更多信息'}`,
        )

      const ex = extractJson(text)
      job.text = ex.rest
      const res = ex.error ? { error: ex.error } : resolveProposal(input.kind, ex.json, ctx)
      if (res.proposal) {
        job.proposal = res.proposal
        job.raw = JSON.stringify(ex.json, null, 2)
        job.status = 'done'
        return
      }
      if (attempt === 2) return fail(job, `${def.name} 两次都没有按格式输出：${res.error}`)
      // 把错误告诉 CLI，让它修正一次
      messages = [
        ...messages,
        { role: 'assistant', text },
        { role: 'user', text: `你上面的 JSON 不符合要求：${res.error}\n请修正后重新输出完整的说明和 JSON。` },
      ]
    }
  }

  function fail(job: AssistJob, error: string) {
    job.status = 'failed'
    job.error = error
  }

  return new Hono()
    .post('/', async (c) => {
      const p = AssistInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const input = p.data
      if (!getCli(input.cli)) return bad(c, `未知的 CLI：${input.cli}`)
      if (!cliSettings(await getSettings(), input.cli).enabled)
        return bad(c, `${getCli(input.cli)!.name} 在设置里被停用了`)
      const target = input.targetId
        ? input.kind === 'agent'
          ? await deps.agents.get(input.targetId)
          : await deps.workflows.get(input.targetId)
        : undefined
      if (input.targetId && !target) return bad(c, `要优化的${input.kind === 'agent' ? ' Agent' : '工作流'}不存在`, 404)
      const settings = await getSettings()
      const ctx: AssistContext = {
        agents: await deps.agents.list(),
        categories: await deps.categories.list(),
        workflows: await deps.workflows.list(),
        rules: input.kind === 'agent' ? settings.assist.agentRules : settings.assist.workflowRules,
        target: target ?? undefined,
        defaultCli: defaultCli(settings),
      }
      const job = {
        id: randomUUID(),
        kind: input.kind,
        targetId: input.targetId,
        status: 'running' as const,
        text: '',
        attempt: 1,
        abort: new AbortController(),
        at: Date.now(),
      }
      jobs.set(job.id, job)
      run(job, input, ctx)
        .catch((e) => fail(job, (e as Error).message))
        .finally(() => (job.at = Date.now()))
      return c.json(view(job), 201)
    })
    .get('/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : bad(c, '找不到这次生成，可能已过期', 404)
    })
    .post('/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return bad(c, '找不到这次生成', 404)
      j.abort.abort()
      return c.json(view(j))
    })
}
