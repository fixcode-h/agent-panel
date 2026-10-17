import { Check, ChevronDown } from 'lucide-react'
import { agentRun, defaultSettings } from '@shared/settings'
import type { CliDefinition } from '@shared/clis'
import { useData } from '@/lib/data'
import { useCliDef } from '@/lib/cli-models'
import { cliColor, defaultEffortOptions } from '@/lib/cli-style'
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
  dot,
}: {
  value: string
  options: Opt[]
  onChange: (v: string) => void
  title: string
  className?: string
  /** 选项前的色块（选 CLI 时用 CLI 的颜色） */
  dot?: (value: string) => string
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
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel',
          !dot && 'font-mono',
          className,
        )}
      >
        {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(cur?.value ?? '') }} />}
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
                {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(o.value) }} />}
                <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', !dot && 'font-mono')}>{o.label}</span>
                {o.value === value && <Check className="h-4 w-4 shrink-0 text-accent" />}
              </PopoverClose>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export type ChatRun = { cli: string; model: string; effort: string }

/**
 * 对话用的 CLI、模型和思考强度，空值换成实际会用的默认值：
 * CLI 默认是设置里的默认 CLI；模型、思考强度先取这个 CLI 设置里的默认，
 * 没设置时取 CLI 自己标的默认模型和这个模型的默认强度，下拉里总是显示真实的值。
 */
export function useChatRun(pick: ChatRun) {
  const { settings, clis } = useData()
  const s = settings ?? defaultSettings()
  // 只列能用的：装好了而且没在设置里停用
  const usable = clis.filter((c) => c.installed && c.enabled)
  const defCli = (usable.find((c) => c.isDefault) ?? usable[0])?.id ?? ''
  const cli = usable.some((c) => c.id === pick.cli) ? pick.cli : defCli
  const def = useCliDef(cli || undefined)
  const base = agentRun({ cli, model: '', effort: '' }, s)
  const defModel = base.model || def?.models.find((m) => m.isDefault)?.id || def?.models[0]?.id || ''
  const model = pick.model || defModel
  const defEffort = def ? effortDefault(def, model, model === defModel ? base.effort : '') : ''
  const effort = def?.efforts.some((e) => e.id === pick.effort) ? pick.effort : defEffort
  return { usable, defCli, cli, def, defModel, defEffort, run: { cli, model, effort } }
}

/** 模型的默认思考强度：CLI 设置里的、模型自己标的，都没有时取中间那档 */
function effortDefault(def: CliDefinition, model: string, configured: string) {
  if (!def.efforts.length) return ''
  const ids = def.efforts.map((e) => e.id)
  const own = def.models.find((m) => m.id === model)?.defaultEffort
  for (const e of [configured, own, 'medium']) if (e && ids.includes(e)) return e
  return ids[Math.floor(ids.length / 2)]
}

/** 对话时选 CLI、模型和思考强度；都是实际的值，默认的标「（默认）」 */
export function ChatModelPicker({ value, onChange }: { value: ChatRun; onChange: (v: ChatRun) => void }) {
  const { usable, defCli, cli, def, defModel, defEffort, run } = useChatRun(value)
  if (!usable.length) return <span className="px-2 text-[12px] text-subtle">{t('没有可用的 CLI')}</span>
  const clisOpts = usable.map((c) => ({
    value: c.id,
    label: c.id === defCli ? t('{name}（默认）', { name: c.name }) : c.name,
  }))
  const models = def ? modelOptions(def, { defaultValue: defModel, extra: [run.model] }) : []
  const efforts = def?.efforts.length ? defaultEffortOptions(def, defEffort) : []
  return (
    <div className="flex min-w-0 items-center">
      <ChipSelect
        title={t('对话用的 CLI')}
        value={cli}
        options={clisOpts}
        // 换了 CLI，模型和思考强度回到那个 CLI 的默认
        onChange={(c) => onChange({ cli: c, model: '', effort: '' })}
        dot={cliColor}
        className="max-w-[160px]"
      />
      {models.length > 0 && (
        <ChipSelect
          title={t('模型')}
          value={run.model === defModel ? '' : run.model}
          options={models}
          // 换了模型，思考强度回到这个模型的默认
          onChange={(m) => onChange({ ...value, cli, model: m, effort: '' })}
          className="max-w-[200px]"
        />
      )}
      {efforts.length > 0 && (
        <ChipSelect
          title={t('思考强度')}
          value={run.effort === defEffort ? '' : run.effort}
          options={efforts}
          onChange={(e) => onChange({ ...value, cli, effort: e })}
          className="max-w-[160px]"
        />
      )}
    </div>
  )
}
