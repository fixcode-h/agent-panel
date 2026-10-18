// AI 问你的问题：显示在输入框的位置（换掉输入框），一次可以问好几个，全部回答完再一起交回去。
// 每个问题的选项最后一项都是「自己输入」。任务对话（CLI 的提问）和 UI 设计（AI 问风格等）共用
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, Loader2, MessageCircleQuestion, PencilLine } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

export interface PanelQuestion {
  /** 很短的标签，多个问题时显示在页签上 */
  header?: string
  question: string
  options: { label: string; description?: string }[]
  /** 可以选多个 */
  multiSelect?: boolean
}

interface Answer {
  picked: number[]
  /** 自己输入的 */
  text: string
  /** 选中了「自己输入」 */
  own: boolean
}

const empty = (): Answer => ({ picked: [], text: '', own: false })
const done = (a: Answer) => a.picked.length > 0 || (a.own && !!a.text.trim())

/** 一个问题的回答写成一句话：选的选项和自己写的，用顿号连起来 */
const answerText = (q: PanelQuestion, a: Answer) =>
  [...a.picked.map((i) => q.options[i]?.label ?? ''), ...(a.own && a.text.trim() ? [a.text.trim()] : [])]
    .filter(Boolean)
    .join('、')

export function QuestionPanel({
  questions,
  onSubmit,
  onSkip,
  skipLabel,
  who,
  className,
}: {
  questions: PanelQuestion[]
  /** 每个问题一个回答（按顺序）；返回 Promise 时提交中显示转圈 */
  onSubmit: (answers: string[], picked: number[][]) => unknown
  /** 不回答（让 AI 自己选）或改用输入框；不给就没有这个按钮 */
  onSkip?: () => unknown
  skipLabel?: string
  /** 谁在问：Agent 的名字 */
  who?: React.ReactNode
  className?: string
}) {
  const n = questions.length
  const [at, setAt] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(empty))
  const [busy, setBusy] = useState(false)
  const own = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // 换了一组问题（下一个请求）：从头开始
  const key = questions.map((q) => q.question).join('\n')
  useEffect(() => {
    setAt(0)
    setAnswers(questions.map(empty))
    box.current?.focus({ preventScroll: true })
    // 只在问题变了时重置
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const q = questions[Math.min(at, n - 1)]
  const a = answers[at] ?? empty()
  const last = at === n - 1
  const all = answers.every(done)
  if (!q) return null

  const set = (next: Answer) => setAnswers((list) => list.map((x, i) => (i === at ? next : x)))
  const submit = async () => {
    if (!all || busy) return
    setBusy(true)
    try {
      await onSubmit(
        questions.map((qq, i) => answerText(qq, answers[i])),
        answers.map((x) => x.picked),
      )
    } finally {
      setBusy(false)
    }
  }
  const next = () => {
    if (!done(a)) return
    if (last) void submit()
    else setAt(at + 1)
  }
  const pick = (i: number) => {
    if (q.multiSelect) {
      set({ ...a, picked: a.picked.includes(i) ? a.picked.filter((x) => x !== i) : [...a.picked, i] })
      return
    }
    set({ picked: [i], text: a.text, own: false })
    // 单选：选了就到下一题（最后一题等你点提交，可以再看一眼）
    if (!last) setTimeout(() => setAt((x) => Math.min(x + 1, n - 1)), 160)
  }
  const pickOwn = () => {
    set(q.multiSelect ? { ...a, own: !a.own || !a.text } : { picked: [], text: a.text, own: true })
    requestAnimationFrame(() => own.current?.focus())
  }

  return (
    <div
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-label={t('AI 的问题')}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return
        const d = Number(e.key)
        if (d >= 1 && d <= q.options.length) pick(d - 1)
        else if (d === q.options.length + 1) pickOwn()
        else if (e.key === 'Enter') next()
        else return
        e.preventDefault()
      }}
      className={cn(
        'relative mx-auto flex max-w-(--content-w) flex-col rounded-[20px] border border-accent/45 bg-card shadow-pop outline-none animate-[pop-in_160ms_ease-out]',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-4 pt-3 text-xs">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="shrink-0 font-medium text-accent">{t('需要你回答')}</span>
        {who && <span className="flex min-w-0 items-center gap-1.5 text-muted">{who}</span>}
        {n > 1 && (
          <div role="tablist" className="ml-auto flex min-w-0 gap-1 overflow-x-auto">
            {questions.map((x, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === at}
                onClick={() => setAt(i)}
                className={cn(
                  'flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[11.5px] transition-colors',
                  i === at ? 'bg-sel text-fg' : 'text-subtle hover:bg-sel/60 hover:text-fg',
                )}
              >
                {done(answers[i]) ? (
                  <Check className="h-3 w-3 text-success" />
                ) : (
                  <span className="font-mono tabular-nums">{i + 1}</span>
                )}
                <span className="max-w-[120px] truncate">{x.header || t('问题 {n}', { n: i + 1 })}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="px-4 pt-2 pb-2.5 text-[14px] leading-relaxed font-medium [overflow-wrap:anywhere]">
        {q.question}
        {q.multiSelect && <span className="ml-2 text-xs font-normal text-subtle">{t('可以选多个')}</span>}
      </p>
      <div className="flex max-h-[min(46vh,420px)] flex-col gap-1 overflow-y-auto px-2.5">
        {q.options.map((o, i) => {
          const on = a.picked.includes(i)
          return (
            <button
              key={i}
              type="button"
              onClick={() => pick(i)}
              aria-pressed={on}
              className={cn(
                'flex w-full cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                on ? 'border-accent/60 bg-accent-soft/50' : 'border-transparent hover:bg-sel/70',
              )}
            >
              <Mark n={i + 1} on={on} multi={q.multiSelect} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">{o.label}</span>
                {o.description && <span className="block text-[12.5px] leading-snug text-muted">{o.description}</span>}
              </span>
            </button>
          )
        })}
        {/* 最后一项：自己输入 */}
        <label
          className={cn(
            'flex w-full cursor-text items-center gap-3 rounded-xl border px-3 py-2 transition-colors',
            a.own ? 'border-accent/60 bg-accent-soft/50' : 'border-transparent hover:bg-sel/70',
          )}
        >
          <Mark n={q.options.length + 1} on={a.own && !!a.text.trim()} multi={q.multiSelect} icon />
          <input
            ref={own}
            value={a.text}
            onFocus={() => !a.own && set(q.multiSelect ? { ...a, own: true } : { picked: [], text: a.text, own: true })}
            onChange={(e) =>
              set(
                q.multiSelect
                  ? { ...a, own: true, text: e.target.value }
                  : { picked: [], own: true, text: e.target.value },
              )
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                next()
              }
            }}
            placeholder={q.options.length ? t('都不合适？自己输入…') : t('输入你的回答…')}
            aria-label={t('自己输入回答')}
            className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-subtle"
          />
        </label>
      </div>
      <div className="flex items-center gap-2 px-3 pt-2 pb-3">
        {onSkip && (
          <button
            type="button"
            onClick={() => void onSkip()}
            disabled={busy}
            className="cursor-pointer rounded-md px-2 py-1 text-[12.5px] text-subtle hover:bg-sel hover:text-fg"
          >
            {skipLabel ?? t('不回答')}
          </button>
        )}
        <span className="flex-1" />
        {at > 0 && (
          <button
            type="button"
            onClick={() => setAt(at - 1)}
            className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-[12.5px] text-muted hover:bg-sel hover:text-fg"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('上一题')}
          </button>
        )}
        <button
          type="button"
          onClick={next}
          disabled={!done(a) || (last && !all) || busy}
          title={last && !all ? t('还有问题没回答') : undefined}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {last ? (n > 1 ? t('提交 {n} 个回答', { n }) : t('提交回答')) : t('下一题')}
        </button>
      </div>
    </div>
  )
}

/** 选项前面的编号；选中时变成勾（多选是方框） */
function Mark({ n, on, multi, icon }: { n: number; on: boolean; multi?: boolean; icon?: boolean }) {
  return (
    <span
      className={cn(
        'mt-px grid h-5 w-5 shrink-0 place-items-center border font-mono text-[11px] tabular-nums transition-colors',
        multi ? 'rounded-[5px]' : 'rounded-full',
        on ? 'border-accent bg-accent text-white' : 'border-line-strong text-subtle',
      )}
    >
      {on ? <Check className="h-3 w-3" strokeWidth={3} /> : icon ? <PencilLine className="h-3 w-3" /> : n}
    </span>
  )
}
