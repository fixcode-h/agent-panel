import { useEffect, useState } from 'react'
import { Box, ExternalLink, Loader2, Puzzle, Trash2, type LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PluginConfig, PluginSetting } from '@shared/plugins/types'
import { AGENT_ICONS } from '@/lib/agent-icons'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Row } from '@/components/settings/parts'
import { pluginApi, type KeptItem, type RemovalPreview } from './api'
import { loadPlugins, usePlugins, type PluginRow } from './registry'

/** 清单里的 icon：角色图标之外再认几个插件常用的；不认识的用拼图 */
const EXTRA_ICONS: Record<string, LucideIcon> = { box: Box, puzzle: Puzzle }
export const pluginIcon = (name: string) => EXTRA_ICONS[name] ?? AGENT_ICONS.find((i) => i.id === name)?.icon ?? Puzzle

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
  const groups = [...new Set(row.manifest.settings.map((s) => s.group ?? ''))]
  if (!row.manifest.settings.length) return null
  return (
    <div className="flex flex-col">
      {groups.map((g) => (
        <section key={g} className="flex flex-col">
          {g && <h4 className="mt-3 text-xs font-medium text-subtle">{t(g)}</h4>}
          <div className="divide-y divide-line">
            {row.manifest.settings
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
          </div>
        </section>
      ))}
      <div className="mt-2 flex justify-end gap-2">
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
  if (Custom) return <Custom status={status} config={row.config} reload={reload} />
  const entries = Object.entries(status ?? {})
  if (!entries.length) return null
  return (
    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-subtle">{k}</dt>
          <dd className="break-all text-muted">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function PluginCard({ row }: { row: PluginRow }) {
  const { webErrors } = usePlugins()
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
      {row.enabled && (
        <div className="border-t border-line pt-1">
          <ParamForm row={row} />
          <StatusPanel row={row} />
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
