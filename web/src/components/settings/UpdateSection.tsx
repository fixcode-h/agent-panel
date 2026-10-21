import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowUpCircle,
  ChevronRight,
  CircleCheck,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Undo2,
  Zap,
} from 'lucide-react'
import { compareVersions, type AppRelease } from '@shared/version'
import {
  adoptRunningJob,
  forceInstallRelease,
  installRelease,
  loadReleases,
  rollbackRelease,
  useAppUpdate,
} from '@/lib/app-update'
import { renderDoc } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { t } from '@shared/i18n'
import { AiFixButton } from '@/components/ui/ai-fix'

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
/** 上次检查的时间：今天只写时分，别的日子带上日期 */
const checkedTime = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? hm : `${day(iso)} ${hm}`
}
const day = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 发布这些包的时间：日期后面带上时分秒 */
const dateTime = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${day(iso)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

function Channel({ pre }: { pre: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[0.6875rem]',
        pre ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success',
      )}
    >
      {pre ? t('预览版') : t('正式版')}
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
  const html = useMemo(() => (open ? renderDoc(r.notes || t('没有更新说明。'), new Set()) : ''), [open, r.notes])
  const isCur = r.version === current
  const newer = compareVersions(r.version, current) > 0
  return (
    <li className="flex flex-col border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
          title={t('查看更新说明')}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
          <span className="truncate font-mono text-[0.84375rem] font-medium">{r.tag}</span>
        </button>
        <Channel pre={r.prerelease} />
        {isCur && (
          <span className="rounded-full bg-accent-soft px-1.5 py-px text-[0.6875rem] text-accent">{t('当前')}</span>
        )}
        <span className="font-mono text-xs text-subtle">{dateTime(r.publishedAt)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <a
            href={r.zipUrl || r.tarUrl}
            target="_blank"
            rel="noreferrer"
            title={r.size ? t('下载 zip 包（约 {size}）', { size: mb(r.size) }) : t('下载 zip 包')}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] text-muted hover:bg-sel hover:text-fg"
          >
            <Download className="h-3.5 w-3.5" />
            {t('下载')}
          </a>
          {!isCur && !import.meta.env.VITE_DEMO && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canInstall || busy}
              onClick={() => onInstall(r)}
              title={canInstall ? t('下载并替换当前程序，数据会保留') : t('只有发布的包能在这里切换版本')}
            >
              {newer ? t('更新到此版本') : t('切换到此版本')}
            </Button>
          )}
        </span>
      </div>
      {open && (
        <div className="mt-2 ml-5 flex flex-col gap-2 rounded-lg border bg-rail px-4 py-3">
          <div
            className="chat-md release-notes text-[0.8125rem] [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {r.url && (
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="flex w-fit items-center gap-1 text-xs text-accent hover:underline"
            >
              {t('在 GitHub 上查看')}
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
  const [undo, setUndo] = useState(false)
  const [force, setForce] = useState(false)
  const demo = !!import.meta.env.VITE_DEMO
  const current = data?.current ?? ''
  const canInstall = !!data?.packaged && !demo
  const running = job?.status === 'running' || !!restarting

  // 打开「版本更新」就马上检查一次，不等自动检查的间隔
  useEffect(() => {
    if (!running) void loadReleases(true)
    // 只在打开时检查；安装中途不重新检查
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const install = (r: AppRelease) => {
    setConfirm(null)
    // 撞上「已经在更新」时 installRelease 会把那一次的进度放进 job，这里刷新页面也不会丢
    installRelease(r.tag).catch((e) => toast.error((e as Error).message))
  }
  const cur = data?.releases.find((r) => r.version === current)

  // 上次的更新还在跑（页面刷新过、上次没等到结束）：接管它，把进度和「强制更新」显示出来，
  // 否则界面看起来像什么都没发生，再点更新也只会收到一句「正在更新」
  useEffect(() => {
    if (job?.status === 'running' || restarting) return
    void adoptRunningJob().catch(() => {})
    // 只在打开时接一次；之后由 job 自己的轮询更新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[0.8125rem] text-subtle">{t('当前版本')}</span>
          <span className="font-mono text-[0.9375rem] font-semibold">
            {current ? `v${current.replace(/^v/, '')}` : '—'}
          </span>
          {cur ? <Channel pre={cur.prerelease} /> : current.includes('-dev') && <Channel pre />}
          {data && !data.packaged && !demo && (
            <span className="rounded-full bg-field px-1.5 py-px text-[0.6875rem] text-subtle">{t('从源码运行')}</span>
          )}
          {data?.checkedAt && (
            <span className="ml-auto text-xs text-subtle">
              {t('上次检查 {time}', { time: checkedTime(data.checkedAt) })}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={cn(!data?.checkedAt && 'ml-auto')}
            disabled={loading || running}
            onClick={() => loadReleases(true)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('检查更新')}
          </Button>
        </div>

        {running ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-fg">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                {restarting
                  ? t('已安装 v{version}，正在重启，完成后页面会自动刷新…', { version: restarting })
                  : `${job?.tag} · ${job?.phase}`}
              </span>
              {!restarting && job && job.total > 0 && (
                <span className="font-mono text-subtle">
                  {mb(job.received)} / {mb(job.total)}
                </span>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-field">
              <span
                className="block h-full rounded-full bg-accent transition-[width]"
                style={{
                  width: `${restarting ? 100 : job?.total ? Math.min(100, (job.received / job.total) * 90) : 5}%`,
                }}
              />
            </div>
            {!restarting && job?.waiting && (
              // 下载完了却还有任务在执行：不用一个个去停，直接中断所有 CLI 立刻更新
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="mr-auto text-xs text-subtle">
                  {t('新版本已经下载完，等正在执行的任务结束后才会替换并重启；也可以现在强制更新。')}
                </span>
                <Button size="sm" variant="secondary" onClick={() => setForce(true)}>
                  <Zap className="h-3.5 w-3.5" />
                  {t('强制更新')}
                </Button>
              </div>
            )}
          </div>
        ) : data?.error ? (
          <p className="text-[0.8125rem] leading-relaxed text-warning">
            {data.error}
            {t('。可以稍后再试，或到')}{' '}
            <a
              href="https://github.com/fixcode-h/agent-panel/releases"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              GitHub Releases
            </a>{' '}
            {t('手动下载。')}
            <AiFixButton
              variant="ghost"
              className="ml-1 h-6 px-1.5 align-middle text-xs"
              issue={{
                title: t('检查面板更新失败'),
                error: data.error,
                context: '面板从 GitHub Releases（fixcode-h/agent-panel）检查新版本时出错，常见原因是网络或代理。',
              }}
            />
          </p>
        ) : !data ? (
          <p className="flex items-center gap-1.5 text-[0.8125rem] text-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('正在检查…')}
          </p>
        ) : data.update ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent-soft px-3.5 py-2.5">
            <ArrowUpCircle className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 text-[0.8125rem]">
              {t('有新版本')} <span className="font-mono font-medium">{data.update.tag}</span>
              <span className="text-subtle"> · {dateTime(data.update.publishedAt)}</span>
            </span>
            {canInstall && (
              <Button size="sm" onClick={() => setConfirm(data.update!)}>
                {t('更新到 {tag}', { tag: data.update.tag })}
              </Button>
            )}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-[0.8125rem] text-success">
            <CircleCheck className="h-4 w-4" />
            {t('已是最新版本')}
          </p>
        )}

        <p className="text-xs leading-relaxed text-subtle">
          {demo
            ? t('在线演示不能安装，可以下载包到本机运行。')
            : canInstall
              ? t(
                  '更新会下载 GitHub 上的包，替换程序文件后自动重启；data 目录里的数据会保留。有任务在执行时会先下载，等所有任务结束后再替换。',
                )
              : t('从源码运行时请用 git 拉取更新；这里可以查看和下载发布的包。')}
          {!demo && current.includes('-dev') && ' ' + t('当前是预览版，会提示所有更新的包；正式版只提示正式版。')}
        </p>
        {canInstall && data?.previous && data.previous !== current && (
          // 更新前留下的版本：新版本有问题时可以直接换回去，不用重新下载
          <Button size="sm" variant="ghost" className="w-fit" disabled={running} onClick={() => setUndo(true)}>
            <Undo2 className="h-3.5 w-3.5" />
            {t('回到上一个版本 v{version}', { version: data.previous })}
          </Button>
        )}
      </section>

      <section className="flex flex-col">
        <h3 className="pb-1 text-xs font-medium text-subtle">{t('最近的版本')}</h3>
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
          <p className="py-3 text-[0.8125rem] text-subtle">{loading ? t('正在读取…') : t('暂时没有读到发布的包。')}</p>
        )}
      </section>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm && compareVersions(confirm.version, current) > 0
            ? t('更新到 {tag}？', { tag: confirm?.tag ?? '' })
            : t('切换到 {tag}？', { tag: confirm?.tag ?? '' })
        }
        description={
          confirm && compareVersions(confirm.version, current) < 0
            ? t(
                '会下载这个较旧的包并替换当前程序，然后自动重启。旧版本可能读不懂新版本写的部分数据，建议先备份 data 目录。',
              )
            : t('会下载这个包并替换当前程序，然后自动重启。data 目录里的数据会保留。')
        }
        confirmText={confirm && compareVersions(confirm.version, current) > 0 ? t('更新') : t('切换')}
        onConfirm={() => confirm && install(confirm)}
      />
      <ConfirmDialog
        open={undo}
        onOpenChange={setUndo}
        title={t('回到 v{version}？', { version: data?.previous ?? '' })}
        description={t('会换回更新前的程序文件，然后自动重启，数据会保留。之后还可以再换回当前版本。')}
        confirmText={t('回到上一个版本')}
        onConfirm={() => {
          setUndo(false)
          rollbackRelease().catch((e) => toast.error((e as Error).message))
        }}
      />
      <ConfirmDialog
        open={force}
        onOpenChange={setForce}
        title={t('强制更新？')}
        description={t(
          '会中断所有正在执行的 CLI 对话，没做完的内容可能丢失；然后马上替换程序文件并重启，data 目录里的数据会保留。',
        )}
        confirmText={t('强制更新')}
        onConfirm={() => {
          setForce(false)
          forceInstallRelease().catch((e) => toast.error((e as Error).message))
        }}
      />
    </div>
  )
}
