import { useEffect, useRef, useState } from 'react'
import { Download, FolderGit, FolderOpen, Loader2, RefreshCw, ShieldAlert, Upload } from 'lucide-react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { Checkbox } from '@/components/ui/checkbox'
import { ScanFindings } from '@/components/ui/scan-findings'
import { configScanApi } from '@/lib/api-config-scan'
import { Group } from '@/components/settings/parts'
import { isNewerPlugin } from '@shared/plugins/version'
import { pluginApi, type InstallPreview, type MarketEntry } from './api'
import { PluginCard, pluginIcon } from './PluginCard'
import { UpdateBar } from './PluginUpdates'
import { loadPlugins, usePlugins } from './registry'

/**
 * 设置 →「插件」（ADR 0059）：装着的插件（开关、参数、状态、删除）和安装入口。
 * 安装一律先预览：服务端下载、校验好清单，弹窗写明来源、版本、会不会在本机运行代码，用户确认后才写进去。
 * 插件市场默认是 fixcode-h/agent-plugins，可以换成别的仓库。
 */
export function PluginsSection() {
  const { rows, broken, market, loaded } = usePlugins()
  const [preview, setPreview] = useState<InstallPreview>()
  useEffect(() => void loadPlugins().catch(() => {}), [])
  return (
    <>
      <p className="text-body leading-relaxed text-subtle">
        {t(
          '插件给面板加上一组能力（工具、技能、角色、工作流、页面），装在数据目录里，可以随时关掉或删除，删掉后面板其他功能不受影响。',
        )}
      </p>
      <Group title={t('已安装')} plain>
        {!loaded ? (
          <p className="text-body text-subtle">{t('读取中…')}</p>
        ) : rows.length ? (
          <>
            <UpdateBar rows={rows} />
            <div className="flex flex-col gap-3">
              {rows.map((r) => (
                <PluginCard key={r.manifest.id} row={r} onPreview={setPreview} />
              ))}
            </div>
          </>
        ) : (
          <EmptyPanel as="div" size="md" className="text-body text-subtle">
            {t('还没有安装插件。从下面的插件市场挑一个，或者上传插件压缩包。')}
          </EmptyPanel>
        )}
        {broken.map((b) => (
          <BrokenRow key={b.id} id={b.id} error={b.error} />
        ))}
      </Group>
      <Market defaultRepo={market} onPreview={setPreview} />
      <OtherSources onPreview={setPreview} />
      <InstallConfirm preview={preview} onClose={() => setPreview(undefined)} />
    </>
  )
}

/** 读不出来的插件（目录坏了、清单不对、要求更新的面板）：只能删 */
function BrokenRow({ id, error }: { id: string; error: string }) {
  return (
    <Card padding="sm" className="mt-3 flex items-center gap-3">
      <ShieldAlert className="h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{id}</p>
        <p className="text-xs break-all text-danger">{error}</p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          void pluginApi
            .remove(id)
            .then(() => loadPlugins())
            .catch((e: Error) => toast.error(e.message))
        }
      >
        {t('删除')}
      </Button>
    </Card>
  )
}

