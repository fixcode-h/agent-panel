import { t } from '@shared/i18n'
import { experienceApi } from '@/lib/api-experience'
import { toast, toastError } from '@/lib/toast'

/** 正在学的对话：学一次要调模型几十秒，这期间再点不重复发 */
const running = new Set<string>()

/**
 * 对话标题栏「立即学经验」（server/experience/learn.ts 的手动学）：不等自动学习，现在就从这段对话里提炼。
 * 学到的条目、失败的原因由服务端写进对话（经验卡片、警告行），这里只弹一句结论
 */
export function learnNow(taskId: string) {
  if (running.has(taskId)) {
    toast.info(t('正在学，学完会写进对话'))
    return
  }
  running.add(taskId)
  toast.info(t('正在从这段对话里学经验，要调一次模型，稍等'))
  void experienceApi
    .learnNow(taskId)
    .then((r) => {
      if (r.result === 'learned') toast.success(r.message)
      else if (r.result === 'error') toast.error(r.message)
      else toast.info(r.message)
    })
    .catch(toastError)
    .finally(() => running.delete(taskId))
}
