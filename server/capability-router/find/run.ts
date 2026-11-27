/**
 * 一次查找（find 工具的 symbol / refs / outline / members / include / text）：
 * 插件登记的外部路（VS、IDEA）+ 面板自带的文本兜底，交给能力路由按顺序走，结果合并后写成给 Agent 的文字。
 *
 * 什么时候停（设计稿第 3.5 节）：
 * - 外部路查到了、且它说够了（符号、大纲默认够）就停；
 * - 引用（refs）外部路查到的是静态引用，还要用文本补一遍动态调用（Lua 的字符串调用、反射），两边合并，结果不比原来少；
 * - 先走哪条按类别定（categories.ts）：C++、Lua 先外部后文本；其他文件只走文本；看不出类型的先文本，没查到才挨个问外部路
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { describeFind } from '../../../shared/capability-router/find/request.ts'
import { formatHits, mergeHits } from '../../../shared/capability-router/find/hits.ts'
import type { FindCodeRun } from '../../../shared/host/find-code.ts'
import { projectIndex, type ProjectIndex } from '../../file-index/registry.ts'
import { pluginFindSources } from '../../plugins/find-sources.ts'
import { route, toolRouteOf, type RouteSource } from '../router.ts'
import { routeServers } from '../servers.ts'
import { externalFinal, externalSource } from './external.ts'
import { TEXT_SOURCE_ID, textSource } from './text-source.ts'
import { findCategory } from '../../../shared/capability-router/find/categories.ts'
import { orderSources } from './order.ts'

export function findCodeRun(opts: {
  projectId: string
  projectPath: string
  workDir: string
  taskId?: string
  /** 入口：记录里显示（find 工具、第二期接管的 rg） */
  entry?: string
  /** 项目开着文件索引时，没有 rg 也能逐个读索引里的文件兜底 */
  indexOn: boolean
  /** 按文本找时排除的目录（项目设置 + 默认产物目录，searchExcludeOf）：交给 rg */
  exclude: string[]
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
      const text = textSource(getIndex, relocate, { root: opts.workDir, exclude: opts.exclude })
      // 按这次查找的类别排路（shared/capability-router/find/categories.ts，用户 2026-11-27 定）：
      // C++、Lua 先问登记了这一类的外部服务；其他文件只走面板；看不出类型的先走面板、没查到再问外部服务
      const order = orderSources(findCategory(req.lang).order, external, text, req)
      const lastExternal = order.filter((s) => s.id !== TEXT_SOURCE_ID).at(-1)?.id
      const r = await route({
        capability: 'find',
        projectId: opts.projectId,
        ...(opts.taskId && { taskId: opts.taskId }),
        entry: opts.entry ?? 'find',
        what: describeFind(req),
        req,
        sources: order,
        signal,
        isEmpty: (o) => !o.hits.length,
        enough: (s) => {
          // 面板有结果就够了：外部路在它前面的已经查过，在它后面的（先走面板时）不用再问
          if (s.id === TEXT_SOURCE_ID) return true
          const spec = external.find((x) => x.src.id === s.id)?.spec
          if (!spec || !externalFinal(spec, req)) return false
          // 先走面板、面板没查到时外部服务挨个问：C++ 和 Lua 里都可能有同名的，问完再停
          return findCategory(req.lang).order !== 'panel-first' || s.id === lastExternal
        },
      })
      const hits = mergeHits(r.outs.map((x) => x.out.hits))
      // 没给结果的路也可能带说明（文本兜底超时只查了一部分）：不转告的话 Agent 会把「没有找到」当成查全了
      const notes = [...r.outs, ...r.empties].map((x) => x.out.note).filter((n): n is string => !!n)
      // 外部路都用不了、文本也没查到时，说一句哪些路没走成：Agent 能判断是真没有还是工具没开
      if (!hits.length) {
        const down = r.steps.filter((s) => s.outcome === 'skipped' || s.outcome === 'failed')
        if (down.length && !order.some((s) => s.id === TEXT_SOURCE_ID))
          notes.push(`没有能查的路：${down.map((s) => s.why ?? s.outcome).join('；')}`)
      }
      return {
        text: formatHits(hits, req, notes),
        route: toolRouteOf('find', order as RouteSource<never, unknown>[], r),
        hits,
      }
    } catch (e) {
      return { text: `查找出错：${(e as Error).message}`, error: true }
    }
  }
}
