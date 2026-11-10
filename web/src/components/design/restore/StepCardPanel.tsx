import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, RotateCcw } from 'lucide-react'
import { t } from '@shared/i18n'
import { stepOf, type RestoreState, type RestoreStep } from '@shared/restore/schema'
import { stepName } from '@shared/restore/steps'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'

/**
 * 每一步的决策卡（右栏）：这一版的结论、要你做什么、数字、要注意的、和上一版比改了什么。
 * 下面两个按钮：带着意见重新跑这一步（出新的一版），或者确认进下一步。往回翻版本只看，不回滚
 */
export function StepCardPanel({
  restore,
  step,
  busy,
  onRun,
  onConfirm,
}: {
  restore: RestoreState
  step: RestoreStep
  /** 有步骤在跑（这一步或别的） */
  busy: boolean
  onRun: (feedback: string) => void
  onConfirm: () => void
}) {
  const st = stepOf(restore, step)
  const [pick, setPick] = useState<number>()
  const [feedback, setFeedback] = useState('')
  // 出了新的一版就跳到最新那版
  useEffect(() => setPick(undefined), [st.versions.length, step])
  const v = pick !== undefined ? st.versions.find((x) => x.n === pick) : st.versions.at(-1)
  const card = v?.card
  const latest = !v || v.n === st.versions.at(-1)?.n

  return (
    <div data-restore-card={step} data-status={st.status} className="flex shrink-0 flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <span className="text-body font-semibold">{stepName(step)}</span>
        {st.versions.length > 0 && (
          <div className="flex items-center gap-0.5" role="tablist" aria-label={t('版本')}>
            {st.versions.map((x) => (
              <button
                key={x.n}
                type="button"
                role="tab"
                aria-selected={x.n === v?.n}
                onClick={() => setPick(x.n)}
                className={cn(
                  'h-6 cursor-pointer rounded-md px-1.5 text-caption tabular-nums transition-colors',
                  x.n === v?.n ? 'bg-active text-fg' : 'text-subtle hover:bg-hover hover:text-fg',
                )}
              >
                v{x.n}
              </button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        <StatusTag status={st.status} />
      </div>

      {st.status === 'running' && (
        <div className="flex items-center gap-2 rounded-lg bg-panel px-3 py-2 text-body text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('正在{step}…', { step: stepName(step) })}
        </div>
      )}
      {st.status === 'failed' && st.error && (
        <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-body break-words text-danger">
          {st.error}
        </div>
      )}
      {st.status === 'stale' && (
        <div className="rounded-lg bg-warning/10 px-3 py-2 text-body text-warning">
          {t('前面的步骤改过了，这一步要重新跑')}
        </div>
      )}

      {card ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-body leading-relaxed font-medium">{card.conclusion}</p>
          {card.metrics.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              {card.metrics.map((m) => (
                <div key={m.label} className="rounded-lg bg-panel px-2.5 py-1.5">
                  <div className="text-caption text-subtle">{m.label}</div>
                  <div
                    className={cn(
                      'text-body font-semibold tabular-nums',
                      m.ok === false ? 'text-warning' : m.ok ? 'text-success' : 'text-fg',
                    )}
                  >
                    {m.value}
                  </div>
                </div>
              ))}
            </div>
          )}
          {card.diff && (
            <p className="text-footnote text-muted">
              {t('比上一版：')}
              {card.diff}
            </p>
          )}
          {card.warnings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {card.warnings.map((w) => (
                <li key={w} className="flex gap-1.5 text-footnote text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">{w}</span>
                </li>
              ))}
            </ul>
          )}
          {card.note && <p className="rounded-lg bg-panel px-2.5 py-2 text-footnote text-muted">{card.note}</p>}
          {card.todo && latest && <p className="text-footnote text-subtle">{card.todo}</p>}
          {v?.feedback && (
            <p className="text-footnote text-subtle">
              {t('这一版的意见：')}
              {v.feedback}
            </p>
          )}
        </div>
      ) : (
        st.status !== 'running' && <p className="text-body text-subtle">{t('这一步还没开始')}</p>
      )}

      {step !== 'source' && (
        <Textarea
          rows={3}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={t('哪里不对？写下意见再重新跑这一步（可以不写）')}
          aria-label={t('意见')}
          disabled={busy}
        />
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {step !== 'source' && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              onRun(feedback)
              setFeedback('')
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {st.versions.length ? t('重新跑这一步') : t('运行这一步')}
          </Button>
        )}
        <Button size="sm" disabled={busy || st.status !== 'review'} onClick={onConfirm} data-restore-confirm>
          <Check className="h-3.5 w-3.5" />
          {step === 'deliver' ? t('确认交付') : t('确认，下一步')}
        </Button>
      </div>
    </div>
  )
}

function StatusTag({ status }: { status: string }) {
  const label: Record<string, string> = {
    todo: t('未开始'),
    running: t('运行中'),
    review: t('等你确认'),
    done: t('已确认'),
    stale: t('要更新'),
    failed: t('失败'),
  }
  return (
    <span
      className={cn(
        'rounded-md px-1.5 py-0.5 text-caption',
        status === 'done'
          ? 'bg-success/10 text-success'
          : status === 'failed'
            ? 'bg-danger/10 text-danger'
            : status === 'review'
              ? 'bg-accent-soft text-accent-text'
              : status === 'stale'
                ? 'bg-warning/10 text-warning'
                : 'bg-hover text-subtle',
      )}
    >
      {label[status] ?? status}
    </span>
  )
}
