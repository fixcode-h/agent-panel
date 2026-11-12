/** 对话页标题栏菜单里的导出和复制对话：从 TaskView.tsx 拆出来（文件行数上限），只调接口、弹提示，不碰页面状态 */
import { t } from '@shared/i18n'
import { pathText } from '@shared/composer'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { downloadTask, downloadTaskHtml, downloadTaskMarkdown } from '@/lib/task-transfer'

export function taskExportActions(task: { id: string }) {
  const exportIt = () =>
    downloadTask(task.id).then(
      ({ children }) =>
        toast.success(
          children ? t('已导出任务和 {n} 个子对话，导入后父子结构能还原', { n: children }) : t('已导出任务'),
        ),
      (e: Error) => toast.error(e.message),
    )
  /**
   * 导出成单文件 HTML：接收方没装面板也能看，样式内联、不执行脚本（见 shared/tasks/export.ts 的 taskHtml）。
   * 和 JSON 包分开两项：一个是给别人看的报告，一个是导回面板的数据
   */
  const exportHtml = () =>
    downloadTaskHtml(task.id).then(
      () => toast.success(t('已导出 HTML 报告，用浏览器直接打开就能看')),
      (e: Error) => toast.error(e.message),
    )
  const exportMd = () => downloadTaskMarkdown(task.id).catch((e: Error) => toast.error(e.message))
  /**
   * 复制对话：服务端把这个任务的对话整理成一份转录附件（和「引入会话」同一套格式，超长由它截断并注明），
   * 剪贴板里只放这个文件的路径——粘贴回输入框就会变成一张会话卡片，而不是一大段文字。
   */
  const copyIt = () => {
    void api
      .taskTranscript(task.id)
      .then((a) => navigator.clipboard.writeText(pathText(a.path)))
      .then(
        () => toast.success(t('对话已复制，粘贴到输入框会变成一张会话卡片')),
        (e: Error) => toast.error(t('复制对话失败：{msg}', { msg: e.message })),
      )
  }
  return { exportIt, exportHtml, exportMd, copyIt }
}
