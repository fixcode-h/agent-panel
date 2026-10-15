import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { ArrowUp, Folder, FolderOpen, GitBranch, Loader2, X } from 'lucide-react'
import type { DirInfo, DirListing } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** 在服务端（也就是本机）浏览目录并选中一个 */
function DirBrowser({ open, start, onOpenChange, onPick }: {
  open: boolean
  start: string
  onOpenChange: (o: boolean) => void
  onPick: (path: string) => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [jump, setJump] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const go = async (p: string) => {
    setLoading(true)
    try {
      const l = await api.listDir(p)
      setListing(l)
      setJump(l.path)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) go(start)
  }, [open])

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-card shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none">
          <div className="flex items-center gap-3 border-b px-5 py-4">
            <D.Title className="text-[15px] font-semibold">选择项目目录</D.Title>
            <D.Description className="sr-only">浏览本机目录，选中项目所在的文件夹</D.Description>
            <D.Close className="ml-auto rounded-md p-1 text-muted hover:bg-sel hover:text-fg" aria-label="关闭">
              <X className="h-4 w-4" />
            </D.Close>
          </div>
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
              aria-label="上一级"
              title="上一级"
              disabled={!listing?.parent}
              onClick={() => listing?.parent && go(listing.parent)}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Input value={jump} onChange={(e) => setJump(e.target.value)} className="h-9 font-mono text-[12.5px]" aria-label="路径" />
          </form>
          <div className="min-h-[280px] flex-1 overflow-y-auto p-2">
            {loading && !listing && <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-subtle" />}
            {error && <p className="px-3 py-2 text-[13px] text-danger">{error}</p>}
            {listing?.dirs.map((d) => (
              <button
                key={d.path}
                onClick={() => go(d.path)}
                onDoubleClick={() => onPick(d.path)}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-sel"
              >
                <Folder className="h-4 w-4 text-subtle" />
                {d.name}
              </button>
            ))}
            {listing && listing.dirs.length === 0 && !error && (
              <p className="px-3 py-8 text-center text-[13px] text-subtle">这个目录下没有子目录</p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t bg-panel px-5 py-3">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={listing?.path}>
              {listing?.path}
            </span>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={!listing} onClick={() => listing && onPick(listing.path)}>
              选择此目录
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 检测路径：停止输入 400ms 后请求一次 */
export function useDirInfo(path: string) {
  const [info, setInfo] = useState<DirInfo | null>(null)
  useEffect(() => {
    if (!path.trim()) return setInfo(null)
    const t = setTimeout(() => api.inspectDir(path).then(setInfo).catch(() => setInfo(null)), 400)
    return () => clearTimeout(t)
  }, [path])
  return info
}

export function DirPicker({ value, onChange, info }: { value: string; onChange: (p: string) => void; info: DirInfo | null }) {
  const [browsing, setBrowsing] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">本地目录</span>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="例如 ~/code/my-app"
          className="font-mono text-[13px]"
          aria-label="本地目录"
        />
        <Button variant="secondary" className="h-10" onClick={() => setBrowsing(true)}>
          <FolderOpen className="h-4 w-4" />
          浏览
        </Button>
      </div>
      {value.trim() && info && (
        <span
          className={cn(
            'flex items-center gap-1.5 text-xs',
            info.exists && info.isDir ? 'text-success' : 'text-warning',
          )}
        >
          {!info.exists ? '目录不存在' : !info.isDir ? '这是一个文件，不是目录' : '目录存在'}
          {info.gitBranch && (
            <span className="ml-1 inline-flex items-center gap-1 text-muted">
              <GitBranch className="h-3 w-3" />
              {info.gitBranch}
            </span>
          )}
          {info.exists && info.path !== value.trim() && <span className="truncate text-subtle">· {info.path}</span>}
        </span>
      )}
      {!value.trim() && <span className="text-xs text-subtle">Agent 会在这个目录里执行任务。</span>}
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
