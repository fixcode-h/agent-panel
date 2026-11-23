import { useEffect, useState } from 'react'
import { t, uiLocale } from '@shared/i18n'
import { fileIndexPhase, useFileIndexStatus } from '@/lib/live/file-index-status'
import { useNav } from '@/lib/data'
import { BackgroundStatus } from '@/components/ui/background-status'

/** 核对很快（通常一两秒）：超过这么久还在核对才显示，免得每次定时核对都闪一下 */
const VERIFY_SHOW_MS = 1500

/** 3.2 万 / 32K：按界面语言的简写 */
const fmt = (n: number) =>
  new Intl.NumberFormat(uiLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n)

/**
 * 侧栏底部的文件索引状态（用户 2026-11-23）：建立中、核对得久、出错时出现，就绪就不显示。
 * 阶段和项目设置的状态卡用同一个 fileIndexPhase：卡片写核对中时这里才会写正在核对，核对完两处一起收
 * 点一下打开项目设置的文件索引那一块。状态跟着推送走（useFileIndexStatus），不轮询
 */
export function FileIndexSidebarStatus({ projectId }: { projectId: string }) {
  const { openProject } = useNav()
  const [s] = useFileIndexStatus(projectId)
  const phase = fileIndexPhase(s)
  const verifying = phase === 'checking'
  const [slowVerify, setSlowVerify] = useState(false)
  useEffect(() => {
    setSlowVerify(false)
    if (!verifying) return
    const timer = setTimeout(() => setSlowVerify(true), VERIFY_SHOW_MS)
    return () => clearTimeout(timer)
  }, [verifying])

  if (!s || phase === 'off' || phase === 'ready') return null
  const open = () => openProject(projectId, 'general', 'file-index')
  if (phase === 'error') return <BackgroundStatus error label={t('文件索引出错，点开看原因')} onClick={open} />
  if (phase === 'building') {
    const p = s.roots.find((r) => r.progress)?.progress
    const files = p?.files ?? s.files
    return (
      <BackgroundStatus
        label={t('正在建立文件索引')}
        detail={
          p?.expect ? `${Math.min(99, Math.round((p.dirs / p.expect) * 100))}%` : t('{n} 个文件', { n: fmt(files) })
        }
        value={p?.dirs}
        max={p?.expect}
        onClick={open}
      />
    )
  }
  if (verifying && slowVerify) return <BackgroundStatus label={t('正在核对文件索引')} onClick={open} />
  return null
}
