import type { ReactNode } from 'react'
import { Brain, Check, ChevronDown, Sparkles } from 'lucide-react'
import { agentRun, cliSettings, defaultSettings } from '@shared/settings'
import { getCli, type CliDefinition } from '@shared/clis'
import { apiModelIdFor } from '@shared/accounts'
import { apiModelKey } from '@shared/model-catalog'
import { useData } from '@/lib/data'
import { useCliDef } from '@/lib/cli-models'
import { cliColor, defaultEffortOptions, effortValue, modelEfforts } from '@/lib/cli-style'
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
  icon,
}: {
  value: string
  options: Opt[]
  onChange: (v: string) => void
  title: string
  className?: string
  /** 选项前的色块（选 CLI 时用 CLI 的颜色） */
  dot?: (value: string) => string
  /** 按钮上选中项前的图标（思考强度用大脑） */
  icon?: (value: string) => ReactNode
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
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-footnote text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel',
          !dot && 'font-mono',
          className,
        )}
      >
        {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(cur?.value ?? '') }} />}
        {icon?.(cur?.value ?? '')}
        <span className="truncate">{text}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      {/* 列表按最长的选项自适应宽度，太长时才截断 */}
      <PopoverContent className="w-max max-w-[min(560px,calc(100vw-24px))] min-w-[220px]" align="start">
        <div className="max-h-80 overflow-y-auto">
          {options.map((o, i) => (
            <div key={o.value + i}>
              {o.group && o.group !== options[i - 1]?.group && (
                <p className="px-2.5 pt-2 pb-1 text-caption text-subtle">{o.group}</p>
              )}
              {/* 行距和设置里的下拉框一样 */}
              <PopoverClose className={cn(menuItem, 'gap-2 py-1.5')} onClick={() => onChange(o.value)}>
                {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(o.value) }} />}
                <span className={cn('min-w-0 flex-1 truncate text-footnote', !dot && 'font-mono')}>{o.label}</span>
                {o.value === value && <Check className="h-4 w-4 shrink-0 text-accent-text" />}
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
  const cs = cliSettings(s, cli)
  const picked = apiModelIdFor(pick.model, getCli(cli)?.auth, cs.api)
  const defModel = base.model || def?.models.find((m) => m.isDefault)?.id || def?.models[0]?.id || ''
  // API 方式只认 API 里配的模型：任务里以前存的模型不在列表里时回到默认
  const model = def?.apiMode && picked && !def.models.some((m) => m.id === picked) ? defModel : picked || defModel
  const efforts = def ? modelEfforts(def, model) : []
  const defEffort = def ? effortDefault(def, model, model === defModel ? base.effort : '') : ''
  // 换成别的模型后旧强度可能不适用（CLI 会直接报错退出），回到这个模型的默认
  const effort = efforts.some((e) => e.id === pick.effort) ? pick.effort : defEffort
  return { usable, defCli, cli, def, defModel, defEffort, run: { cli, model, effort } }
}

/** 模型的默认思考强度：CLI 设置里的、模型自己标的，都没有时取中间那档（只看这个模型支持的） */
function effortDefault(def: CliDefinition, model: string, configured: string) {
  const ids = modelEfforts(def, model).map((e) => e.id)
  if (!ids.length) return ''
  const own = def.models.find((m) => m.id === model)?.defaultEffort
  for (const e of [configured, own, 'medium']) if (e && ids.includes(e)) return e
  return ids[Math.floor(ids.length / 2)]
}

/** 对话里一条回复的署名：CLI 名字，模型和思考强度（没记模型时是 CLI 自己的默认模型） */
export function useRunAuthor(run: ChatRun | undefined) {
  const def = useCliDef(run?.cli || undefined)
  if (!run || !def) return undefined
  const model = run.model || def.models.find((m) => m.isDefault)?.id || ''
  return {
    name: def.name,
    cli: def.id,
    icon: 'sparkles',
    // 强度只显示 CLI 的英文取值
    model: [model, run.effort].filter(Boolean).join(' · '),
  }
}

