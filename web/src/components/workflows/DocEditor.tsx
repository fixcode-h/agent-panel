import { useRef, useState } from 'react'
import { AtSign, Eye, FileText, PencilLine } from 'lucide-react'
import type { Agent } from '@shared/schema'
import { t } from '@shared/i18n'
import { renderDoc } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { AgentAvatar } from '@/components/agents/AgentAvatar'

/** 工作流说明、Agent 角色设定：Markdown 编辑 / 预览，可以插入模板和 @Agent */
export function DocEditor({
  value,
  onChange,
  team,
  onTemplate,
  label = t('工作流说明'),
  placeholder = t('用 Markdown 写清楚目标、规范和完成标准。\n不知道怎么写可以先点右上角「插入模板」。'),
  mentionHint = t('在光标处插入 Agent 名称'),
  onMention,
  tools,
  minHeight = 420,
}: {
  value: string
  onChange: (v: string) => void
  team: Agent[]
  onTemplate: () => string
  label?: string
  placeholder?: string
  mentionHint?: string
  /** 插入 @Agent 之后（Agent 角色设定里用来顺便引入它） */
  onMention?: (a: Agent) => void
  /** 工具栏上额外的按钮；insert 在光标处插入文字 */
  tools?: (insert: (text: string) => void) => React.ReactNode
  minHeight?: number
}) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const ref = useRef<HTMLTextAreaElement>(null)

  const insert = (text: string) => {
    const el = ref.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    onChange(value.slice(0, start) + text + value.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  const tab = (m: typeof mode, label: string, Icon: typeof Eye) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium',
        mode === m ? 'bg-card text-fg shadow-card ring-1 ring-line-strong' : 'text-muted hover:text-fg',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )

  return (
    <div className="overflow-hidden rounded-xl border border-line-strong bg-field">
      <div className="flex flex-wrap items-center gap-2 border-b bg-panel px-2 py-2">
        <div className="flex rounded-lg bg-field p-0.5 ring-1 ring-line">
          {tab('edit', t('编辑'), PencilLine)}
          {tab('preview', t('预览'), Eye)}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {mode === 'edit' && tools?.(insert)}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" disabled={mode !== 'edit' || team.length === 0}>
                <AtSign className="h-3.5 w-3.5" />
                {t('引用 Agent')}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="max-h-80 w-[240px] overflow-y-auto">
              <div className="px-2.5 pt-1 pb-1.5 text-xs text-subtle">{mentionHint}</div>
              {team.map((a) => (
                <PopoverClose
                  key={a.id}
                  className={menuItem}
                  onClick={() => {
                    insert(`@${a.name} `)
                    onMention?.(a)
                  }}
                >
                  <AgentAvatar icon={a.icon} cli={a.cli} size="sm" />
                  {a.name}
                </PopoverClose>
              ))}
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            disabled={mode !== 'edit'}
            onClick={() => (value.trim() ? insert(`\n${onTemplate()}`) : onChange(onTemplate()))}
          >
            <FileText className="h-3.5 w-3.5" />
            {t('插入模板')}
          </Button>
        </div>
      </div>
      {mode === 'edit' ? (
        <textarea
          ref={ref}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ minHeight }}
          className={cn(
            fieldClass,
            'block resize-y rounded-none border-0 py-3 font-mono text-[0.8125rem] leading-[1.75] focus:ring-0',
          )}
        />
      ) : (
        <div className="doc-preview px-5 py-4" style={{ minHeight }}>
          {value.trim() ? (
            <div dangerouslySetInnerHTML={{ __html: renderDoc(value, new Set(team.map((a) => a.name))) }} />
          ) : (
            <p className="text-subtle">{t('文档还是空的。')}</p>
          )}
        </div>
      )}
    </div>
  )
}
