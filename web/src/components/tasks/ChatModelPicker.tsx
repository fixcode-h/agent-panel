import { Check, ChevronDown } from 'lucide-react'
import { agentRun, defaultSettings } from '@shared/settings'
import { defaultAgent } from '@shared/schema'
import { useData } from '@/lib/data'
import { useCliDef } from '@/lib/cli-models'
import { defaultEffortOptions } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { modelOptions } from '@/components/agents/ModelSelect'
import { t } from '@shared/i18n'

type Opt = { value: string; label: string; group?: string }

/** 输入框里的小下拉：按钮上只显示选中项，展开是分组的列表 */
function ChipSelect({
  value,
  options,
  onChange,
  title,
  className,
}: {
  value: string
  options: Opt[]
  onChange: (v: string) => void
  title: string
  className?: string
}) {
  const cur = options.find((o) => o.value === value) ?? options[0]
  // 按钮上不要「（默认）」后缀，太长；列表里还标着
  const text = (cur?.label ?? '').replace(/（默认）$| \(default\)$/, '')
  return (
    <Popover>
      <PopoverTrigger
        title={title}
        aria-label={title}
        className={cn(
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1 rounded-lg px-2 font-mono text-[12px] text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel',
          className,
        )}
      >
        <span className="truncate">{text}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-[300px]" align="start">
        <div className="max-h-80 overflow-y-auto">
          {options.map((o, i) => (
            <div key={o.value + i}>
              {o.group && o.group !== options[i - 1]?.group && (
                <p className="px-2.5 pt-2 pb-1 text-[11px] text-subtle">{o.group}</p>
              )}
              <PopoverClose className={menuItem} onClick={() => onChange(o.value)}>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{o.label}</span>
                {o.value === value && <Check className="h-4 w-4 shrink-0 text-accent" />}
              </PopoverClose>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * 对话时给默认 Agent 临时选模型和思考强度：选项来自默认 CLI（本机 CLI 读到的模型和它支持的强度），
 * 留空就是默认 CLI 设置里的默认值。
 */
export function ChatModelPicker({
  model,
  effort,
  onChange,
}: {
  model: string
  effort: string
  onChange: (v: { model: string; effort: string }) => void
}) {
  const { settings } = useData()
  const s = settings ?? defaultSettings()
  const base = agentRun(defaultAgent(), s)
  const def = useCliDef(base.cli)
  if (!def) return null
  const run = agentRun({ ...defaultAgent(), model, effort }, s)
  const models = modelOptions(def, { defaultValue: base.model, extra: model ? [model] : [] })
  // 思考强度的默认值跟着当前模型走：换了模型，模型自己的默认强度可能不同
  const modelDefault = def.models.find((m) => m.id === run.model)?.defaultEffort
  const efforts = def.efforts.length ? defaultEffortOptions(def, model ? modelDefault || base.effort : base.effort) : []
  return (
    <div className="flex min-w-0 items-center">
      <ChipSelect
        title={t('模型')}
        value={model === base.model ? '' : model}
        options={models}
        onChange={(m) => onChange({ model: m, effort })}
        className="max-w-[200px]"
      />
      {efforts.length > 0 && (
        <ChipSelect
          title={t('思考强度')}
          value={efforts.some((e) => e.value === effort) ? effort : ''}
          options={efforts}
          onChange={(e) => onChange({ model, effort: e })}
          className="max-w-[140px]"
        />
      )}
    </div>
  )
}