/** 对话时选 CLI、模型和思考强度；模型默认的那项标「（默认）」，强度只显示 CLI 的英文取值 */
export function ChatModelPicker({ value, onChange }: { value: ChatRun; onChange: (v: ChatRun) => void }) {
  const { usable, defCli, cli, def, defModel, defEffort, run } = useChatRun(value)
  if (!usable.length) return <span className="px-2 text-footnote text-subtle">{t('没有可用的 Agent')}</span>
  const clisOpts = usable.map((c) => ({
    value: c.id,
    label: c.id === defCli ? t('{name}（默认）', { name: c.name }) : c.name,
  }))
  const models = def ? modelOptions(def, { defaultValue: defModel, extra: [run.model] }) : []
  // 只列这个模型支持的强度；一个都不支持（模型不能思考）时不显示这一项
  const efforts = def ? defaultEffortOptions(def, defEffort, modelEfforts(def, run.model)) : []
  return (
    <div className="flex min-w-0 items-center">
      <ChipSelect
        title={t('对话用的 Agent')}
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
      {efforts.length > 1 && (
        <ChipSelect
          title={t('思考强度')}
          value={effortValue(def!, defEffort, modelEfforts(def!, run.model), run.effort)}
          options={efforts}
          onChange={(e) => onChange({ ...value, cli, effort: e })}
          icon={(e) => <EffortIcon effort={e} />}
          className="max-w-[160px]"
        />
      )}
    </div>
  )
}

/** 角色实际用的思考强度（英文档位 id）：回复头「· 模型 · 强度」用，和执行时同一个取值（agentRun） */
export function useEffortOf() {
  const { settings } = useData()
  const s = settings ?? defaultSettings()
  return (a: { cli: string; model: string; effort?: string }) => {
    const r = agentRun(a, s)
    // 和输入框上的模型按钮一致：强度写英文档位 id
    return effortShort(r.effort)
  }
}

/** 思考强度前的大脑图标：关掉思考时变灰，开着的各档都用强调色（具体档位看旁边的字） */
function EffortIcon({ effort }: { effort: string }) {
  return (
    <Brain
      aria-hidden
      className={cn('h-3.5 w-3.5 shrink-0', effort === 'off' ? 'text-subtle' : 'text-accent')}
      strokeWidth={2.2}
    />
  )
}

/** 模型按钮上的那一串：星芒图标 + 加粗模型名 + 大脑图标 + 强度字（输入框工具条、只读的角色模型共用） */
function ModelFace({ model, effort }: { model: string; effort: string }) {
  return (
    <>
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={2.2} />
      <span className="min-w-0 truncate font-semibold text-fg">{model}</span>
      {effort && (
        <>
          <EffortIcon effort={effort} />
          <span className="shrink-0 text-subtle">{effortShort(effort)}</span>
        </>
      )}
    </>
  )
}

const FACE =
  'inline-flex h-[1.875rem] max-w-[220px] min-w-0 shrink items-center gap-[7px] rounded-lg pr-1.5 pl-2 text-body'

/**
 * 输入框和角色徽标上显示的模型名：CLI 走 API 且这个模型在 API 设置里配了映射时显示映射到的模型
 * （用户想看实际在用的是哪个模型），名字只留最后一个「/」后面那段（provider 前缀太长、挤掉强度）
 */
function useShownModel() {
  const { settings } = useData()
  return (cli: string, model: string, fallback: string) => {
    const cs = settings?.clis?.[cli]
    const api = cs?.authMode === 'api' ? settings?.apis.find((a) => a.id === cs.apiId) : undefined
    const mapped = (model && api?.modelMap?.[apiModelKey(model, api.modelMap)]) || ''
    const name = mapped || fallback
    return name.slice(name.lastIndexOf('/') + 1) || name
  }
}

/** 强度在按钮上的写法：用英文档位 id（low / medium / high…），比中文档位名短，各 CLI 的叫法也一致 */
const effortShort = (id: string) => id

/** 模型的显示名：CLI 列表里有就用它的名字，没有用模型 id */
function modelName(def: CliDefinition | undefined, id: string) {
  return def?.models.find((m) => m.id === id)?.label || id || t('默认模型')
}

/**
 * 用角色的对话：模型和思考强度跟着角色设置，输入框里只读显示（和可选的那个同一个样子，没有下拉箭头）
 */
export function RoleModelBadge({ agent }: { agent: { cli: string; model: string; effort?: string } }) {
  const { settings } = useData()
  const r = agentRun(agent, settings ?? defaultSettings())
  const def = useCliDef(r.cli || undefined)
  const shownModel = useShownModel()
  if (!r.cli) return null
  const name = shownModel(r.cli, r.model, modelName(def, r.model))
  // 角色和 CLI 设置都没指定强度时 CLI 用模型自己的默认档：照样显示出来，不留空
  const effort = r.effort || def?.models.find((m) => m.id === r.model)?.defaultEffort || ''
  return (
    <span
      className={FACE}
      title={t('模型和思考强度跟着角色设置：{model}', { model: [r.model, effort].filter(Boolean).join(' · ') })}
    >
      <ModelFace model={name} effort={effort} />
    </span>
  )
}
