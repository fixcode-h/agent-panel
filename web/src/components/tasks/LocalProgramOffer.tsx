import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { localProgramsContract as C } from '@shared/api-contract/local-programs'
import type { ProgramOffer } from '@shared/local-programs/defs'
import { t } from '@shared/i18n'
import { call } from '@/lib/api/call'
import { useBgJobs } from '@/lib/live/bg-jobs'
import { useProgramOffers } from '@/lib/live/local-programs'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * 输入框上方的「本机没装 X」卡片（用户 2026-11-26：不在对话里插提示行，直接在输入框上面弹，拒绝和安装两个按钮，点了直接装）。
 * 面板哪个功能发现缺程序就在服务端报一次（server/local-programs/offers.ts），所有打开的对话都看得到同一张卡；
 * 点安装开一条后台作业（侧栏底部能看日志、取消），装好卡片自己消失，失败留着原因和手动命令。拒绝管到面板重启
 */
export function LocalProgramOffers({ className }: { className?: string }) {
  const [offers, setOffers] = useProgramOffers()
  if (!offers.length) return null
  return (
    <>
      {offers.map((o) => (
        <OfferCard key={o.id} offer={o} onOffers={setOffers} className={className} />
      ))}
    </>
  )
}

function OfferCard({
  offer: o,
  onOffers,
  className,
}: {
  offer: ProgramOffer
  onOffers: (list: ProgramOffer[]) => void
  className?: string
}) {
  const [busy, setBusy] = useState<'' | 'install' | 'decline'>('')
  const [jobs] = useBgJobs()
  const job = o.jobId ? jobs.find((j) => j.id === o.jobId) : undefined
  const installing = !!o.jobId
  const act = async (what: 'install' | 'decline') => {
    setBusy(what)
    try {
      const r = await call(what === 'install' ? C.install : C.decline, { params: { id: o.id }, body: {} })
      onOffers(r.offers)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const spin = (w: typeof busy) => busy === w && <Loader2 className="h-3.5 w-3.5 animate-spin" />
  return (
    <div
      role="alertdialog"
      aria-label={t('本机没装 {name}', { name: o.name })}
      data-program-offer={o.id}
      className={cn(
        'mx-auto mb-2 w-full max-w-(--content-w) overflow-hidden rounded-2xl border border-accent/40 bg-card shadow-card animate-[pop-in_160ms_ease-out]',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-accent/20 bg-accent/8 px-4 py-2 text-xs">
        <Download className="h-3.5 w-3.5 text-accent-text" />
        <span className="font-medium text-accent-text">{t('本机没装 {name}', { name: o.name })}</span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <span className="text-body leading-relaxed">{o.why}</span>
        {installing && (
          <div className="flex min-w-0 items-center gap-2 text-footnote text-muted">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="truncate font-mono" title={job?.phase}>
              {job?.phase ? t('正在安装：{step}', { step: job.phase }) : t('正在安装…')}
            </span>
          </div>
        )}
        {!installing && o.error && (
          <pre className="max-h-32 overflow-auto rounded-lg bg-danger/8 px-3 py-2 font-mono text-footnote leading-relaxed whitespace-pre-wrap text-danger">
            {o.error}
          </pre>
        )}
        {!installing && (o.error || !o.canInstall) && o.installHint && (
          <div className="flex flex-col gap-1 text-footnote text-muted">
            <span>
              {o.canInstall
                ? t('也可以在终端里自己装，装好后不用重启面板：')
                : t('这台电脑上找不到能自动安装的包管理器，请在终端里手动装，装好后不用重启面板：')}
            </span>
            <pre className="rounded-lg bg-field px-3 py-2 font-mono whitespace-pre-wrap select-all">
              {o.installHint}
            </pre>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            data-offer="decline"
            onClick={() => void act('decline')}
          >
            {spin('decline')}
            {t('拒绝')}
          </Button>
          <Button
            size="sm"
            disabled={!!busy || installing || !o.canInstall}
            data-offer="install"
            title={o.installHint}
            onClick={() => void act('install')}
          >
            {spin('install')}
            {installing ? t('正在安装…') : o.error ? t('重新安装') : t('安装')}
          </Button>
        </div>
      </div>
    </div>
  )
}
