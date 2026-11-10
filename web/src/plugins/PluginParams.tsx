import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PluginConfig, PluginSetting } from '@shared/plugins/types'
import { useNav } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from '@/components/settings/parts'
import { pluginApi } from './api'
import { PLUGIN_PARAMS, pluginParamsId } from './PluginParamsNav'
import { loadPlugins, usePlugins, type PluginRow } from './registry'

/**
 * 设置 →「插件参数」的内容区：开着的插件各占一页（左栏和二级列表见 PluginParamsNav.tsx），每个插件分开配置。
 * 参数表单按清单的 settings 声明生成，值存在 Settings.plugins[id].config；运行状态也放在这里。
 * 「插件」页只管装、删、开关，参数统一到这里改，不在两处各放一份表单。
 */

/** 内容区：当前插件的说明、参数和运行状态；没有开着的插件时给去「插件」页的入口 */
export function PluginParamsSection({ section }: { section: string }) {
  const { rows, webErrors, loaded } = usePlugins()
  const { openSettings } = useNav()
  useEffect(() => void loadPlugins().catch(() => {}), [])
  const on = rows.filter((r) => r.enabled)
  const row = section === PLUGIN_PARAMS ? on[0] : on.find((r) => pluginParamsId(r.manifest.id) === section)
  if (!row)
    return (
      <EmptyPanel as="div" size="md" className="mt-2 flex flex-col items-center gap-3 text-body text-subtle">
        {loaded ? t('还没有开启的插件。先在「插件」页安装并打开插件，这里就会列出它的参数。') : t('读取中…')}
        {loaded && (
          <Button size="sm" variant="secondary" onClick={() => openSettings('plugins')}>
            {t('去插件页')}
          </Button>
        )}
      </EmptyPanel>
    )
  const m = row.manifest
  const error = row.error || webErrors.get(m.id) || ''
  return (
    <div data-plugin-params={m.id}>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Badge>v{m.version}</Badge>
        {row.hasCode && <Badge tone="warning">{t('含代码')}</Badge>}
        {m.description && <span className="text-body leading-relaxed text-muted">{t(m.description)}</span>}
      </div>
      {error && <p className="mt-2 text-xs break-all text-danger">{error}</p>}
      {/* 换插件时整块重建：草稿跟着换，不把上一个插件没保存的值带过来 */}
      <ParamForm key={m.id} row={row} />
      <StatusPanel row={row} />
    </div>
  )
}

/** 按清单声明画参数表单：改了先存在草稿里，点「保存」才写进设置（插件可能要重启后台） */
function ParamForm({ row }: { row: PluginRow }) {
  const [draft, setDraft] = useState<PluginConfig>(row.config)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(row.config), [row.config])
  const dirty = JSON.stringify(draft) !== JSON.stringify(row.config)
  const set = (k: string, v: string | number | boolean) => setDraft((d) => ({ ...d, [k]: v }))
  const save = async () => {
    setSaving(true)
    try {
      await pluginApi.update(row.manifest.id, { config: draft })
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
  const settings = row.manifest.settings
  if (!settings.length)
    return (
      <Group title={t('参数设置')}>
        <p className="px-4 py-3 text-body text-subtle">{t('这个插件没有可配置的参数。')}</p>
      </Group>
    )
  // 没写分组的参数归到「参数」这一节，写了的按清单里出现的顺序各成一节
  const groups = [...new Set(settings.map((s) => s.group ?? ''))]
  return (
    <>
      {groups.map((g) => (
        <Group key={g} title={g ? t(g) : t('参数设置')}>
          {settings
            .filter((s) => (s.group ?? '') === g)
            .map((s) => (
              <Row
                key={s.key}
                title={t(s.label)}
                desc={s.desc ? t(s.desc) : undefined}
                hint={s.env ? t('对应环境变量 {env}', { env: s.env }) : undefined}
                stack={s.type === 'path' || s.type === 'text'}
              >
                {field(s)}
              </Row>
            ))}
        </Group>
      ))}
      <div className="mt-3 flex justify-end gap-2">
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
    </>
  )
}

/** 运行状态：插件网页部分给了状态面板就用它，否则把服务端给的键值列出来 */
function StatusPanel({ row }: { row: PluginRow }) {
  const { web } = usePlugins()
  const [status, setStatus] = useState<Record<string, unknown>>()
  const reload = () =>
    void pluginApi
      .status(row.manifest.id)
      .then(setStatus)
      .catch((e: Error) => setStatus({ error: e.message }))
  // 只在换插件、开关变化时读一次，之后由面板上的刷新按钮触发 reload
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [row.manifest.id, row.enabled])
  const Custom = web.get(row.manifest.id)?.Status
  const entries = Object.entries(status ?? {})
  if (!Custom && !entries.length) return null
  return (
    <Group title={t('运行状态')} plain>
      {Custom ? (
        <Custom status={status} config={row.config} reload={reload} />
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-1 text-xs">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-subtle">{k}</dt>
              <dd className="break-all text-muted">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Group>
  )
}
