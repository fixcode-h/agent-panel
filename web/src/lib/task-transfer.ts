import { type Agent, type Task } from '@shared/schema'
import { t } from '@shared/i18n'
import {
  analysisPrompt,
  analysisReport,
  checkExportSize,
  exportFileName,
  exportTask,
  parseTaskExport,
  withImportedAgents,
  type TaskExport,
} from '@shared/task-export'
import { api } from './api'

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

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' })
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
function toBase64(s: string) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * AI 分析：把一次或几次执行整理成报告附上，新建一个用默认 Agent 的对话来分析。
 * Agent 的回复末尾带修改建议，任务页上看过差异再应用
 */
export async function startAnalysis(opts: { tasks: Task[]; agents: Agent[]; projectId: string; focus?: string }) {
  const app = await appVersion()
  const bundles: TaskExport[] = await Promise.all(
    opts.tasks.map(async (tk) =>
      exportTask(tk, withImportedAgents(opts.agents, tk), app, new Date(), await childrenStats(tk.id)),
    ),
  )
  const first = opts.tasks[0]
  const title =
    opts.tasks.length > 1
      ? t('分析：{name} 最近 {n} 次执行', { name: first.workflowName || first.title, n: opts.tasks.length })
      : t('分析：{title}', { title: first.title })
  const report = await api.upload({
    name: `${t('执行记录')}-${first.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}.md`,
    mime: 'text/markdown',
    data: toBase64(analysisReport(bundles)),
  })
  const created = await api.createTask({
    projectId: opts.projectId,
    mode: 'chat',
    workflowId: '',
    agentId: '',
    cli: '',
    model: '',
    effort: '',
    params: {},
    prompt: analysisPrompt(bundles, opts.focus),
    attachments: [report],
    isolate: false,
    askUser: false,
  })
  return api.renameTask(created.id, title.slice(0, 80)).catch(() => created)
}
