/**
 * 「AI 处理」：把页面上的报错交给设置里「AI 创建」用的 CLI，让它分析原因并动手解决。
 * 审批按这个 CLI 的权限设置，要确认的命令在弹窗里显示成卡片（会话 fix:<id>）。
 * 某一块（topic）可以登记更多情况、工作目录和处理完后要做的事，例如本机生图（server/comfy.ts）
 */
import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { arch, homedir, platform, release } from 'node:os'
import { z } from 'zod'
import { getCli } from '../shared/clis.ts'
import { FixInput, fixPrompt, type FixJob } from '../shared/fix.ts'
import type { Settings } from '../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { t } from '../shared/i18n.ts'
import { askSession } from './asks.ts'
import { detectClis } from './detect.ts'
import { invokeCli } from './exec/invoke.ts'
import type { CliEvent } from './exec/parsers.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'

/** 用哪个 CLI 处理：「AI 创建」里设置的，没设置或不可用时用默认 CLI */
export const fixCli = (settings: Settings) =>
  settings.assist.cli && getCli(settings.assist.cli) ? settings.assist.cli : defaultCli(settings)

/**
 * 用「AI 创建」的 CLI 跑一次排查修复：本机生图的「AI 处理」和通用的报错处理共用。
 * 权限按这个 CLI 的设置（要能改东西才修得好），返回 CLI 的说明；失败时抛出原因
 */
export async function runFix(o: {
  input: string
  cwd: string
  scope: string
  signal: AbortSignal
  onEvent?: (ev: CliEvent) => void
}) {
  const settings = await getSettings()
  const cli = fixCli(settings)
  const def = getCli(cli)
  if (!def) throw new Error(t('没有可用的 CLI，请先在设置里安装并启用'))
  const cs = cliSettings(settings, cli)
  const run = agentRun({ cli, model: settings.assist.model || '@high' }, settings)
  const asks = askSession(o.scope)
  const errors: string[] = []
  let text = ''
  const r = await invokeCli({
    askUser: asks.askUser,
    onAsk: asks.onAsk,
    cliId: cli,
    command: cs.command,
    build: { model: run.model, effort: run.effort, permission: cs.permission, extraArgs: cs.extraArgs },
    cwd: o.cwd,
    env: childEnv(cs.env),
    input: o.input,
    signal: o.signal,
    timeoutMs: 0,
    onEvent: (ev) => {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
      else if (ev.type === 'error') errors.push(ev.message)
      o.onEvent?.(ev)
    },
  }).finally(asks.done)
  if (r.killed === 'stopped') throw new Error(t('已取消'))
  if (r.spawnError)
    throw new Error(
      t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
        error: r.spawnError,
        cli: def.name,
        hint: def.installHint,
      }),
    )
  if (r.code !== 0)
    throw new Error(
      [...errors, r.stderr.trim().split('\n').slice(-3).join('\n')].filter(Boolean).join('\n') ||
        t('{cli} 执行失败：{detail}', { cli: def.name, detail: t('没有更多信息') }),
    )
  return { cli, text }
}

/** 某一块报错的补充：更多情况、在哪个目录处理、处理完后要做的事 */
export interface FixTopic {
  context?: () => Promise<string> | string
  cwd?: () => string
  after?: () => void
}
const topics = new Map<string, FixTopic>()
export const registerFixTopic = (id: string, topic: FixTopic) => void topics.set(id, topic)

/** cli:<id> 的报错（安装、更新、卸载、登录）：带上这个 CLI 的安装情况 */
async function cliContext(id: string) {
  const def = getCli(id)
  if (!def) return ''
  const st = (await detectClis().catch(() => [])).find((c) => c.id === id)
  return [
    `相关的 CLI：${def.name}（npm 包 ${def.npmPackage || '无'}，官方安装命令 ${def.installHint}）`,
    st
      ? `检测结果：${st.installed ? `已安装 ${st.version ?? ''}` : '没有安装'}；命令 ${st.command}${st.path ? `，实际文件 ${st.path}` : ''}${st.source ? `，安装方式 ${st.source}` : ''}${st.error ? `；检测出错 ${st.error}` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function fixApi() {
  const jobs = new Map<string, FixJob & { abort: AbortController; at: number }>()
  const view = ({ abort, at, ...j }: FixJob & { abort: AbortController; at: number }): FixJob => j
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  setInterval(() => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }, 600_000).unref()

  async function run(job: FixJob & { abort: AbortController }, input: FixInput) {
    const topic = topics.get(input.topic)
    const extra = input.topic.startsWith('cli:')
      ? await cliContext(input.topic.slice(4))
      : ((await topic?.context?.()) ?? '')
    const want = input.cwd || topic?.cwd?.() || ''
    const cwd = want && existsSync(want) ? want : homedir()
    const prompt = fixPrompt(input, { os: `${platform()} ${release()} ${arch()}`, cwd, extra })
    log.info('fix', `AI 处理：${input.title}`, { topic: input.topic, cwd })
    const r = await runFix({
      input: prompt,
      cwd,
      scope: `fix:${job.id}`,
      signal: job.abort.signal,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') job.text += ev.text
        else if (ev.type === 'text') job.text = job.text ? `${job.text.trimEnd()}\n\n${ev.text}` : ev.text
        else if (ev.type === 'thinking')
          job.thinking = (ev.delta ? (job.thinking ?? '') + ev.text : ev.text).slice(-1500)
        else if (ev.type === 'tool')
          job.tools = [...(job.tools ?? []), `${ev.tool.name ?? ev.tool.kind} ${ev.tool.label}`.slice(0, 160)].slice(-6)
      },
    })
    job.text = r.text || job.text
    job.status = 'done'
    topic?.after?.()
  }

  return new Hono()
    .post('/', async (c) => {
      const p = FixInput.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const settings = await getSettings()
      const cli = fixCli(settings)
      if (!getCli(cli)) return bad(c, t('没有可用的 CLI，请先在设置里安装并启用'))
      const job = {
        id: randomUUID(),
        title: p.data.title,
        topic: p.data.topic,
        cli,
        status: 'running' as const,
        text: '',
        startedAt: Date.now(),
        abort: new AbortController(),
        at: Date.now(),
      }
      jobs.set(job.id, job)
      run(job, p.data)
        .catch((e) => {
          ;(job as FixJob).status = 'failed'
          ;(job as FixJob).error = (e as Error).message
          log.warn('fix', `AI 处理失败：${p.data.title}`, (e as Error).message)
        })
        .finally(() => (job.at = Date.now()))
      return c.json(view(job), 201)
    })
    .get('/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : bad(c, t('找不到这次处理，可能已过期'), 404)
    })
    .post('/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return bad(c, t('找不到这次处理'), 404)
      j.abort.abort()
      return c.json(view(j))
    })
}
