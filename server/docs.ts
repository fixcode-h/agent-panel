/**
 * 项目说明文件（AGENTS.md、CLAUDE.md…）：读、写，以及用本机 CLI 优化。
 * 只认 shared/docs.ts 里列出的文件名，不能借这个接口读写项目里的其他文件。
 */
import { askSession } from './asks.ts'
import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { CLIS, getCli } from '../shared/clis.ts'
import {
  docFiles,
  type DocFile,
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
import { safeArgs } from './assist.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'
import { projectFormat, writeTextFile } from '../shared/file-format.ts'
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

  async function read(dir: string, file: DocFile): Promise<ProjectDoc> {
    const full = path.join(dir, file)
    const s = await stat(full).catch(() => null)
    if (!s?.isFile()) return { path: file, exists: false, content: '', bytes: 0 }
    if (s.size > DOC_MAX) return { path: file, exists: true, content: '', bytes: s.size, tooLarge: true }
    // 去掉 UTF-8 的 BOM：编辑器里看不到，留在内容里会让「有没有改动」的判断一直不相等
    const raw = await readFile(full, 'utf8')
    return { path: file, exists: true, content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw, bytes: s.size }
  }

  type RunInput = { cli: string; model: string; effort: string; path: string; prompt: string }
  async function run(job: DocJob & { abort: AbortController }, input: RunInput, dir: string) {
    const settings = await getSettings()
    const def = getCli(input.cli)!
    const cs = cliSettings(settings, input.cli)
    const r0 = agentRun({ cli: input.cli, model: input.model, effort: input.effort }, settings)
    let text = ''
    const errors: string[] = []
    let result: { ok: boolean; error?: string } | undefined
    log.info('docs', `用 ${def.name} 优化 ${input.path}`, { dir })
    const asks = askSession(`doc:${job.id}`)
    const r = await invokeCli({
      askUser: asks.askUser,
      onAsk: asks.onAsk,
      cliId: input.cli,
      command: cs.command,
      // 在项目目录里运行，能看代码核对；权限用只读，不会改文件
      build: {
        model: r0.model,
        effort: r0.effort,
        permission: def.readOnly || cs.permission,
        extraArgs: safeArgs(cs.extraArgs),
      },
      cwd: dir,
      env: childEnv(cs.env),
      input: input.prompt,
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
    }).finally(asks.done)
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
        const files = await Promise.all(docFiles().map((f) => read(dir, f)))
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
        // 按项目设置（没设时跟随全局）的编码和换行符写：默认 UTF-8 无 BOM + LF
        const project = await deps.projects.get(c.req.param('id'))
        await writeTextFile(full, p.data.content, projectFormat(project ?? undefined, await getSettings()))
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
      let dir: string
      try {
        dir = await dirOf(c.req.param('id'))
      } catch (e) {
        return bad(c, (e as Error).message)
      }
      const readers = CLIS.filter((d) => d.docs.includes(input.path)).map((d) => d.name)
      return start(c, { ...input, prompt: docOptimizePrompt(input, readers) }, dir)
    })

  /** 开始一次优化：检查 CLI 能用，在 dir 里只读运行，结果用 /doc-jobs 查 */
  async function start(c: Context, input: RunInput, dir: string) {
    if (!getCli(input.cli)) return bad(c, t('未知的 Agent：{cli}', { cli: input.cli }))
    if (!cliSettings(await getSettings(), input.cli).enabled)
      return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(input.cli)!.name }))
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
  }

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
  return { routes, jobRoutes, start }
}
