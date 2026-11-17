import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Group } from '@/components/settings/parts'
import { pluginApi } from './api'
import { ParamForm } from './PluginParamForm'
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
