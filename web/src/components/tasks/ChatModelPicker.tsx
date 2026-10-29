import { Check, ChevronDown, Sparkles } from 'lucide-react'
import { agentRun, cliSettings, defaultSettings } from '@shared/settings'
import { getCli, type CliDefinition } from '@shared/clis'
import { apiModelIdFor } from '@shared/accounts'
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
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[0.75rem] text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel',
          !dot && 'font-mono',
          className,
        )}
      >
        {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(cur?.value ?? '') }} />}
        <span className="truncate">{text}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      {/* 列表按最长的选项自适应宽度，太长时才截断 */}
      <PopoverContent className="w-max max-w-[min(560px,calc(100vw-24px))] min-w-[220px]" align="start">
        <div className="max-h-80 overflow-y-auto">
          {options.map((o, i) => (
            <div key={o.value + i}>
              {o.group && o.group !== options[i - 1]?.group && (
                <p className="px-2.5 pt-2 pb-1 text-[0.6875rem] text-subtle">{o.group}</p>
              )}
              {/* 行距和设置里的下拉框一样 */}
              <PopoverClose className={cn(menuItem, 'gap-2 py-1.5')} onClick={() => onChange(o.value)}>
                {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(o.value) }} />}
                <span className={cn('min-w-0 flex-1 truncate text-[0.75rem]', !dot && 'font-mono')}>{o.label}</span>
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
export function ChatModelPicker({
  value,
  onChange,
  parts = 'all',
}: {
  value: ChatRun
  onChange: (v: ChatRun) => void
  /**
   * 只画其中一段：Chat 页标题栏放「Agent · 模型」（run），输入框里只留思考强度（effort）（Chat.dc.html）；
   * 不给时三个都画
   */
  parts?: 'all' | 'run' | 'effort'
}) {
  const { usable, defCli, cli, def, defModel, defEffort, run } = useChatRun(value)
  if (!usable.length)
    return parts === 'effort' ? null : <span className="px-2 text-[0.75rem] text-subtle">{t('没有可用的 Agent')}</span>
  const showRun = parts !== 'effort'
  const showEffort = parts !== 'run'
  const clisOpts = usable.map((c) => ({
    value: c.id,
    label: c.id === defCli ? t('{name}（默认）', { name: c.name }) : c.name,
  }))
  const models = def ? modelOptions(def, { defaultValue: defModel, extra: [run.model] }) : []
  // 只列这个模型支持的强度；一个都不支持（模型不能思考）时不显示这一项
  const efforts = def ? defaultEffortOptions(def, defEffort, modelEfforts(def, run.model)) : []
  return (
    <div className="flex min-w-0 items-center">
      {showRun && (
        <ChipSelect
          title={t('对话用的 Agent')}
          value={cli}
          options={clisOpts}
          // 换了 CLI，模型和思考强度回到那个 CLI 的默认
          onChange={(c) => onChange({ cli: c, model: '', effort: '' })}
          dot={cliColor}
          className="max-w-[160px]"
        />
      )}
      {showRun && models.length > 0 && (
        <ChipSelect
          title={t('模型')}
          value={run.model === defModel ? '' : run.model}
          options={models}
          // 换了模型，思考强度回到这个模型的默认
          onChange={(m) => onChange({ ...value, cli, model: m, effort: '' })}
          className="max-w-[200px]"
        />
      )}
      {showEffort && efforts.length > 1 && (
        <ChipSelect
          title={t('思考强度')}
          value={effortValue(def!, defEffort, modelEfforts(def!, run.model), run.effort)}
          options={efforts}
          onChange={(e) => onChange({ ...value, cli, effort: e })}
          className="max-w-[160px]"
        />
      )}
    </div>
  )
}

/** 思考强度的显示名（「高」「很高」）：CLI 定义里没有这一档时原样写取值 */
export function effortName(cli: string, id: string) {
  if (!id) return ''
  return getCli(cli)?.efforts.find((e) => e.id === id)?.label ?? id
}

/** 角色实际用的思考强度的显示名：回复头「· 模型 · 强度」用，和执行时同一个取值（agentRun） */
export function useEffortOf() {
  const { settings } = useData()
  const s = settings ?? defaultSettings()
  return (a: { cli: string; model: string; effort?: string }) => {
    const r = agentRun(a, s)
    return effortName(r.cli, r.effort)
  }
}

/**
 * 强度条亮几格（共三格）：按这一档在 CLI 强度列表里的位置折算，关掉思考是 0 格；
 * 不按名字判断（各 CLI 的档位名不一样）
 */
function effortBars(cli: string, id: string) {
  const ids = getCli(cli)?.efforts.map((e) => e.id) ?? []
  const i = ids.indexOf(id)
  if (!id || i < 0) return 0
  if (id === 'off') return 0
  const on = ids.filter((x) => x !== 'off')
  return Math.max(1, Math.ceil(((on.indexOf(id) + 1) / on.length) * 3))
}

/** 三格强度条（设计稿）：由低到高三根，亮着的用强调色 */
function EffortBars({ n }: { n: number }) {
  return (
    <span aria-hidden className="inline-flex h-[11px] items-end gap-0.5">
      {[5, 8, 11].map((h, i) => (
        <span
          key={h}
          className={cn('w-[3px] rounded-[1px]', i < n ? 'bg-accent' : 'bg-line-strong')}
          style={{ height: h }}
        />
      ))}
    </span>
  )
}

/** 模型按钮上的那一串：星芒图标 + 加粗模型名 + 强度条 + 强度字（输入框工具条、只读的角色模型共用） */
function ModelFace({ model, cli, effort }: { model: string; cli: string; effort: string }) {
  return (
    <>
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
      <span className="min-w-0 truncate font-semibold text-fg">{model}</span>
      {effort && (
        <>
          <EffortBars n={effortBars(cli, effort)} />
          <span className="shrink-0 text-subtle">{effortName(cli, effort)}</span>
        </>
      )}
    </>
  )
}

const FACE =
  'inline-flex h-[1.875rem] max-w-[220px] min-w-0 shrink items-center gap-[7px] rounded-lg pr-1.5 pl-2 text-[0.78125rem]'

/** 模型的显示名：CLI 列表里有就用它的名字，没有用模型 id */
function modelName(def: CliDefinition | undefined, id: string) {
  return def?.models.find((m) => m.id === id)?.label || id || t('默认模型')
}

/**
 * 输入框工具条里的模型和思考强度（设计稿）：一个无底按钮，悬停浅底；点开是分组列表——
 * Agent（不用角色的对话才能换）、模型、思考强度。effort 时只列思考强度（Chat 页的 Agent 和模型在标题栏）
 */
export function ComposerModelPicker({
  value,
  onChange,
  parts = 'all',
}: {
  value: ChatRun
  onChange: (v: ChatRun) => void
  parts?: 'all' | 'effort'
}) {
  const { usable, defCli, cli, def, defModel, defEffort, run } = useChatRun(value)
  if (!usable.length || !def) return null
  const clisOpts = usable.map((c) => ({
    value: c.id,
    label: c.id === defCli ? t('{name}（默认）', { name: c.name }) : c.name,
  }))
  const models = modelOptions(def, { defaultValue: defModel, extra: [run.model] })
  const effortList = modelEfforts(def, run.model)
  const efforts = defaultEffortOptions(def, defEffort, effortList)
  const effortPicked = effortValue(def, defEffort, effortList, run.effort)
  // 实际用的强度：选的是「默认」（''）时显示默认那档
  const shownEffort = run.effort || defEffort
  const label = t('模型 {model}，思考强度 {effort}，点开切换', {
    model: modelName(def, run.model),
    effort: effortName(cli, shownEffort) || t('默认'),
  })
  const section = (title: string, opts: Opt[], cur: string, pick: (v: string) => void, dot?: boolean) => (
    <div className="py-1">
      <p className="px-2.5 pt-1 pb-1 text-[0.6875rem] text-subtle">{title}</p>
      {opts.map((o, i) => (
        <PopoverClose key={o.value + i} className={cn(menuItem, 'gap-2 py-1.5')} onClick={() => pick(o.value)}>
          {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: cliColor(o.value) }} />}
          <span className={cn('min-w-0 flex-1 truncate text-[0.75rem]', !dot && 'font-mono')}>{o.label}</span>
          {o.value === cur && <Check className="h-4 w-4 shrink-0 text-accent-text" />}
        </PopoverClose>
      ))}
    </div>
  )
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={t('模型和思考强度')}
        className={cn(FACE, 'cursor-pointer transition-colors hover:bg-sel data-[state=open]:bg-sel')}
      >
        {parts === 'effort' ? (
          <>
            <EffortBars n={effortBars(cli, shownEffort)} />
            <span className="shrink-0 text-subtle">{effortName(cli, shownEffort) || t('默认')}</span>
          </>
        ) : (
          <ModelFace model={modelName(def, run.model)} cli={cli} effort={shownEffort} />
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-subtle" />
      </PopoverTrigger>
      <PopoverContent className="w-max max-w-[min(420px,calc(100vw-24px))] min-w-[240px]" align="end">
        <div className="max-h-96 divide-y divide-line overflow-y-auto">
          {parts === 'all' &&
            section(t('Agent'), clisOpts, cli, (c) => onChange({ cli: c, model: '', effort: '' }), true)}
          {parts === 'all' &&
            models.length > 0 &&
            section(t('模型'), models, run.model === defModel ? '' : run.model, (m) =>
              onChange({ ...value, cli, model: m, effort: '' }),
            )}
          {efforts.length > 1 &&
            section(t('思考强度'), efforts, effortPicked, (e) => onChange({ ...value, cli, effort: e }))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * 用角色的对话：模型和思考强度跟着角色设置，输入框里只读显示（和可选的那个同一个样子，没有下拉箭头）
 */
export function RoleModelBadge({ agent }: { agent: { cli: string; model: string; effort?: string } }) {
  const { settings } = useData()
  const r = agentRun(agent, settings ?? defaultSettings())
  const def = useCliDef(r.cli || undefined)
  if (!r.cli) return null
  const name = modelName(def, r.model)
  // 角色和 CLI 设置都没指定强度时 CLI 用模型自己的默认档：照样显示出来，不留空
  const effort = r.effort || def?.models.find((m) => m.id === r.model)?.defaultEffort || ''
  return (
    <span
      className={FACE}
      title={t('模型和思考强度跟着角色设置：{model}', { model: [r.model, effort].filter(Boolean).join(' · ') })}
    >
      <ModelFace model={name} cli={r.cli} effort={effort} />
    </span>
  )
}
