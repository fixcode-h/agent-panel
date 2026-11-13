import { useRef, useState } from 'react'
import { ChevronDown, FolderOpen, Loader2, Plus, RefreshCw, Store, Upload, WifiOff } from 'lucide-react'
import { t } from '@shared/i18n'
import { timeAgo } from '@shared/task'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { Modal } from '@/components/ui/modal'
import { pluginApi, type InstallPreview } from './api'
import { marketError, refreshMarket, switchMarket, useMarket } from './market'
import { usePluginUpdates } from './updates'

/**
 * 插件页顶上的一行：当前市场仓库（点开可换）、多久前读的（读失败时写明在用旧结果）、「刷新」和「其他方式安装」。
 * 刷新同时重读市场和检查更新；其他方式（上传压缩包、链接本机目录）收进下拉菜单，平时不占地方。
 */
export function MarketBar({ onPreview }: { onPreview: (p: InstallPreview) => void }) {
  const { result, loading } = useMarket()
  const { checking } = usePluginUpdates()
  const busy = loading || checking
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs text-subtle">
        <Store className="h-3.5 w-3.5 shrink-0" />
        <span>{t('插件市场')}</span>
        <RepoPicker />
        {loading ? (
          <span>· {t('正在读取…')}</span>
        ) : result?.error ? (
          <span className="inline-flex items-center gap-1 text-warning" title={result.error}>
            · <WifiOff className="h-3 w-3" />
            {t('读取失败，显示的是 {time}的结果', { time: timeAgo(result.fetchedAt) })}
          </span>
        ) : (
          result && <span>· {t('{time}更新', { time: timeAgo(result.fetchedAt) })}</span>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={() => void refreshMarket()} disabled={busy}>
        <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        {t('刷新')}
      </Button>
      <OtherSources onPreview={onPreview} />
    </div>
  )
}

/** 仓库名，点开改：换的仓库服务端记住，下次打开还是它 */
function RepoPicker() {
  const { result, loading, error } = useMarket()
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState('')
  const cur = result?.repo ?? ''
  const read = async (to: string) => {
    if (!to.trim()) return
    await switchMarket(to.trim())
    // 读失败时弹层留着，错误写在里面
    if (!marketError()) setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setRepo(cur)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('换插件市场仓库')}
          className="inline-flex items-center gap-0.5 rounded-sm px-1 font-mono text-fg hover:bg-hover"
        >
          {cur || '…'}
          <ChevronDown className="h-3 w-3 text-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-3">
        <p className="pb-1.5 text-xs font-medium text-muted">{t('插件市场仓库')}</p>
        <Input
          aria-label={t('插件仓库')}
          value={repo}
          placeholder={result?.defaultRepo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void read(repo)}
          className="font-mono"
        />
        <p className="mt-1.5 text-xs leading-relaxed text-subtle">
          {t('GitHub 仓库（owner/repo）。仓库根上的 plugins.json 列出里面的插件；没有的话整个仓库当作一个插件。')}
        </p>
        {error && <p className="mt-1.5 text-xs break-all text-danger">{error}</p>}
        <div className="mt-3 flex items-center gap-2">
          {result && cur !== result.defaultRepo && (
            <Button size="sm" variant="link" tone="muted" onClick={() => void read(result.defaultRepo)}>
              {t('恢复默认')}
            </Button>
          )}
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setOpen(false)}>
            {t('取消')}
          </Button>
          <Button size="sm" onClick={() => void read(repo)} disabled={loading || !repo.trim()}>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('读取')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 其他安装方式：上传压缩包、链接本机目录（开发插件时链接构建产物，不复制） */
function OtherSources({ onPreview }: { onPreview: (p: InstallPreview) => void }) {
  const [askDir, setAskDir] = useState(false)
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const run = async (f: () => Promise<InstallPreview>) => {
    setBusy(true)
    try {
      onPreview(await f())
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
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
      <Menu modal={false}>
        <MenuTrigger asChild>
          <Button size="sm" variant="secondary" disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t('其他方式安装')}
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={() => file.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            {t('上传压缩包（.zip）')}
          </MenuItem>
          <MenuItem onSelect={() => setAskDir(true)}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t('链接本机目录（开发）')}
          </MenuItem>
        </MenuContent>
      </Menu>
      <Modal
        open={askDir}
        onOpenChange={(o) => !o && !busy && setAskDir(false)}
        title={t('链接本机目录')}
        footer={
          <>
            <Button variant="secondary" className="ml-auto" onClick={() => setAskDir(false)} disabled={busy}>
              {t('取消')}
            </Button>
            <Button
              onClick={() => void run(() => pluginApi.fromDir(dir.trim())).then((ok) => ok && setAskDir(false))}
              disabled={busy || !dir.trim()}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('链接')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          <Input
            aria-label={t('插件目录')}
            value={dir}
            placeholder="/path/to/agent-plugins/blender/dist"
            onChange={(e) => setDir(e.target.value)}
            className="font-mono"
          />
          <span className="text-xs text-subtle">
            {t('链接本机的插件构建目录，不复制：重新构建后关掉再打开插件就生效。')}
          </span>
        </div>
      </Modal>
    </>
  )
}
