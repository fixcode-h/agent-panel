import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { StopButton } from '@/components/ui/stop-button'

/**
 * 终止对话的后台命令（运行区那一行、工具行、子任务名下的命令、命令行窗口共用）：
 * 服务端结束整棵进程树（server/exec/process.ts 的 killTreeDeep，Windows 上连脱离了树的孙进程一起补杀），
 * 并把「已被用户终止」推回对话（tellAgent），Agent 不再干等这条结果、也不会自己重跑。
 * 一行挂着几条命令（一次申请的几个编译）时一起终止
 */
export function StopJobsButton({
  taskId,
  jobs,
  compact,
  withText,
}: {
  taskId: string
  jobs: { id: string; name: string }[]
  compact?: boolean
  withText?: boolean
}) {
  if (!taskId || !jobs.length) return null
  const stop = async () => {
    const res = await Promise.all(
      jobs.map((j) =>
        api.stopJob(taskId, j.id, true).catch((e: Error) => ({ ok: false, info: e.message, id: undefined })),
      ),
    )
    const bad = res.find((r) => !r.ok)
    if (bad) {
      toast.error(bad.info)
      // 有的停成了：这一行马上会更新，按钮不用再恢复
      return res.some((r) => r.ok)
    }
    toast.success(
      jobs.length === 1
        ? t('已终止后台命令「{name}」，已告诉 Agent', { name: jobs[0].name })
        : t('已终止 {n} 条后台命令，已告诉 Agent', { n: jobs.length }),
    )
    return true
  }
  return (
    <StopButton
      onStop={stop}
      label={jobs.length === 1 ? t('终止后台命令') : t('终止这 {n} 条后台命令', { n: jobs.length })}
      tip={t('终止：结束命令和它起的所有子进程，并告诉 Agent 这是你手动终止的')}
      compact={compact}
      withText={withText}
    />
  )
}
