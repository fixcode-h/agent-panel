import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUpCircle, ChevronRight, CircleCheck, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { compareVersions, type AppRelease } from '@shared/version'
import { installRelease, loadReleases, useAppUpdate } from '@/lib/app-update'
import { renderDoc } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
const day = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Channel({ pre }: { pre: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[11px]',
        pre ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success',
      )}
    >
      {pre ? '预览版' : '正式版'}
    </span>
  )
}

/** 一个版本：标签、日期、更新说明（可展开），下载和切换 */
function ReleaseRow({
  r,
  current,
  canInstall,
  busy,
  onInstall,
}: {
  r: AppRelease
  current: string
  canInstall: boolean
  busy: boolean
  onInstall: (r: AppRelease) => void
}) {
  const [open, setOpen] = useState(false)
  const html = useMemo(() => (open ? renderDoc(r.notes || '没有更新说明。', new Set()) : ''), [open, r.notes])
  const isCur = r.version === current
  const newer = compareVersions(r.version, current) > 0
  return (
    <li className="flex flex-col border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
          title="查看更新说明"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
          <span className="truncate font-mono text-[13.5px] font-medium">{r.tag}</span>
        </button>
        <Channel pre={r.prerelease} />
        {isCur && <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] text-accent">当前</span>}
        <span className="text-xs text-subtle">{day(r.publishedAt)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <a
            href={r.zipUrl || r.tarUrl}
            target="_blank"
            rel="noreferrer"
            title={`下载 zip 包${r.size ? `（约 ${mb(r.size)}）` : ''}`}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted hover:bg-sel hover:text-fg"
          >
            <Download className="h-3.5 w-3.5" />
            下载
          </a>
          {!isCur && !import.meta.env.VITE_DEMO && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canInstall || busy}
              onClick={() => onInstall(r)}
              title={canInstall ? '下载并替换当前程序，数据会保留' : '只有发布的包能在这里切换版本'}
            >
              {newer ? '更新到此版本' : '切换到此版本'}
            </Button>
          )}
        </span>
      </div>
      {open && (
        <div className="mt-2 ml-5 flex flex-col gap-2 rounded-lg border bg-rail px-4 py-3">
          <div
            className="chat-md release-notes text-[13px] [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {r.url && (
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="flex w-fit items-center gap-1 text-xs text-accent hover:underline"
            >
              在 GitHub 上查看
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </li>
  )
}

/** 设置里的「版本更新」：当前版本、有没有新包、最近五个包（可下载、可切换） */
export function UpdateSection() {
  const { data, loading, job, restarting } = useAppUpdate()
  const [confirm, setConfirm] = useState<AppRelease | null>(null)
  const demo = !!import.meta.env.VITE_DEMO
  const current = data?.current ?? ''
  const canInstall = !!data?.packaged && !demo
  const running = job?.status === 'running' || !!restarting

  const install = (r: AppRelease) => {
    setConfirm(null)
    installRelease(r.tag).catch((e) => toast.error((e as Error).message))
  }
  const cur = data?.releases.find((r) => r.version === current)

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[13px] text-subtle">当前版本</span>
          <span className="font-mono text-[15px] font-semibold">{current ? `v${current.replace(/^v/, '')}` : '—'}</span>
          {cur ? <Channel pre={cur.prerelease} /> : current.includes('-dev') && <Channel pre />}
          {data && !data.packaged && !demo && (
            <span className="rounded-full bg-field px-1.5 py-px text-[11px] text-subtle">从源码运行</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={loading || running}
            onClick={() => loadReleases(true)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            检查更新
          </Button>
        </div>

        {job && running ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-fg">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                {restarting ? `已安装 v${restarting}，正在重启，完成后页面会自动刷新…` : `${job.tag} · ${job.phase}`}
              </span>
              {!restarting && job.total > 0 && (
                <span className="font-mono text-subtle">
                  {mb(job.received)} / {mb(job.total)}
                </span>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-field">
              <span
                className="block h-full rounded-full bg-accent transition-[width]"
                style={{
                  width: `${restarting ? 100 : job.total ? Math.min(100, (job.received / job.total) * 90) : 5}%`,
                }}
              />
            </div>
          </div>
        ) : data?.error ? (
          <p className="text-[13px] leading-relaxed text-warning">
            {data.error}。可以稍后再试，或到{' '}
            <a
              href="https://github.com/fixcode-h/agent-panel/releases"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              GitHub Releases
            </a>{' '}
            手动下载。
          </p>
        ) : !data ? (
          <p className="flex items-center gap-1.5 text-[13px] text-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在检查…
          </p>
        ) : data.update ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent-soft px-3.5 py-2.5">
            <ArrowUpCircle className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 text-[13px]">
              有新版本 <span className="font-mono font-medium">{data.update.tag}</span>
              <span className="text-subtle"> · {day(data.update.publishedAt)}</span>
            </span>
            {canInstall && (
              <Button size="sm" onClick={() => setConfirm(data.update!)}>
                更新到 {data.update.tag}
              </Button>
            )}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-[13px] text-success">
            <CircleCheck className="h-4 w-4" />
            已是最新版本
          </p>
        )}

        <p className="text-xs leading-relaxed text-subtle">
          {demo
            ? '在线演示不能安装，可以下载包到本机运行。'
            : canInstall
              ? '更新会下载 GitHub 上的包，替换程序文件后自动重启；data 目录里的数据会保留。有任务在执行时不能更新。'
              : '从源码运行时请用 git 拉取更新；这里可以查看和下载发布的包。'}
          {!demo && current.includes('-dev') && ' 当前是预览版，会提示所有更新的包；正式版只提示正式版。'}
        </p>
      </section>

      <section className="flex flex-col">
        <h3 className="pb-1 text-xs font-medium text-subtle">最近的版本</h3>
        {data?.releases.length ? (
          <ul className="flex flex-col">
            {data.releases.map((r) => (
              <ReleaseRow
                key={r.tag}
                r={r}
                current={current}
                canInstall={canInstall}
                busy={running}
                onInstall={setConfirm}
              />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[13px] text-subtle">{loading ? '正在读取…' : '暂时没有读到发布的包。'}</p>
        )}
      </section>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`${confirm && compareVersions(confirm.version, current) > 0 ? '更新' : '切换'}到 ${confirm?.tag ?? ''}？`}
        description={
          confirm && compareVersions(confirm.version, current) < 0
            ? '会下载这个较旧的包并替换当前程序，然后自动重启。旧版本可能读不懂新版本写的部分数据，建议先备份 data 目录。'
            : '会下载这个包并替换当前程序，然后自动重启。data 目录里的数据会保留。'
        }
        confirmText={confirm && compareVersions(confirm.version, current) > 0 ? '更新' : '切换'}
        onConfirm={() => confirm && install(confirm)}
      />
    </div>
  )
}
