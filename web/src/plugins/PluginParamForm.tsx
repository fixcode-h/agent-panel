import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PluginConfig, PluginSetting } from '@shared/plugins/types'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from '@/components/settings/parts'
import { pluginApi } from './api'
import { loadPlugins, usePlugins, type PluginRow } from './registry'

/**
 * 插件参数表单：设置 →「插件参数」整页用它，插件自己的设置页也用它画一部分（host.ui.PluginParams）。
 * 用户 2026-11-17 要每个插件有自己的设置页（例如 UE 插件页里 GameTest 卡片上的「设置」）：参数还是清单 settings
 * 声明、存在 Settings.plugins[id].config，只是按分组挑出几节放到插件页里，两处改的是同一份值，不各存一份。
 */
export function ParamForm({
  row,
  groups: only,
  bare,
}: {
  row: PluginRow
  /** 只画这几个分组（清单 settings 的 group）；不给画全部 */
  groups?: string[]
  /** 嵌在插件自己的卡片里：不画分组标题和设置页的底色块，只留一行一行 */
  bare?: boolean
}) {
  const [draft, setDraft] = useState<PluginConfig>(row.config)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(row.config), [row.config])
  const settings = row.manifest.settings.filter((s) => !only || only.includes(s.group ?? ''))
  // 只比这里画出来的几项：别处改了没画出来的参数，这里不该亮「保存」
  const dirty = settings.some((s) => draft[s.key] !== row.config[s.key])
  const set = (k: string, v: string | number | boolean) => setDraft((d) => ({ ...d, [k]: v }))
  const save = async () => {
    setSaving(true)
    try {
      // 只交这里画出来的几项：服务端按键合并，别的参数保持服务端那份
      await pluginApi.update(row.manifest.id, {
        config: Object.fromEntries(settings.filter((s) => s.key in draft).map((s) => [s.key, draft[s.key]])),
      })
      await loadPlugins()
      toast.success(t('插件参数已保存'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const field = (s: PluginSetting) => {
    const v = draft[s.key] ?? s.default
    if (s.type === 'boolean')
      return <Switch checked={!!v} onCheckedChange={(c) => set(s.key, c)} aria-label={t(s.label)} />
    if (s.type === 'select')
      return (
        <Select
          aria-label={t(s.label)}
          value={String(v)}
          onChange={(e) => set(s.key, e.target.value)}
          options={(s.options ?? []).map((o) => ({ value: o.value, label: t(o.label) }))}
        />
      )
    if (s.type === 'number')
      return (
        <div className="flex items-center gap-2">
          <Input
            aria-label={t(s.label)}
            type="number"
            min={s.min}
            max={s.max}
            value={String(v)}
            onChange={(e) => set(s.key, e.target.value === '' ? s.default : Number(e.target.value))}
          />
          {s.unit && <span className="shrink-0 text-body text-subtle">{t(s.unit)}</span>}
        </div>
      )
    return (
      <Input
        aria-label={t(s.label)}
        value={String(v)}
        placeholder={s.placeholder ? t(s.placeholder) : undefined}
        className={cn(s.type === 'path' && 'font-mono')}
        onChange={(e) => set(s.key, e.target.value)}
      />
    )
  }
  if (!settings.length)
    return bare ? null : (
      <Group title={t('参数设置')}>
        <p className="px-4 py-3 text-body text-subtle">{t('这个插件没有可配置的参数。')}</p>
      </Group>
    )
  const rowOf = (s: PluginSetting) => (
    <Row
      key={s.key}
      title={t(s.label)}
      desc={s.desc ? t(s.desc) : undefined}
      hint={s.env ? t('对应环境变量 {env}', { env: s.env }) : undefined}
      stack={s.type === 'path' || s.type === 'text'}
    >
      {field(s)}
    </Row>
  )
  const actions = (
    <div className={cn('flex justify-end gap-2', bare ? 'py-2.5' : 'mt-3')}>
      {dirty && (
        <Button size="sm" variant="ghost" onClick={() => setDraft(row.config)} disabled={saving}>
          {t('还原')}
        </Button>
      )}
      <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t('保存参数')}
      </Button>
    </div>
  )
  if (bare)
    return (
      <div data-plugin-params={row.manifest.id} className="flex flex-col px-4 [&>*+*]:border-t [&>*+*]:border-line">
        {settings.map(rowOf)}
        {actions}
      </div>
    )
  // 没写分组的参数归到「参数」这一节，写了的按清单里出现的顺序各成一节
  const groups = [...new Set(settings.map((s) => s.group ?? ''))]
  return (
    <>
      {groups.map((g) => (
        <Group key={g} title={g ? t(g) : t('参数设置')}>
          {settings.filter((s) => (s.group ?? '') === g).map(rowOf)}
        </Group>
      ))}
      {actions}
    </>
  )
}

/**
 * 给插件网页用的（host.ui.PluginParams）：按插件 id 找到自己那一行，画挑出来的几个分组。
 * 插件没开或没装时不画（插件页本来也打不开）
 */
export function PluginParams({ pluginId, groups }: { pluginId: string; groups?: string[] }) {
  const { rows } = usePlugins()
  const row = rows.find((r) => r.manifest.id === pluginId)
  if (!row) return null
  return <ParamForm row={row} groups={groups} bare />
}
