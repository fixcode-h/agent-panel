/**
 * file_index 工具在服务端的那一半（设计稿：项目文件索引 第 6 节）：查项目的索引、拼成给 Agent 的文字。
 * 返回默认不超过 4000 字（ADR 0067），超了截断并给 nextOffset；索引没建好时在这里等（最多一分钟），不让 Agent 轮询。
 *
 * 独立分支（worktree）不另建索引（用户 2026-11-23 按推荐定）：查项目目录那份，再在对话自己的目录里现场核对一下在不在
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FileIndexArgs, FileIndexRun } from '../../shared/host/file-index.ts'
import { projectIndex, statusOf } from './registry.ts'

const BUDGET = 4000
const WAIT_MS = 60_000

/** 按字数预算分页：至少给一条，保证能往下翻 */
function pageOut(items: string[], offset: number, limit: number) {
  const out: string[] = []
  let used = 0
  for (const it of items.slice(offset, offset + limit)) {
    if (out.length && used + it.length + 1 > BUDGET - 300) break
    out.push(it)
    used += it.length + 1
  }
  const next = offset + out.length
  return { out, next: next < items.length ? next : undefined }
}

export function fileIndexRun(opts: {
  projectId: string
  projectPath: string
  workDir: string
  exclude: string[]
}): FileIndexRun {
  const inWorktree = path.resolve(opts.workDir) !== path.resolve(opts.projectPath)
  // 独立分支里：项目目录里的相对路径换到对话目录里核对；不在了的去掉（那边删了或改名了）
  const keep = (p: string) => !inWorktree || path.isAbsolute(p) || existsSync(path.join(opts.workDir, p))
  const missNote = () =>
    [
      `索引不收这些排除目录：${opts.exclude.join('、')}，要找那里的文件直接用 find / rg --files。`,
      '刚在面板外批量生成的文件可能还没进索引：先 action=refresh（可以带 dir 只核对那个目录）再查，或直接用 find。',
      inWorktree ? '这个对话在独立分支目录里：这里新建、还没合回的文件不在索引里，直接用 find 找。' : '',
    ]
      .filter(Boolean)
      .join('\n')

  return async (a: FileIndexArgs) => {
    const idx = await projectIndex(opts.projectId)
    if (!idx) return { text: '项目设置里关了文件索引：直接用 rg --files / find 找', error: true }
    const limit = Math.min(Math.max(Math.floor(a.limit ?? 50), 1), 500)
    const offset = Math.max(Math.floor(a.offset ?? 0), 0)

    if (a.action === 'status') return { text: JSON.stringify(await statusOf(opts.projectId)) }
    if (a.action === 'rebuild') {
      void idx.rebuild()
      return { text: '已开始整份重建：期间 find / list 会等它建好再回答（最多一分钟）。' }
    }
    if (a.action === 'refresh') {
      if (!(await idx.ready(WAIT_MS))) return { text: '索引第一次建立还没完成，建好后已经是最新的，不用 refresh' }
      const r = await idx.refresh(a.dir)
      return { text: `核对了 ${r.checked} 个目录：新增 ${r.added} 个文件，删掉 ${r.removed} 个。` }
    }

    const ready = await idx.ready(WAIT_MS)
    const partial = ready ? '' : '（索引还在建立，下面是已经读到的部分；没找到的稍后再查）\n'

    if (a.action === 'list') {
      const r = await idx.list(a.dir ?? '', { recursive: a.recursive, ext: a.ext })
      if (!r)
        return {
          text: `索引里没有目录「${a.dir}」：不存在，或在排除目录里（${opts.exclude.join('、')}）。要看排除目录直接用 ls / find。`,
          error: true,
        }
      const items = [...r.dirs.map((d) => `${d}/`), ...r.files].filter((p) => keep(p.replace(/\/$/, '')))
      const { out, next } = pageOut(items, offset, limit)
      const head = `${a.dir || '项目根'}：${r.dirs.length} 个子目录、${r.files.length} 个文件${a.recursive ? '（整棵子树）' : ''}`
      return {
        text: [partial + head, ...out, next !== undefined ? `……还有，nextOffset=${next}` : '']
          .filter(Boolean)
          .join('\n'),
      }
    }

    // find
    const q = (a.query ?? '').trim()
    if (!q && !a.ext?.length) return { text: 'find 要给 query（文件名里的词）或 ext', error: true }
    const hits = idx
      .find(q, { under: a.under, ext: a.ext, dirs: a.dirs, cap: offset + limit + 500 })
      .map((h) => h.path)
      .filter(keep)
    if (!hits.length) return { text: `${partial}没找到「${q}」。\n${missNote()}` }
    const { out, next } = pageOut(hits, offset, limit)
    const total = hits.length >= offset + limit + 500 ? `${hits.length}+` : String(hits.length)
    return {
      text: [
        `${partial}找到 ${total} 个，第 ${offset + 1}–${offset + out.length} 个（项目里的是相对项目根的路径）：`,
        ...out,
        next !== undefined ? `……还有，nextOffset=${next}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
}
