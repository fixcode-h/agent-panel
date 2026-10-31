import { useEffect, useState } from 'react'
import { Unplug } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { markOnline, trackedFetch, useOffline } from '@/lib/connection'

/** 断开后多久探一次服务：面板重启通常几秒就回来 */
const RETRY_MS = 3000

/**
 * 连不上面板服务时的顶部提示。面板进程退出、重启、更新时，页面上的数据会停在最后一刻，
 * 不提示的话用户会以为对话卡住了、点按钮也没反应。断开期间自己定时探测，连上就消失
 */
export function ConnectionBanner() {
  const offline = useOffline()
  const [checking, setChecking] = useState(false)
  const probe = async () => {
    setChecking(true)
    try {
      const res = await trackedFetch('/api/health', { cache: 'no-store' })
      if (res.ok) markOnline()
    } catch {
      // trackedFetch 已经记成断开，等下一次
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    if (!offline) return
    const timer = setInterval(() => void probe(), RETRY_MS)
    return () => clearInterval(timer)
    // probe 每次渲染都是新函数，只看断开状态起停定时器
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [offline])
  if (!offline) return null
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-danger/8 px-4 py-2 text-body text-fg"
    >
      <Unplug className="h-4 w-4 shrink-0 text-danger" strokeWidth={2.2} />
      <span className="min-w-0 flex-1">
        <b className="font-medium">{t('连不上面板服务')}</b>
        <span className="text-subtle">{t('：页面上的内容可能不是最新的，操作也不会生效。面板重启后会自动重连。')}</span>
      </span>
      <Button variant="link" disabled={checking} onClick={() => void probe()}>
        {checking ? t('正在重连…') : t('立即重连')}
      </Button>
    </div>
  )
}
