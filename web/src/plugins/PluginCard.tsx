import { useState } from 'react'
import { ExternalLink, Loader2, MoreHorizontal, RotateCcw, SlidersHorizontal, Trash2, Undo2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Switch } from '@/components/ui/switch'
import { pluginApi, type InstallPreview, type KeptItem, type RemovalPreview } from './api'
import { UpgradeButton, useMarketEntry } from './PluginUpdates'
import { PluginContributions } from './PluginContributions'
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

export function PluginCard({ row, onPreview }: { row: PluginRow; onPreview?: (p: InstallPreview) => void }) {
  const { webErrors } = usePlugins()
  const { openSettings } = useNav()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<'off' | 'delete' | 'rollback'>()
  const [preview, setPreview] = useState<RemovalPreview>()
  const [kept, setKept] = useState<KeptItem[]>([])
  const m = row.manifest
  const Icon = pluginIcon(m.icon)
  const error = row.error || webErrors.get(m.id) || ''
  const entry = useMarketEntry(row)
  const homepage =
    entry?.homepage || m.homepage || (row.source.kind === 'github' ? `https://github.com/${row.source.ref}` : '')
  // 重新安装：市场里的按插件 id 装市场当前版本；单个插件的仓库按装时的分支和子目录；本机目录重新链接；压缩包没有来源可重装
  const s = row.source
  const reinstallFrom =
    s.kind === 'github'
      ? () => pluginApi.fromGithub(entry ? { repo: s.ref, id: m.id } : { repo: s.ref, ref: s.tag, path: s.path })
      : s.kind === 'dir'
        ? () => pluginApi.fromDir(s.ref)
        : undefined
  const reinstall = async () => {
    if (!reinstallFrom || !onPreview) return
    setBusy(true)
    try {
      onPreview(await reinstallFrom())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

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
  // 退回上一版（升级后有问题时）：服务端换回旧包、重启插件，这里重读列表
  const rollback = async () => {
    setBusy(true)
    try {
      const r = await pluginApi.rollback(m.id)
      await loadPlugins()
      if (r.error) toast.error(t('插件启动失败：{error}', { error: r.error }))
      else toast.success(t('已退回 {name} {version}', { name: m.name, version: row.rollback }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
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
          </div>
          <p className="truncate text-xs text-subtle" title={sourceLabel(row)}>
            {sourceLabel(row)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-subtle" />}
          <Switch
            checked={row.enabled}
            disabled={busy}
            aria-label={row.enabled ? t('关掉插件 {name}', { name: m.name }) : t('打开插件 {name}', { name: m.name })}
            onCheckedChange={(on) => (on ? void toggle(true) : ask('off'))}
          />
        </div>
      </div>
      {m.description && <p className="line-clamp-2 text-body leading-relaxed text-muted">{t(m.description)}</p>}
      {m.source && (
        <a
          href={m.source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 self-start text-xs text-subtle hover:text-fg"
        >
          {t('上游 {name} {version}（{license}）', m.source)}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      <PluginContributions manifest={m} />
      {error && <p className="text-xs break-all text-danger">{error}</p>}
      {!!kept.length && (
        <div className="text-xs text-subtle">
          {t('关掉后保留了这些副本：')}
          <KeptList kept={kept} />
        </div>
      )}
      <div className="mt-auto flex items-center gap-1 pt-1">
        <UpgradeButton row={row} onPreview={onPreview} />
        {/* 参数和运行状态在设置 →「插件参数」里按插件分页配置，卡片上只留入口 */}
        {row.enabled && (
          <Button size="sm" variant="ghost" onClick={() => openSettings(pluginParamsId(m.id))}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('参数')}
          </Button>
        )}
        <Menu modal={false}>
          <MenuTrigger asChild>
            <IconButton
              icon={MoreHorizontal}
              label={t('插件 {name} 的更多操作', { name: m.name })}
              size="sm"
              className="ml-auto"
            />
          </MenuTrigger>
          <MenuContent>
            {row.rollback && (
              <MenuItem disabled={busy} onSelect={() => setAsking('rollback')}>
                <Undo2 className="h-3.5 w-3.5" />
                {t('退回上一版 v{version}', { version: row.rollback })}
              </MenuItem>
            )}
            {reinstallFrom && onPreview && (
              <MenuItem disabled={busy} onSelect={() => void reinstall()}>
                <RotateCcw className="h-3.5 w-3.5" />
                {s.kind === 'dir' ? t('重新链接') : t('重新安装')}
              </MenuItem>
            )}
            {homepage && (
              <MenuItem onSelect={() => window.open(homepage, '_blank', 'noreferrer')}>
                <ExternalLink className="h-3.5 w-3.5" />
                {t('打开主页')}
              </MenuItem>
            )}
            {(row.rollback || (reinstallFrom && onPreview) || homepage) && <MenuSeparator />}
            <MenuItem danger onSelect={() => ask('delete')}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('删除插件')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <ConfirmDialog
        open={asking === 'off'}
        onOpenChange={(o) => !o && setAsking(undefined)}
        title={t('关掉插件「{name}」？', { name: m.name })}
        confirmText={t('关掉')}
        description={
          <div className="flex flex-col gap-2">
            <span>
              {t(
                '会停掉它的后台和工具，对话里不再挂它的工具，它带的钩子、测试步骤和「/」命令一起撤掉，它装的没改过的技能也一起删掉。',
              )}
            </span>
            {removalText(preview)}
          </div>
        }
        onConfirm={async () => {
          setAsking(undefined)
          await toggle(false)
        }}
      />
      <ConfirmDialog
        open={asking === 'rollback'}
        onOpenChange={(o) => !o && setAsking(undefined)}
        title={t('退回插件「{name}」的上一版？', { name: m.name })}
        confirmText={t('退回')}
        description={t(
          '会从 v{current} 换回升级前的 v{version} 并重新启动插件，参数和插件数据不动。之后想回到 v{current} 可以再点一次退回。',
          { current: m.version, version: row.rollback },
        )}
        onConfirm={async () => {
          setAsking(undefined)
          await rollback()
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
