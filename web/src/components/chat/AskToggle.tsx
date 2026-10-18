import { useEffect, useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import type { TaskRequest } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useScopedSetting } from '@/lib/useScopedSetting'
import { RequestCard } from '@/components/tasks/RequestCard'
import { t } from '@shared/i18n'

/**
 * 「提问」开关，所有 AI 会话的输入框上都有：打开时 AI 有问题会弹出卡片问你，它等你回答；
 * 关着时让 AI 自己选最合适的做法接着做。审批（命令、改文件）不受它影响，按设置里的权限决定要不要你确认
 */
export function AskToggle({
  value,
  onChange,
  className,
}: {
  value: boolean
  onChange: (v: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      aria-label={t('AI 有问题时问我')}
      title={
        value
          ? t('AI 有问题时会问你，等你回答再继续（点一下改成让 AI 自己选）')
          : t('AI 有问题时自己选最合适的做法（点一下改成问你）')
      }
      className={cn(
        'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors',
        value ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-sel hover:text-fg',
        className,
      )}
    >
      <MessageCircleQuestion className="h-4 w-4" />
    </button>
  )
}

/** 每个会话各自记住「提问」开关；新会话沿用上次的选择 */
export function useAskUser(scope: string) {
  return useScopedSetting<boolean>(
    'ask-user',
    scope,
    (raw) => raw === '1',
    (v) => (v ? '1' : '0'),
  )
}

/**
 * 任务页以外的会话在等你处理的审批和提问：执行中定时取回来，贴在输入框上方。
 * active 为 false（没在执行）时不取，也不显示
 */
export function ScopeRequests({ scope, active, className }: { scope: string; active: boolean; className?: string }) {
  const [list, setList] = useState<TaskRequest[]>([])
  useEffect(() => {
    if (!active) {
      setList([])
      return
    }
    let stop = false
    const load = () =>
      api
        .asks(scope)
        .then((l) => !stop && setList(l))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 1200)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [scope, active])
  return (
    <RequestCard
      requests={list}
      className={className}
      onAnswer={async (id, r) => {
        await api.answerAsk(id, r)
        setList((l) => l.filter((x) => x.id !== id))
      }}
    />
  )
}
