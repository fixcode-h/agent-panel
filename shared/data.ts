import { t } from './i18n.ts'

/** 用户数据目录里的几类数据，设置的「数据」里按类显示占用、清理、导入导出 */
export const DATA_KINDS = [
  { id: 'config', label: t('配置'), hint: t('设置、Agent、工作流和分类'), clearable: false },
  {
    id: 'projects',
    label: t('项目'),
    hint: t('添加的项目（不会动项目目录里的文件）；清理时任务记录一起清掉'),
    clearable: true,
  },
  { id: 'tasks', label: t('任务记录'), hint: t('执行过的工作流、对话和聊天，包括输出和用量'), clearable: true },
  { id: 'uploads', label: t('附件'), hint: t('任务里附上的文件和图片'), clearable: true },
  { id: 'cache', label: t('缓存'), hint: t('下载的更新包、损坏文件的备份，可以随时清理'), clearable: true },
] as const

export type DataKind = (typeof DATA_KINDS)[number]['id']

export interface DataUsage {
  /** 数据目录的绝对路径 */
  dir: string
  kinds: { id: DataKind; files: number; bytes: number }[]
  /** 面板服务进程的内存占用（字节） */
  memory: { rss: number; heapUsed: number }
}