function Market({ defaultRepo, onPreview }: { defaultRepo: string; onPreview: (p: InstallPreview) => void }) {
  const { rows } = usePlugins()
  const [repo, setRepo] = useState('')
  const [list, setList] = useState<MarketEntry[] | null>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const cur = repo.trim() || defaultRepo
  const load = async () => {
    if (!cur) return
    setBusy('list')
    setError('')
    try {
      const r = await pluginApi.market(cur)
      setList(r.plugins)
    } catch (e) {
      setError((e as Error).message)
      setList(undefined)
    } finally {
      setBusy('')
    }
  }
  useEffect(() => {
    if (defaultRepo && list === undefined && !error) void load()
    // 只在拿到默认仓库时自动读一次，换仓库要点刷新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultRepo])
  const install = async (id?: string) => {
    setBusy(id ?? 'repo')
    try {
      onPreview(await pluginApi.fromGithub({ repo: cur, id }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return (
    <Group title={t('插件市场')} plain>
      <div className="flex items-center gap-2">
        <Input
          aria-label={t('插件仓库')}
          value={repo}
          placeholder={defaultRepo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load()}
          className="font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={!!busy}>
          <RefreshCw className={cn('h-3.5 w-3.5', busy === 'list' && 'animate-spin')} />
          {t('刷新')}
        </Button>
      </div>
      <p className="mt-1 text-xs text-subtle">
        {t('GitHub 仓库（owner/repo）。仓库根上的 plugins.json 列出里面的插件；没有的话整个仓库当作一个插件。')}
      </p>
      {error && <p className="mt-2 text-xs break-all text-danger">{error}</p>}
      {list === null && (
        <Card padding="sm" className="mt-3 flex items-center gap-3">
          <FolderGit className="h-4 w-4 shrink-0 text-subtle" />
          <p className="min-w-0 flex-1 text-body text-muted">
            {t('这个仓库没有插件目录，可以直接把整个仓库当作插件安装。')}
          </p>
          <Button size="sm" onClick={() => void install()} disabled={!!busy}>
            {busy === 'repo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('安装')}
          </Button>
        </Card>
      )}
      {!!list?.length && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {list.map((e) => {
            const have = rows.find((r) => r.manifest.id === e.id)
            const Icon = pluginIcon(e.icon)
            // 只有市场版本更新才算「升级」：装着的更新（开发版、预发布）时只能重新安装
            const newer = !!have && isNewerPlugin(e.version, have.manifest.version)
            const label = !have ? t('安装') : newer ? t('升级到 v{v}', { v: e.version }) : t('重新安装')
            return (
              <Card key={e.id} padding="sm" className="flex flex-col gap-2" data-market-plugin={e.id}>
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sel text-muted">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-semibold">{e.name}</p>
                    <p className="text-xs text-subtle">
                      v{e.version}
                      {have && have.manifest.version !== e.version && (
                        <span>{t('（装着 v{v}）', { v: have.manifest.version })}</span>
                      )}
                    </p>
                  </div>
                  {newer ? (
                    <Badge tone="accent">{t('可升级')}</Badge>
                  ) : (
                    have && <Badge tone="success">{t('已安装')}</Badge>
                  )}
                </div>
                {e.description && <p className="line-clamp-3 text-xs leading-relaxed text-muted">{t(e.description)}</p>}
                <Button
                  size="sm"
                  variant={have && !newer ? 'secondary' : 'primary'}
                  className="self-start"
                  onClick={() => void install(e.id)}
                  disabled={!!busy}
                >
                  {busy === e.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {label}
                </Button>
              </Card>
            )
          })}
        </div>
      )}
      {list && !list.length && <p className="mt-3 text-body text-subtle">{t('这个仓库的插件目录是空的。')}</p>}
    </Group>
  )
}

/** 其他安装方式：上传压缩包、本机目录（开发插件时链接构建产物，不复制） */
function OtherSources({ onPreview }: { onPreview: (p: InstallPreview) => void }) {
  const [how, setHow] = useState<'zip' | 'dir'>('zip')
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const run = async (f: () => Promise<InstallPreview>) => {
    setBusy(true)
    try {
      onPreview(await f())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Group title={t('其他安装方式')} plain>
      <Segmented
        size="sm"
        label={t('安装方式')}
        value={how}
        onChange={setHow}
        options={[
          { id: 'zip', label: t('上传压缩包') },
          { id: 'dir', label: t('本机目录（开发）') },
        ]}
      />
      {how === 'zip' ? (
        <div className="mt-3 flex items-center gap-3">
          <input
            ref={file}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void run(() => pluginApi.fromZip(f))
            }}
          />
          <Button size="sm" variant="secondary" onClick={() => file.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {t('选择 .zip')}
          </Button>
          <span className="text-xs text-subtle">{t('包的根目录（或唯一的子目录）里要有 plugin.json')}</span>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Input
              aria-label={t('插件目录')}
              value={dir}
              placeholder="/path/to/agent-plugins/blender/dist"
              onChange={(e) => setDir(e.target.value)}
              className="font-mono"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void run(() => pluginApi.fromDir(dir.trim()))}
              disabled={busy || !dir.trim()}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
              {t('链接')}
            </Button>
          </div>
          <span className="text-xs text-subtle">
            {t('链接本机的插件构建目录，不复制：重新构建后关掉再打开插件就生效。')}
          </span>
        </div>
      )}
    </Group>
  )
}

/**
 * 安装确认：来源、版本、会不会在本机运行代码、会不会覆盖已装的版本，以及配置安全扫描的发现；
 * 有高级发现时要勾选「我看过了，仍然安装」才能点安装（不直接禁止：自己的插件也可能有合理的命中）
 */
function InstallConfirm({ preview, onClose }: { preview?: InstallPreview; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [ack, setAck] = useState(false)
  // 点过「这条没问题」的从列表里拿掉（服务端也记下了，下次预览不再出现）
  const [gone, setGone] = useState<Set<string>>(new Set())
  useEffect(() => {
    setAck(false)
    setGone(new Set())
  }, [preview?.token])
  const m = preview?.manifest
  const scan = (preview?.scan ?? []).filter((f) => !gone.has(`${f.rule}|${f.file}|${f.line}|${f.snippet}`))
  const needAck = scan.some((f) => f.level === 'high')
  const confirm = async () => {
    if (!preview) return
    setBusy(true)
    try {
      await pluginApi.confirm(preview.token)
      await loadPlugins()
      toast.success(
        preview.installed
          ? t('已更新插件 {name}', { name: m!.name })
          : t('已安装插件 {name}，打开开关后生效', { name: m!.name }),
      )
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const Icon = pluginIcon(m?.icon ?? '')
  return (
    <Modal
      open={!!preview}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={preview?.installed ? t('更新插件') : t('安装插件')}
      footer={
        <>
          {needAck && <Checkbox checked={ack} onChange={setAck} label={t('我看过了，仍然安装')} disabled={busy} />}
          <Button variant="secondary" className="ml-auto" onClick={onClose} disabled={busy}>
            {t('取消')}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || (needAck && !ack)}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {preview?.installed ? t('更新') : t('安装')}
          </Button>
        </>
      }
    >
      {m && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-prose font-semibold">
                {m.name} <span className="text-body font-normal text-subtle">v{m.version}</span>
              </p>
              {m.description && <p className="text-body leading-relaxed text-muted">{t(m.description)}</p>}
              {m.author && <p className="text-xs text-subtle">{t('作者：{name}', { name: m.author })}</p>}
            </div>
          </div>
          {preview.installed && (
            <p className="text-body text-muted">
              {t('已经装着 v{v}：会换成这个版本，参数保留。', { v: preview.installed.version })}
            </p>
          )}
          {preview.hasCode && (
            <div className="flex gap-2 rounded-lg bg-warning/10 p-3 text-body text-warning">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t('这个插件带代码，打开后会在本机以面板的权限运行（读写文件、启动程序、联网）。只安装你信任的来源。')}
              </span>
            </div>
          )}
          <ScanFindings
            findings={scan}
            onIgnore={async (f) => {
              await configScanApi.ignore(f, preview.scanScope ?? '')
              setGone((g) => new Set(g).add(`${f.rule}|${f.file}|${f.line}|${f.snippet}`))
            }}
          />
          <ul className="flex flex-col gap-0.5 text-xs text-subtle">
            {!!m.agents.length && (
              <li>{t('角色：{list}', { list: m.agents.map((a) => a.agent.name).join(t('、')) })}</li>
            )}
            {!!m.workflows.length && (
              <li>{t('工作流：{list}', { list: m.workflows.map((w) => w.name).join(t('、')) })}</li>
            )}
            {!!Object.keys(m.skillGuide).length && (
              <li>{t('技能：{list}', { list: Object.keys(m.skillGuide).join(t('、')) })}</li>
            )}
            {!!m.mcpServers.length && <li>{t('给 Agent 的工具服务：{list}', { list: m.mcpServers.join(t('、')) })}</li>}
            {!!m.hooks?.length && <li>{t('钩子：{list}', { list: m.hooks.map((h) => t(h.name)).join(t('、')) })}</li>}
            {!!m.testSteps?.length && (
              <li>{t('测试步骤：{list}', { list: m.testSteps.map((s) => t(s.name)).join(t('、')) })}</li>
            )}
            {!!m.commands?.length && (
              <li>{t('「/」命令：{list}', { list: m.commands.map((c) => `/${c.name}`).join(t('、')) })}</li>
            )}
          </ul>
        </div>
      )}
    </Modal>
  )
}
