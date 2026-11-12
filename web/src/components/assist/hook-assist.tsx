import { useEffect, useState } from 'react'
import { CircleAlert, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { HookDefInput } from '@shared/hooks/defs'
import { t } from '@shared/i18n'
import { hooksApi } from '@/lib/api-hooks'
import { Badge } from '@/components/ui/badge'
import { eventLabel } from '@/components/settings/hook-labels'

/**
 * AI 创建钩子（ADR 0049 第二期）：对话框里的文案、例子和右侧预览。从 AssistDialog.tsx 拆出来：那个文件快到行数上限。
 * 预览打开就把提案交给服务端校验并试跑一次（语法、密钥、字段搭配、示例输入跑得通），全部通过才让保存
 */
export const hookAssistText = () => ({
  create: t('用 AI 创建钩子'),
  desc: t('本机 Agent 按钩子规范写出定义和脚本，校验、试跑都通过才能保存；保存后默认关着，看过再打开'),
  intro: t('说说想在什么时候做什么，例如：'),
  placeholder: t('描述你想要的钩子'),
  empty: t('生成的钩子会显示在这里'),
  button: t('保存钩子'),
})

export const hookExamples = () => [
  t('只读的评审角色不许跑 git commit'),
  t('改完 .ts 文件提醒模型跑类型检查'),
  t('对话要结束时，如果计划还有没做完的步骤就拦住'),
]

export function HookPreview({ hook, onCheck }: { hook: HookDefInput; onCheck: (ok: boolean) => void }) {
  const [state, setState] = useState<{ errors: string[]; warnings: string[] } | null>(null)
  useEffect(() => {
    let alive = true
    setState(null)
    onCheck(false)
    hooksApi
      .check(hook, true)
      .then((r) => {
        if (!alive) return
        setState(r)
        onCheck(!r.errors.length)
      })
      .catch((e: Error) => alive && setState({ errors: [e.message], warnings: [] }))
    return () => {
      alive = false
    }
    // 提案换了才重新校验；onCheck 是父组件的 setState，引用稳定
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(hook)])
  const a = hook.action
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-title font-medium">{hook.name}</h3>
        <Badge>{eventLabel(hook.event)}</Badge>
        <Badge tone="neutral">{a.type === 'command' ? t('运行脚本') : t('发 HTTP 请求')}</Badge>
      </div>
      {hook.description && <p className="text-body text-muted">{hook.description}</p>}
      {!state ? (
        <p className="flex items-center gap-1.5 text-body text-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('正在校验并试跑一次…')}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {!state.errors.length && (
            <p className="flex items-center gap-1.5 text-body text-success">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('校验和试跑都通过了')}
            </p>
          )}
          {state.errors.map((e) => (
            <p key={e} className="flex items-start gap-1.5 text-body text-danger">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {e}
            </p>
          ))}
          {state.warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-body text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {w}
            </p>
          ))}
        </div>
      )}
      {a.type === 'command' ? (
        <pre className="max-h-[420px] overflow-auto rounded-lg border bg-field p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
          {a.script}
        </pre>
      ) : (
        <p className="font-mono text-xs break-all">{a.url}</p>
      )}
    </div>
  )
}
