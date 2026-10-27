import { type Agent, type Project, type Task } from '@shared/schema'
import { lessonReviewPrompt, lessonReviewReport } from '@shared/lesson-review'
import { t } from '@shared/i18n'
import {
  analysisPrompt,
  analysisReport,
  checkExportSize,
  exportFileName,
  exportHtmlFileName,
  exportTask,
  parseTaskExport,
  taskHtml,
  withImportedAgents,
  type HelperScope,
  type TaskExport,
} from '@shared/task-export'
import { api } from './api'
import { createAnalysisTask } from './ai-window'

/** 导出时记下面板版本，导入的人能看出是哪个版本导出的 */
async function appVersion() {
  return (await api.appVersion().catch(() => null))?.current ?? ''
}

/**
 * 子对话（含多层）的统计合计：服务端读完整子对话算好，前端只拿几个数字。
 * 拿不到时不影响导出，只是报告里少一组合计数（不能因此输出一份互相矛盾的数字）。
 */
async function childrenStats(id: string) {
  return api.taskChildrenStats(id).catch(() => undefined)
}

function download(name: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 导出整个任务（对话或工作流执行）：连同它分出的所有子对话整理成一个包，去掉本机信息和密钥，存成 JSON 文件。
 * 整棵树由服务端收集（要按 parentTaskId 递归、按体积上限拦），这里只管打包下载
 */
export async function downloadTask(id: string) {
  const { bundle } = await api.taskExport(id, await appVersion())
  // 老服务端不带体积检查时也不能把打不开的文件写出去
  checkExportSize(bundle)
  download(exportFileName(bundle.task.title), JSON.stringify(bundle, null, 2))
  return { children: bundle.children.length }
}

/**
 * 导出成单文件 HTML 报告：样式内联、不加载外部资源、不执行脚本，没装面板的人双击就能在浏览器里看。
 * 用的是和 JSON 包同一份导出数据，HTML 里只报告这一次执行（子对话不进 HTML）
 */
export async function downloadTaskHtml(id: string) {
  const { bundle } = await api.taskExport(id, await appVersion())
  download(exportHtmlFileName(bundle.task.title), taskHtml(bundle), 'text/html;charset=utf-8')
}

/** 读导出的文件并导入成只读任务（连同包里的子对话），返回父任务在前的整棵树 */
export async function importTaskFile(file: File, projectId: string) {
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new Error(t('不是有效的 JSON 文件'))
  }
  // 先在页面上检查一遍，格式不对时不用等服务端
  parseTaskExport(raw)
  return api.importTask(projectId, raw)
}

/** UTF-8 文字转 base64（上传附件用）；分段转，长报告不会撑爆参数个数 */
export function toBase64(s: string) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * AI 分析：把一次或几次执行整理成报告附上，按归属规则新建分析对话（见 shared/analysis-home.ts）：
 * 一个对话（含它名下子任务）的分析在项目里另开一个顶层对话，子对话的分析开成它所属顶层对话的子对话；
 * 几次工作流执行、导入的只读记录开在项目里。
 * 角色用必备角色「分析」；回复末尾带修改建议，任务页上看过差异再应用。
 * scope 有值时只分析那一个子任务（子任务窗口里的「AI 分析」），报告和提示词都只看这一步。
 */
export async function startAnalysis(opts: {
  tasks: Task[]
  agents: Agent[]
  projectId: string
  focus?: string
  scope?: HelperScope
  /** 子任务分析用的副标题（「子任务 <标题>」）：拼进对话标题，在列表里能认出是哪个子任务 */
  scopeTitle?: string
}) {
  const app = await appVersion()
  const bundles: TaskExport[] = await Promise.all(
    opts.tasks.map(async (tk) =>
      exportTask(tk, withImportedAgents(opts.agents, tk), app, new Date(), await childrenStats(tk.id)),
    ),
  )
  const first = opts.tasks[0]
  const title =
    opts.scope && opts.scopeTitle
      ? t('分析：{title}', { title: `${first.title} → ${opts.scopeTitle}` })
      : opts.tasks.length > 1
        ? t('分析：{name} 最近 {n} 次执行', { name: first.workflowName || first.title, n: opts.tasks.length })
        : t('分析：{title}', { title: first.title })
  const reportName = opts.scope ? t('子任务记录') : t('执行记录')
  const report = await api.upload({
    name: `${reportName}-${(opts.scopeTitle || first.title).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}.md`,
    mime: 'text/markdown',
    data: toBase64(analysisReport(bundles, undefined, opts.scope)),
  })
  return createAnalysisTask({
    scope: opts.tasks.length === 1 ? { kind: 'task', task: first } : { kind: 'project', projectId: opts.projectId },
    kind: 'run',
    title,
    prompt: analysisPrompt(bundles, opts.focus, opts.scope),
    attachments: [report],
  })
}

/**
 * 项目教训的 AI 评审：按归属规则在这个项目里开一个分析对话（角色「分析」），教训全文作附件；
 * 回复末尾的评审块在对话里画成卡片逐条应用
 */
export async function startLessonReview(opts: { project: Project; focus?: string }) {
  const { project } = opts
  const report = await api.upload({
    name: `${t('项目教训')}-${project.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}.md`,
    mime: 'text/markdown',
    data: toBase64(lessonReviewReport(project.name, project.lessons)),
  })
  return createAnalysisTask({
    scope: { kind: 'project', projectId: project.id },
    kind: 'lessons',
    title: t('AI 评审：项目教训'),
    prompt: lessonReviewPrompt(project.name, project.lessons.length, opts.focus?.trim()),
    attachments: [report],
  })
}
