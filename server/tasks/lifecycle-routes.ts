import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import type { LifeReport } from '../../shared/lifecycle.ts'
import { copyFileToClipboard } from '../locate-file.ts'
import { revealDir } from '../open.ts'
import { DATA_DIR } from '../store.ts'
import { lifecycleAnalysis } from './lifecycle-ai.ts'
import { lifecycleReport, redact } from './lifecycle.ts'
import type { TasksScope } from './scope.ts'

/** 诊断文件放在数据目录下：用户粘贴给开发后可以删，面板不自动清 */
export const DIAG_DIR = () => path.join(DATA_DIR, 'diagnostics')

const pad = (n: number) => String(n).padStart(2, '0')
/** 文件名：对话标题的前几个字 + 时间，同一个对话多次生成不互相覆盖 */
function diagName(title: string, at = new Date()) {
  const safe = (title || 'task').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24)
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${safe}-${stamp}.json`
}

/**
 * 状态诊断（对话菜单「状态」）：一棵对话树的 CLI 生命周期报告，见 server/tasks/lifecycle.ts 和 shared/lifecycle.ts。
 * - GET 给弹窗看（每个节点只带最近的日志）
 * - POST /file 生成诊断文件（完整日志、去掉密钥）并把文件放进系统剪贴板，粘贴到聊天里就是附件
 * - GET /download 下载同一份文件
 */
export function registerLifecycleRoutes(sc: TasksScope) {
  sc.routes.get('/:id/lifecycle', async (c) => {
    const r = await lifecycleReport(sc, c.req.param('id'))
    if (!r) return sc.bad(c, t('任务不存在'), 404)
    return c.json(r)
  })

  /** 生成完整的诊断文件：写盘、去密钥 */
  async function writeDiag(id: string, report?: LifeReport) {
    const r = report ?? (await lifecycleReport(sc, id, true))
    if (!r) return null
    const dir = DIAG_DIR()
    await mkdir(dir, { recursive: true })
    const title = r.nodes.find((n) => n.id === id)?.title ?? id
    const file = path.join(dir, diagName(title))
    await writeFile(file, redact(JSON.stringify(r, null, 2)), 'utf8')
    return file
  }

  sc.routes.post('/:id/lifecycle/file', async (c) => {
    const file = await writeDiag(c.req.param('id'))
    if (!file) return sc.bad(c, t('任务不存在'), 404)
    const copied = await copyFileToClipboard(file)
    return c.json({ path: file, copied })
  })

  /**
   * 「AI 分析」：先照样写一份诊断文件（AI 要看整棵树时自己读），再把选中节点的材料整理成 AI 处理的输入，
   * 页面拿去走统一的 AI 分析窗口（openAiFix）。材料去掉密钥
   */
  sc.routes.post('/:id/lifecycle/analysis', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { node?: string }
    const r = await lifecycleReport(sc, id, true)
    if (!r) return sc.bad(c, t('任务不存在'), 404)
    const node = r.nodes.find((n) => n.id === (body.node || id))
    if (!node) return sc.bad(c, t('任务不存在'), 404)
    const file = (await writeDiag(id, r))!
    const input = lifecycleAnalysis(r, node, file)
    return c.json({
      ...input,
      error: redact(input.error),
      output: redact(input.output),
      context: redact(input.context),
      cwd: DIAG_DIR(),
    })
  })

  sc.routes.get('/:id/lifecycle/download', async (c) => {
    const id = c.req.param('id')
    const r = await lifecycleReport(sc, id, true)
    if (!r) return sc.bad(c, t('任务不存在'), 404)
    const title = r.nodes.find((n) => n.id === id)?.title ?? id
    c.header('content-type', 'application/json; charset=utf-8')
    c.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(diagName(title))}`)
    return c.body(redact(JSON.stringify(r, null, 2)))
  })

  /** 剪贴板放不进去时：在文件管理器里打开诊断文件所在的目录 */
  sc.routes.post('/:id/lifecycle/reveal', async (c) => {
    await mkdir(DIAG_DIR(), { recursive: true })
    await revealDir(DIAG_DIR())
    return c.json({ ok: true })
  })
}
