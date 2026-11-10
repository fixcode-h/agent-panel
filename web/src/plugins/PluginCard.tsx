import { useState } from 'react'
import { ExternalLink, Loader2, SlidersHorizontal, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'
import { pluginApi, type KeptItem, type RemovalPreview } from './api'
import { pluginIcon } from './icon'
import { pluginParamsId } from './PluginParamsNav'
import { loadPlugins, usePlugins, type PluginRow } from './registry'

export { pluginIcon }

/** 来源的一行说明：GitHub 仓库、上传的文件、本机目录 */
export function sourceLabel(row: Pick<PluginRow, 'source'>) {
  const s = row.source
  if (s.kind === 'github') return `GitHub · ${s.ref}${s.tag && s.tag !== 'HEAD' ? ` @ ${s.tag}` : ''}`
  if (s.kind === 'zip') return t('压缩包 · {name}', { name: s.ref })
  return t('本机目录 · {dir}', { dir: s.ref })
}

/** 关掉、删除后留下的副本（改过的、还在用的） */
function KeptList({ kept }: { kept: KeptItem[] }) {
  if (!kept.length) return null
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-xs text-subtle">
      {kept.map((k) => (
        <li key={k.id}>
          {k.kind === 'workflow' ? t('工作流') : t('角色')}「{k.name}」：{k.why}
        </li>
      ))}
    </ul>
  )
}

export function PluginCard({ row }: { row: PluginRow }) {
  const { webErrors } = usePlugins()
  const { openSettings } = useNav()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<'off' | 'delete'>()
  const [preview, setPreview] = useState<RemovalPreview>()
  const [kept, setKept] = useState<KeptItem[]>([])
  const m = row.manifest
  const Icon = pluginIcon(m.icon)
  const error = row.error || webErrors.get(m.id) || ''

  const ask = (what: 'off' | 'delete') => {
    setPreview(undefined)
    setAsking(what)
    void pluginApi
      .removal(m.id)
      .then(setPreview)
      .catch(() => setPreview({ workflows: [], agents: [], kept: [] }))
  }
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      const r = await pluginApi.update(m.id, { enabled: on })
      setKept(r.removed?.kept ?? [])
      await loadPlugins()
      if (r.error) toast.error(t('插件启动失败：{error}', { error: r.error }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    try {
      const r = await pluginApi.remove(m.id)
      await loadPlugins()
      toast.success(
        r.kept.length
          ? t('已删除插件 {name}，保留了 {n} 个改过或在用的副本', { name: m.name, n: r.kept.length })
          : t('已删除插件 {name}', { name: m.name }),
      )
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const removalText = (p?: RemovalPreview) =>
    !p ? (
      <span className="text-subtle">{t('正在统计会清掉的内容…')}</span>
    ) : (
      <div className="flex flex-col gap-1">
        {p.workflows.length + p.agents.length ? (
          <span>
            {t('会删掉没改过、没人用的副本（先备份）：{list}', {
              list: [...p.workflows, ...p.agents].join(t('、')),
            })}
          </span>
        ) : (
          <span>{t('本机没有要清掉的角色和工作流副本。')}</span>
        )}
        {!!p.kept.length && <span>{t('下面这些会保留：')}</span>}
        <KeptList kept={p.kept} />
      </div>
    )

  return (
    <Card padding="md" className="flex flex-col gap-2" data-plugin-card={m.id}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
            row.enabled ? 'bg-accent-soft text-accent-text' : 'bg-sel text-subtle',
          )}
        >
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-prose font-semibold">{m.name}</span>
            <Badge>v{m.version}</Badge>
            {row.hasCode && <Badge tone="warning">{t('含代码')}</Badge>}
            {row.enabled && !error && <Badge tone="success">{t('已开启')}</Badge>}
          </div>
          {m.description && <p className="text-body leading-relaxed text-muted">{t(m.description)}</p>}
          <p className="truncate text-xs text-subtle" title={sourceLabel(row)}>
            {sourceLabel(row)}
            {m.source && (
              <>
                {' · '}
                <a
                  href={m.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-fg"
                >
                  {t('上游 {name} {version}（{license}）', m.source)}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-subtle" />}
          <Switch
            checked={row.enabled}
            disabled={busy}
            aria-label={row.enabled ? t('关掉插件 {name}', { name: m.name }) : t('打开插件 {name}', { name: m.name })}
            onCheckedChange={(on) => (on ? void toggle(true) : ask('off'))}
          />
          {/* 参数和运行状态在设置 →「插件参数」里按插件分页配置，卡片上只留入口 */}
          {row.enabled && (
            <IconButton
              icon={SlidersHorizontal}
              label={t('配置插件 {name} 的参数', { name: m.name })}
              size="sm"
              onClick={() => openSettings(pluginParamsId(m.id))}
            />
          )}
          <IconButton
            icon={Trash2}
            label={t('删除插件 {name}', { name: m.name })}
            size="sm"
            onClick={() => ask('delete')}
          />
        </div>
      </div>
      {error && <p className="text-xs break-all text-danger">{error}</p>}
      {!!kept.length && (
        <div className="text-xs text-subtle">
          {t('关掉后保留了这些副本：')}
          <KeptList kept={kept} />
        </div>
      )}
      <ConfirmDialog
        open={asking === 'off'}
        onOpenChange={(o) => !o && setAsking(undefined)}
        title={t('关掉插件「{name}」？', { name: m.name })}
        confirmText={t('关掉')}
        description={
          <div className="flex flex-col gap-2">
            <span>{t('会停掉它的后台和工具，对话里不再挂它的工具，它装的没改过的技能也一起删掉。')}</span>
            {removalText(preview)}
          </div>
        }
        onConfirm={async () => {
          setAsking(undefined)
          await toggle(false)
        }}
      />
      <ConfirmDialog
        open={asking === 'delete'}
        onOpenChange={(o) => !o && setAsking(undefined)}
        title={t('删除插件「{name}」？', { name: m.name })}
        description={
          <div className="flex flex-col gap-2">
            <span>
              {t(
                '插件目录、插件自己的数据和它的参数都会删掉，以后可以从插件市场或压缩包重新安装。面板的其他功能不受影响。',
              )}
            </span>
            {removalText(preview)}
          </div>
        }
        onConfirm={async () => {
          setAsking(undefined)
          await remove()
        }}
      />
    </Card>
  )
}
