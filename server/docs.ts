/**
 * 项目说明文件（AGENTS.md、CLAUDE.md…）：读、写，以及用本机 CLI 优化。
 * 只认 shared/docs.ts 里列出的文件名，不能借这个接口读写项目里的其他文件。
 */
import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getCli } from '../shared/clis.ts'
import {
  CLI_DOCS,
  DOC_FILES,
  DOC_MAX,
  DocOptimizeInput,
  DocWrite,
  docOptimizePrompt,
  extractDoc,
  type DocJob,
  type ProjectDoc,
  type ProjectDocs,
} from '../shared/docs.ts'
import type { Project } from '../shared/schema.ts'
import { agentRun, cliSettings } from '../shared/settings.ts'
import { READ_ONLY, safeArgs } from './assist.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'
import { t } from '../shared/i18n.ts'

const TIMEOUT = 10 * 60_000

export function docsApi(deps: { projects: { get(id: string): Promise<Project | null> } }) {
  const jobs = new Map<string, DocJob & { abort: AbortController; at: number }>()
  const view = ({ abort, at, ...j }: DocJob & { abort: AbortController; at: number }): DocJob => j
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  setInterval(() => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }, 600_000).unref()

  /** 项目目录：项目不存在或目录不在了都报错 */
  async function dirOf(id: string) {
    const p = await deps.projects.get(id)
    if (!p) throw new Error(t('项目不存在'))
    const s = p.path ? await stat(p.path).catch(() => null) : null
    if (!s?.isDirectory()) throw new Error(t('项目目录不存在：{dir}', { dir: p.path || t('（未设置）') }))
    return p.path
  }

  async function read(dir: string, file: (typeof DOC_FILES)[number]): Promise<ProjectDoc> {
    const full = path.join(dir, file)
    const s = await stat(full).catch(() => null)
    if (!s?.isFile()) return { path: file, exists: false, content: '', bytes: 0 }
    if (s.size > DOC_MAX) return { path: file, exists: true, content: '', bytes: s.size, tooLarge: true }
    return { path: file, exists: true, content: await readFile(full, 'utf8'), bytes: s.size }
  }

  async function run(job: DocJob & { abort: AbortController }, input: DocOptimizeInput, dir: string) {
    const settings = await getSettings()
    const def = getCli(input.cli)!
    const cs = cliSettings(settings, input.cli)
    const r0 = agentRun({ cli: input.cli, model: input.model, effort: input.effort }, settings)
    const readers = Object.entries(CLI_DOCS)
      .filter(([, files]) => files.includes(input.path))
      .map(([id]) => getCli(id)?.name ?? id)
    let text = ''
    const errors: string[] = []
    let result: { ok: boolean; error?: string } | undefined
    log.info('docs', `用 ${def.name} 优化 ${input.path}`, { dir })
    const r = await invokeCli({
      cliId: input.cli,
      command: cs.command,
      // 在项目目录里运行，能看代码核对；权限用只读，不会改文件
      build: {
        model: r0.model,
        effort: r0.effort,
        permission: READ_ONLY[input.cli] ?? cs.permission,
        extraArgs: safeArgs(cs.extraArgs),
      },
      cwd: dir,
      env: childEnv(cs.env),
      input: docOptimizePrompt(input, readers),
      signal: job.abort.signal,
      timeoutMs: TIMEOUT,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') text += ev.text
        else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
        else if (ev.type === 'error') errors.push(ev.message)
        else if (ev.type === 'thinking')
          job.thinking = (ev.delta ? (job.thinking ?? '') + ev.text : ev.text).slice(-1500)
        else if (ev.type === 'tool') job.tools = [...(job.tools ?? []), ev.tool.label].slice(-5)
        else if (ev.type === 'result') result = ev
        job.text = text.split('```')[0].trim()
        job.outChars = text.length
      },
    })
    const fail = (error: string) => {
      job.status = 'failed'
      job.error = error
      log.warn('docs', `优化 ${input.path} 失败`, error)
    }
    if (r.killed === 'stopped') return fail(t('已停止'))
    if (r.killed === 'timeout') return fail(t('超过 {n} 分钟没有完成，已停止', { n: TIMEOUT / 60_000 }))
    if (r.spawnError)
      return fail(
        t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
          error: r.spawnError,
          cli: def.name,
          hint: def.installHint,
        }),
      )
    if (result ? !result.ok : r.code !== 0)
      return fail(
        t('{cli} 执行失败：{detail}', {
          cli: def.name,
          detail:
            [result?.error, ...errors, r.stderr.trim().split('\n').slice(-6).join('\n')].filter(Boolean).join('\n') ||
            t('没有更多信息'),
        }),
      )
    const ex = extractDoc(text)
    if (!ex.content?.trim()) return fail(t('{cli} 没有按格式给出新的文件内容，可以再试一次', { cli: def.name }))
    job.text = ex.rest
    job.result = ex.content
    job.status = 'done'
  }

  const routes = new Hono()
    .get('/:id', async (c) => {
      try {
        const dir = await dirOf(c.req.param('id'))
        const files = await Promise.all(DOC_FILES.map((f) => read(dir, f)))
        return c.json({ dir, files } satisfies ProjectDocs)
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
    .put('/:id', async (c) => {
      const p = DocWrite.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      try {
        const dir = await dirOf(c.req.param('id'))
        const full = path.join(dir, p.data.path)
        await mkdir(path.dirname(full), { recursive: true })
        await writeFile(full, p.data.content)
        log.info('docs', `保存 ${p.data.path}`, { dir, bytes: Buffer.byteLength(p.data.content) })
        return c.json(await read(dir, p.data.path))
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
    .post('/:id/optimize', async (c) => {
      const p = DocOptimizeInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const input = p.data
      if (!getCli(input.cli)) return bad(c, t('未知的 CLI：{cli}', { cli: input.cli }))
      if (!cliSettings(await getSettings(), input.cli).enabled)
        return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(input.cli)!.name }))
      let dir: string
      try {
        dir = await dirOf(c.req.param('id'))
      } catch (e) {
        return bad(c, (e as Error).message)
      }
      const job = {
        id: randomUUID(),
        path: input.path,
        status: 'running' as const,
        text: '',
        startedAt: Date.now(),
        abort: new AbortController(),
        at: Date.now(),
      }
      jobs.set(job.id, job)
      run(job, input, dir)
        .catch((e) => {
          ;(job as DocJob).status = 'failed'
          ;(job as DocJob).error = (e as Error).message
        })
        .finally(() => (job.at = Date.now()))
      return c.json(view(job), 201)
    })

  const jobRoutes = new Hono()
    .get('/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : bad(c, t('找不到这次优化，可能已过期'), 404)
    })
    .post('/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return bad(c, t('找不到这次优化'), 404)
      j.abort.abort()
      return c.json(view(j))
    })
  return { routes, jobRoutes }
}
