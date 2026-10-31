import { useEffect } from 'react'
import { outcomeOf } from '@shared/schedule'
import type { Schedule } from '@shared/schedule'
import { t } from '@shared/i18n'
import { api } from './api'
import { useNav } from './data'
import { notifyEnabled } from './notify'
import { toast } from './toast'

const SEEN_KEY = 'schedule-alerts-seen'
/** 隔多久再看一次计划：错过和启动失败不需要秒级发现，前台标签页才查 */
const POLL_MS = 5 * 60_000

/** 一次「出问题」的身份：同一个计划同一次错过 / 失败只提醒一次，下一次出问题再提醒 */
const keyOf = (s: Schedule) => {
  const o = outcomeOf(s)
  if (o === 'missed') return `${s.id}:missed:${s.missedAt}`
  if (o === 'blocked') return `${s.id}:blocked:${s.blockedAt}`
  if (o === 'error') return `${s.id}:error:${s.lastError}`
  return ''
}

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
function writeSeen(keys: Set<string>) {
  try {
    // 只留最近的一批，免得无限长
    localStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-200)))
  } catch {}
}

/**
 * 计划错过、启动失败、上游没成功时提醒用户。以前只在计划页留一个徽标：
 * 面板没开着的时候错过的计划，用户不去计划页就一直不知道。
 * 打开面板时查一次，之后前台每 5 分钟查一次；有浏览器通知权限且标签页在后台时也发系统通知
 */
export function useScheduleAlerts() {
  const { go } = useNav()
  useEffect(() => {
    if (import.meta.env.VITE_DEMO) return
    let stopped = false
    const check = async () => {
      if (document.hidden) return
      const list = await api.schedules().catch(() => null)
      if (!list || stopped) return
      const seen = readSeen()
      const fresh = list.filter((s) => s.enabled && keyOf(s) && !seen.has(keyOf(s)))
      if (!fresh.length) return
      for (const s of fresh) seen.add(keyOf(s))
      writeSeen(seen)
      const names = fresh.map((s) => `「${s.name}」`).join('、')
      const text =
        fresh.length === 1
          ? outcomeOf(fresh[0]) === 'error'
            ? t('计划{names}没能启动：{error}', { names, error: fresh[0].lastError })
            : t('计划{names}到点时没有执行（面板没在运行或上游没成功）', { names })
          : t('{n} 个计划出了问题：{names}', { n: fresh.length, names })
      toast.warning(text, { action: { label: t('查看'), onClick: () => go({ page: 'schedules' }) } })
      if (notifyEnabled() && document.hidden) new Notification(t('计划出了问题'), { body: text })
    }
    void check()
    const timer = setInterval(() => void check(), POLL_MS)
    const onVisible = () => !document.hidden && void check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [go])
}
