import path from 'node:path'
import type { Agent, Project } from '../../shared/schema.ts'
import type { HookFacts } from '../../shared/hooks/index.ts'
import type { ModuleDoc } from '../../shared/module-docs.ts'
import { moduleEntryText, moduleOfFile, newPublicFns, newPublicFnText } from '../../shared/knowledge/module-entry.ts'
import { docRootOf, readModuleDocs } from '../module-map.ts'
import { taskMap } from '../runtime/task-state.ts'
import { taskLog } from '../tasks/log.ts'

/**
 * 模块入口推送（规则和文字在 shared/knowledge/module-entry.ts）：挂在「推送项目教训和经验」（push-lessons）钩子的工具前，
 * 同一个开关。读或改某个模块的文件时推一次这个模块的入口；改文件要新增公开函数时提醒先搜有没有现成的。
 * 同一个对话里每个模块、每个函数名只推一次
 */

/** 每个对话推过的：`m:<模块>`、`f:<函数名>` */
const pushed = taskMap<Set<string>>('hooks.module-push 推过的模块和函数') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再推一次

/** 模块文档最多隔这么久重读一次：一轮里会碰很多文件，不必每次都扫 modules/ 目录 */
const RELOAD_MS = 60_000

export interface ModulePushCtx {
  taskId: string
  project: Project
  agents: Agent[]
  cwd: string
}

export function modulePush(c: ModulePushCtx) {
  let at = 0
  let docs: ModuleDoc[] = []
  let docRel = 'docs'
  const load = async () => {
    if (Date.now() - at < RELOAD_MS) return
    at = Date.now()
    const root = await docRootOf(c.project.path, c.agents).catch(() => '')
    docs = root ? await readModuleDocs(root).catch(() => []) : []
    docRel = root ? path.relative(c.project.path, root).split(path.sep).join('/') || '.' : 'docs'
  }
  const relOf = (p: string) => {
    if (!p) return ''
    const r = path.relative(c.cwd, path.resolve(c.cwd, p))
    return r.startsWith('..') || path.isAbsolute(r) ? '' : r.replace(/\\/g, '/')
  }
  const seen = () => {
    const s = pushed.get(c.taskId) ?? new Set<string>()
    pushed.set(c.taskId, s)
    return s
  }

  return {
    /** 工具前：返回要补给模型的说明，没有就是空串 */
    async before(facts: HookFacts): Promise<string> {
      const tool = facts.tool
      if (!tool || (tool.kind !== 'edit' && tool.kind !== 'read')) return ''
      const files = (tool.paths.length ? tool.paths : [tool.path]).map(relOf).filter(Boolean)
      const s = seen()
      const out: string[] = []
      await load()
      for (const f of files) {
        const doc = docs.length ? moduleOfFile(docs, f) : undefined
        if (!doc || s.has(`m:${doc.name}`)) continue
        s.add(`m:${doc.name}`)
        out.push(moduleEntryText(doc, f, `${docRel}/modules/${doc.name}/README.md`))
      }
      if (tool.kind === 'edit') {
        const fresh = newPublicFns(tool.input, files[0] ?? '').filter((n) => !s.has(`f:${n}`))
        for (const n of fresh) s.add(`f:${n}`)
        if (fresh.length) out.push(newPublicFnText(fresh))
      }
      if (out.length) taskLog(c.taskId, '推送模块入口', { files: files.slice(0, 3), chars: out.join('').length })
      return out.join('\n\n')
    },
  }
}
