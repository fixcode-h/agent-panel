import { Loader2, Sparkles } from 'lucide-react'
import type { ParamValue, ParamValues, WorkflowExpose } from '@shared/schema'
import type { AgentParamGroup, DerivedParam } from '@shared/agent-params'
import { resolveParams } from '@shared/agent-role'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ParamControl, ParamRow } from '@/components/agents/ParamFields'

// 项目设置「工作流」页里每个工作流的参数表单：暴露项和它用到的角色参数（从 ProjectSettingsDialog.tsx 挪出）

/** 按 Agent 分组的参数表单：值来自 AgentParam.default，留空即用默认；同一 key 只出现一次，注明影响哪些 Agent */
export function AgentParamsEditor({
  group,
  agents,
  values,
  onChange,
  onAi,
  aiRunning,
  hidden,
}: {
  group: AgentParamGroup
  /** 同一个 key 在其他 Agent 里也有的情况，派生结果里已经合并，这里只用来显示影响面 */
  agents: DerivedParam[]
  values: Record<string, ParamValue | undefined>
  onChange: (key: string, v: string | boolean) => void
  onAi: () => void
  aiRunning: boolean
  /** 工作流 expose 已经管着的参数 key：同 key 只渲染一次，由 expose 那边负责 */
  hidden: Set<string>
}) {
  // 联动按这个 Agent 自己的参数顺序算：前面参数没选到的不显示，选项跟着前面的取值缩小
  const view = resolveParams(group.params, values as ParamValues)
  const mine = agents.filter(
    (d) => d.agents.some((a) => a.id === group.agentId) && !hidden.has(d.key) && !view.hidden.includes(d.key),
  )
  if (!mine.length) return null
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-sel/40 p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-body font-medium">{group.agentName}</span>
        <span className="text-xs text-subtle">{t('{n} 个参数', { n: mine.length })}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onAi} disabled={aiRunning}>
          {aiRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 配置')}
        </Button>
      </div>
      {mine.map((d) => (
        <DerivedParamField
          key={d.key}
          d={view.options[d.key] ? { ...d, options: view.options[d.key] } : d}
          value={values[d.key]}
          onChange={(v) => onChange(d.key, v)}
        />
      ))}
    </div>
  )
}

/** 参数的默认值写成人能看的字：开关是「是 / 否」，多选用顿号连起来 */
function defaultText(v: ParamValue | undefined) {
  if (v === undefined || v === '') return ''
  if (typeof v === 'boolean') return v ? t('是') : t('否')
  if (Array.isArray(v)) return v.join(t('、'))
  return String(v)
}

/** 一项派生参数：按类型渲染，显示默认值；多个 Agent 共用同一个 key 时注明影响面 */
function DerivedParamField({
  d,
  value,
  onChange,
}: {
  d: DerivedParam
  value: ParamValue | undefined
  onChange: (v: string | boolean) => void
}) {
  const label = d.label || d.key
  const fallback = defaultText(d.defaultValue)
  const shared = d.agents.length > 1
  // 说明、默认值和影响面都收进 ⓘ，行里只留参数名——参数多时一屏能看到全条
  const hint = [
    d.description,
    fallback && t('默认：{v}', { v: fallback }),
    shared && t('同时影响 {names}', { names: [...new Set(d.agents.map((a) => a.name))].join(t('、')) }),
  ]
    .filter(Boolean)
    .join('；')
  return (
    <ParamRow
      label={
        <>
          <span className="truncate font-medium text-muted">{label}</span>
          <span className="shrink-0 font-mono text-caption text-subtle">{d.key}</span>
          {d.required && <span className="shrink-0 text-caption text-warning">{t('必须填')}</span>}
        </>
      }
      hint={hint}
      controlClass={d.type === 'bool' ? undefined : 'w-[min(14rem,50%)]'}
    >
      {d.type === 'select' ? (
        <Select
          aria-label={label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: '', label: fallback ? t('默认：{v}', { v: fallback }) : t('未选择') },
            ...d.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      ) : d.type === 'bool' ? (
        <Switch checked={value === true} onCheckedChange={(x) => onChange(x)} aria-label={label} />
      ) : (
        <Input
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallback ? t('默认：{v}', { v: fallback }) : ''}
          className="h-9"
        />
      )}
    </ParamRow>
  )
}

/** 工作流暴露的一项配置：按类型渲染成下拉、多选、开关或文本框 */
export function ExposeField({
  e,
  value,
  onChange,
}: {
  e: WorkflowExpose
  value: ParamValue | undefined
  onChange: (v: ParamValue) => void
}) {
  const label = e.label || e.key
  // 多选存的是字符串数组，早先的版本存成 "a, b" 字符串，这里两种都认
  const text =
    typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.join(', ') : String(value ?? '')
  const list = Array.isArray(value) ? value : text ? text.split(/\s*,\s*/).filter(Boolean) : []
  // 没改过时显示默认值（这些选项本来就生效），改动后再存实际的数组
  const shown = list.length || !Array.isArray(e.default) ? list : e.default
  const fallback = defaultText(e.default)
  // 和角色参数一样：说明与默认值收进 ⓘ，行里只留名字，控件靠右
  const hint = [e.description, fallback && t('默认：{v}', { v: fallback })].filter(Boolean).join('；')
  const on = value === true || text === 'true'
  return (
    <ParamRow
      label={<span className="truncate font-medium text-muted">{label}</span>}
      hint={hint}
      controlClass={e.type === 'bool' ? undefined : e.type === 'multi' ? 'w-[min(20rem,60%)]' : 'w-[min(14rem,50%)]'}
    >
      {e.type === 'select' ? (
        <Select
          aria-label={label}
          value={text}
          onChange={(ev) => onChange(ev.target.value)}
          options={[
            // 没选时显示默认值（或「未选择」），选了就只显示选中的
            ...(text ? [] : [{ value: '', label: fallback ? t('默认：{v}', { v: fallback }) : t('未选择') }]),
            ...e.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      ) : e.type === 'bool' ? (
        // 开关的取值照旧存成 'true' / 'false' 字符串，和工作流配置里的格式一致
        <Switch checked={on} onCheckedChange={(x) => onChange(x ? 'true' : 'false')} aria-label={label} />
      ) : e.type === 'multi' ? (
        // 多选和角色参数用同一个控件：值是字符串数组，exposeValue 会拼成「a, b」填进 {{槽名}}
        <ParamControl
          param={{
            key: e.key,
            label,
            type: 'multi',
            options: e.options,
            ask: false,
            description: e.description,
            default: e.default,
          }}
          value={shown}
          onChange={(v) => onChange(Array.isArray(v) ? v : [])}
        />
      ) : (
        <Input
          aria-label={label}
          value={text}
          onChange={(ev) => onChange(ev.target.value)}
          placeholder={fallback ? t('默认：{v}', { v: fallback }) : ''}
          className="h-9"
        />
      )}
    </ParamRow>
  )
}
