/**
 * 一次查找（find 工具的 symbol / refs / outline / members / include / text）：
 * 插件登记的外部路（VS、IDEA）+ 面板自带的文本兜底，交给能力路由按顺序走，结果合并后写成给 Agent 的文字。
 *
 * 什么时候停（设计稿第 3.5 节）：
 * - 外部路查到了、且它说够了（符号、大纲默认够）就停；
 * - 引用（refs）外部路查到的是静态引用，还要用文本补一遍动态调用（Lua 的字符串调用、反射），两边合并，结果不比原来少；
 * - 语言推不出来（other）时外部路都试一遍再决定要不要文本补：C++ 和 Lua 里可能都有同名的
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { describeFind } from '../../../shared/capability-router/find/request.ts'
import { formatHits, mergeHits } from '../../../shared/capability-router/find/hits.ts'
import type { FindOutcome, FindRequest } from '../../../shared/capability-router/find/types.ts'
import type { FindCodeRun } from '../../../shared/host/find-code.ts'
import { projectIndex, type ProjectIndex } from '../../file-index/registry.ts'
import { pluginFindSources } from '../../plugins/find-sources.ts'
import { route, type RouteSource } from '../router.ts'
import { routeServers } from '../servers.ts'
import { externalFinal, externalSource } from './external.ts'
import { TEXT_SOURCE_ID, textSource } from './text-source.ts'

export function findCodeRun(opts: {
  projectId: string
  projectPath: string
  workDir: string
  taskId?: string
  /** 入口：记录里显示（find 工具、第二期接管的 rg） */
  entry?: string
  /** 项目开着文件索引才有文本兜底（候选文件从索引取） */
  indexOn: boolean
}): FindCodeRun {
  const dirs = [...new Set([opts.workDir, opts.projectPath].map((d) => path.resolve(d)))]
  const inWorktree = dirs.length > 1
  const getIndex = async (): Promise<ProjectIndex | undefined> =>
    opts.indexOn ? projectIndex(opts.projectId) : undefined
  // 独立分支里：索引是项目目录那份，读内容要读对话自己目录里的（改过的、新建的以那边为准）
  const relocate = (f: { path: string; abs: string }) => {
    if (!inWorktree || path.isAbsolute(f.path)) return f
    const abs = path.join(opts.workDir, f.path)
    return existsSync(abs) ? { ...f, abs } : undefined
  }

  return async (req, signal) => {
    try {
      const [specs, servers] = await Promise.all([
        pluginFindSources({ id: opts.projectId, path: opts.projectPath }),
        routeServers(dirs),
      ])
      const ctx = { projectId: opts.projectId, dirs }
      const external = specs.map((spec) => ({ spec, src: externalSource(spec, servers, ctx) }))
      const sources: RouteSource<FindRequest, FindOutcome>[] = [
        ...external.map((x) => x.src),
        textSource(getIndex, relocate),
      ]
      // 语言不明时外部路都管（语言对不上的服务查不到就是空，不算错）
      if (req.lang === 'other')
        for (const x of external) x.src.accepts = (r) => x.spec.kinds.includes(r.kind) && x.spec.args(r) !== null
      const order = sources.filter((s) => s.accepts(req)).sort((a, b) => a.rank - b.rank)
      const lastExternal = order.filter((s) => s.id !== TEXT_SOURCE_ID).at(-1)?.id
      const r = await route({
        capability: 'find',
        projectId: opts.projectId,
        ...(opts.taskId && { taskId: opts.taskId }),
        entry: opts.entry ?? 'find',
        what: describeFind(req),
        req,
        sources,
        signal,
        isEmpty: (o) => !o.hits.length,
        enough: (s) => {
          if (s.id === TEXT_SOURCE_ID) return true
          const spec = external.find((x) => x.src === s)?.spec
          if (!spec || !externalFinal(spec, req)) return false
          return req.lang !== 'other' || s.id === lastExternal
        },
      })
      const hits = mergeHits(r.outs.map((x) => x.out.hits))
      const notes = r.outs.map((x) => x.out.note).filter((n): n is string => !!n)
      // 外部路都用不了、文本也没查到时，说一句哪些路没走成：Agent 能判断是真没有还是工具没开
      if (!hits.length) {
        const down = r.steps.filter((s) => s.outcome === 'skipped' || s.outcome === 'failed')
        if (down.length && !order.some((s) => s.id === TEXT_SOURCE_ID))
          notes.push(`没有能查的路：${down.map((s) => s.why ?? s.outcome).join('；')}`)
      }
      return { text: formatHits(hits, req, notes) }
    } catch (e) {
      return { text: `查找出错：${(e as Error).message}`, error: true }
    }
  }
}
