import { DEFAULT_AGENT_ID, type Agent, type Task } from '@shared/schema'
import { t } from '@shared/i18n'
import {
  analysisPrompt,
  analysisReport,
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

/** 导出整个任务（对话或工作流执行）：取完整内容，去掉本机信息和密钥，存成 JSON 文件 */
export async function downloadTask(id: string, agents: Agent[]) {
  const task = await api.task(id)
  const bundle = exportTask(task, agents, await appVersion())
  download(exportFileName(task.title), JSON.stringify(bundle, null, 2))
}

/** 读导出的文件并导入成只读任务 */
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
  const bundles: TaskExport[] = opts.tasks.map((tk) => exportTask(tk, withImportedAgents(opts.agents, tk), app))
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
    agentId: DEFAULT_AGENT_ID,
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
