import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { ArrowUp, Folder, FolderOpen, FolderPlus, GitBranch, HardDrive, House, Loader2 } from 'lucide-react'
import type { DirInfo, DirListing } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal, ModalHeader } from '@/components/ui/modal'
import { ChipGroup } from '@/components/ui/chip-group'
import { t } from '@shared/i18n'

/** 找出包含 p 的最长的入口路径；Windows 盘符不区分大小写 */
function bestRoot(roots: { path: string }[], p: string) {
  const norm = (x: string) => x.replace(/[\\/]+$/, '').toLowerCase()
  const target = norm(p)
  let best = ''
  for (const r of roots) {
    const root = norm(r.path)
    const inside = target === root || target.startsWith(root + '/') || target.startsWith(root + '\\') || root === ''
    if (inside && r.path.length > best.length) best = r.path
  }
  return best
}

/** 在服务端（也就是本机）浏览目录并选中一个 */
function DirBrowser({
  open,
  start,
  onOpenChange,
  onPick,
}: {
  open: boolean
  start: string
  onOpenChange: (o: boolean) => void
  onPick: (path: string) => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [jump, setJump] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // 新建文件夹：null 表示没在新建，字符串是正在输入的名字
  const [creating, setCreating] = useState<string | null>(null)
  const [createError, setCreateError] = useState('')
  const [busy, setBusy] = useState(false)
  // 刚建好的文件夹：列表里高亮，方便直接选中
  const [fresh, setFresh] = useState('')

  const go = async (p: string) => {
    setLoading(true)
    setCreating(null)
    setCreateError('')
    try {
      const l = await api.listDir(p)
      setListing(l)
      setJump(l.path)
      setError('')
    } catch (e) {
      // 跳转失败时不能再停留在旧目录上，否则「选择此目录」会选中旧目录
      setListing(null)
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const create = async () => {
    if (!listing || creating === null || busy) return
    if (!creating.trim()) return setCreating(null)
    setBusy(true)
    try {
      const { path } = await api.makeDir(listing.path, creating)
      // 留在当前目录，新文件夹高亮出来：用户可以双击进入或直接选它
      await go(listing.path)
      setFresh(path)
    } catch (e) {
      setCreateError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (open) go(start)
    // 打开时跳到起始目录，之后由用户浏览
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={null}
      bare
      closeOnOutside
      // 正在输入新文件夹名时，Esc 只取消新建，不关掉整个弹窗
      onEscapeKeyDown={(e) => {
        if (creating === null) return
        e.preventDefault()
        setCreating(null)
        setCreateError('')
      }}
      className="max-h-[80vh] max-w-[560px]"
    >
      <ModalHeader icon={FolderOpen} title={t('选择项目目录')}>
        <D.Description className="sr-only">{t('浏览本机目录，选中项目所在的文件夹')}</D.Description>
      </ModalHeader>
      <form
        className="flex gap-2 border-b px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          go(jump)
        }}
      >
        <Button
          variant="secondary"
          size="icon"
          aria-label={t('上一级')}
          title={t('上一级')}
          disabled={!listing?.parent}
          onClick={() => listing?.parent && go(listing.parent)}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Input
          value={jump}
          onChange={(e) => setJump(e.target.value)}
          className="h-9 font-mono text-[0.75rem]"
          aria-label={t('路径')}
        />
      </form>
      {listing?.roots && listing.roots.length > 0 && (
        <nav className="border-b px-5 py-2.5">
          {/* 当前路径落在哪个盘 / 位置下就高亮哪个；主目录优先于它所在的盘。点选中的那块也会跳回它的根 */}
          <ChipGroup
            label={t('磁盘和常用位置')}
            size="sm"
            value={bestRoot(listing.roots, listing.path) ?? ''}
            onChange={go}
            options={listing.roots.map((r, i) => {
              const Icon = i === 0 ? House : HardDrive
              return { id: r.path, label: r.name, title: r.path, icon: <Icon className="h-3.5 w-3.5" /> }
            })}
          />
        </nav>
      )}
      <div className="min-h-[280px] flex-1 overflow-y-auto p-2">
        {loading && !listing && <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-subtle" />}
        {error && <p className="px-3 py-2 text-[0.8125rem] text-danger">{error}</p>}
        {creating !== null && (
          <div className="mb-1">
            <div className="flex items-center gap-2.5 rounded-lg bg-sel/60 px-3 py-1.5">
              {busy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent-text" />
              ) : (
                <FolderPlus className="h-4 w-4 shrink-0 text-accent-text" />
              )}
              <Input
                size="sm"
                autoFocus
                value={creating}
                disabled={busy}
                onChange={(e) => {
                  setCreating(e.target.value)
                  setCreateError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void create()
                  }
                }}
                onBlur={() => !creating.trim() && !busy && setCreating(null)}
                placeholder={t('新文件夹名，回车创建')}
                aria-label={t('新文件夹名')}
                className="h-7 min-w-0 flex-1 px-2"
              />
            </div>
            {createError && <p className="px-3 pt-1 text-[0.75rem] text-danger">{createError}</p>}
          </div>
        )}
        {listing?.dirs.map((d) => (
          <button
            key={d.path}
            ref={(el) => {
              if (el && d.path === fresh) el.scrollIntoView({ block: 'nearest' })
            }}
            onClick={() => go(d.path)}
            onDoubleClick={() => onPick(d.path)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.8125rem] hover:bg-sel',
              d.path === fresh && 'bg-accent/12 text-fg',
            )}
          >
            <Folder className={cn('h-4 w-4', d.path === fresh ? 'text-accent-text' : 'text-subtle')} />
            {d.name}
          </button>
        ))}
        {listing && listing.dirs.length === 0 && !error && creating === null && (
          <p className="px-3 py-8 text-center text-[0.8125rem] text-subtle">{t('这个目录下没有子目录')}</p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t bg-panel px-5 py-3">
        <Button
          variant="ghost"
          disabled={!listing || creating !== null}
          onClick={() => {
            setCreating('')
            setCreateError('')
          }}
          title={t('在当前目录下新建文件夹')}
        >
          <FolderPlus className="h-4 w-4" />
          {t('新建文件夹')}
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={listing?.path}>
          {listing?.path}
        </span>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          {t('取消')}
        </Button>
        <Button disabled={!listing} onClick={() => listing && onPick(listing.path)}>
          {t('选择此目录')}
        </Button>
      </div>
    </Modal>
  )
}

const dirCache = new Map<string, DirInfo | null>()
// 切了分支之类的改动后，让正在用这个目录的地方重新读一次
const dirListeners = new Set<() => void>()

/** 切了分支之类的改动后，让正在用这个目录的地方重新读一次（先留着旧结果，读完再换，不闪） */
export function refreshDirInfo() {
  for (const f of dirListeners) f()
}

// 分支也可能在面板外面改（编辑器、命令行里切分支）：页面重新出现或窗口获得焦点时重读一次，
// 否则目录信息一直停在缓存里的旧分支上
if (typeof window !== 'undefined') {
  const wake = () => {
    if (document.hidden) return
    dirCache.clear()
    refreshDirInfo()
  }
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
}

/**
 * 检测路径：停止输入 400ms 后请求一次。
 * 返回 undefined 表示还在检查（不要当成「目录不存在」），null 表示没有路径或检查失败；
 * 结果只对应当前路径，改路径时不会继续显示旧路径的结果。
 */
export function useDirInfo(path: string): DirInfo | null | undefined {
  const key = path.trim()
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{ key: string; info: DirInfo | null }>(() => ({
    key,
    info: dirCache.get(key) ?? null,
  }))
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    dirListeners.add(bump)
    return () => {
      dirListeners.delete(bump)
    }
  }, [])
  useEffect(() => {
    if (!key) return
    let alive = true
    const t = setTimeout(
      () =>
        api
          .inspectDir(key)
          .then((info) => info)
          .catch(() => null)
          .then((info) => {
            dirCache.set(key, info)
            if (alive) setState({ key, info })
          }),
      dirCache.has(key) ? 0 : 400,
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [key, version])
  if (!key) return null
  if (state.key === key) return state.info
  return dirCache.has(key) ? dirCache.get(key)! : undefined
}

export function DirPicker({
  value,
  onChange,
  info,
  hint,
  label = t('本地目录'),
}: {
  value: string
  onChange: (p: string) => void
  info: DirInfo | null | undefined
  /** 没填路径时的说明 */
  hint?: string
  /** 输入框上面的标题（项目设置里 P4 的 cherry-pick 目标路径也用这个选择器） */
  label?: string
}) {
  const [browsing, setBrowsing] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('例如 ~/code/my-app')}
          className="font-mono text-[0.8125rem]"
          aria-label={label}
        />
        <Button variant="secondary" className="h-10" onClick={() => setBrowsing(true)}>
          <FolderOpen className="h-4 w-4" />
          {t('浏览')}
        </Button>
      </div>
      {value.trim() && info === undefined && (
        <span className="flex items-center gap-1.5 text-xs text-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('正在检查目录…')}
        </span>
      )}
      {value.trim() && info && (
        <span
          className={cn(
            'flex items-center gap-1.5 text-xs',
            info.exists && info.isDir ? 'text-success' : 'text-warning',
          )}
        >
          {!info.exists ? t('目录不存在') : !info.isDir ? t('这是一个文件，不是目录') : t('目录存在')}
          {info.gitBranch && (
            <span className="ml-1 inline-flex items-center gap-1 text-muted">
              <GitBranch className="h-3 w-3" />
              {info.gitBranch}
            </span>
          )}
          {info.exists && info.path !== value.trim() && <span className="truncate text-subtle">· {info.path}</span>}
        </span>
      )}
      {!value.trim() && <span className="text-xs text-subtle">{hint ?? t('Agent 会在这个目录里执行任务。')}</span>}
      <DirBrowser
        open={browsing}
        start={info?.exists && info.isDir ? info.path : ''}
        onOpenChange={setBrowsing}
        onPick={(p) => {
          onChange(p)
          setBrowsing(false)
        }}
      />
    </div>
  )
}
