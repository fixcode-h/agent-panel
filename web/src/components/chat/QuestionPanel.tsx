// AI 问你的问题：显示在输入框的位置（换掉输入框），一次可以问好几个，全部回答完再一起交回去。
// 每个问题的选项最后一项都是「自己输入」。任务对话（CLI 的提问）和 UI 设计（AI 问风格等）共用
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, Loader2, PencilLine, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/tasks/Markdown'

/** 问题里的 @名字 只是普通文字时不当成提及高亮 */
const NO_NAMES = new Set<string>()

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
  onClose,
  closeLabel,
  label,
  who,
  teamNames,
  className,
}: {
  questions: PanelQuestion[]
  /** 每个问题一个回答（按顺序）；返回 Promise 时提交中显示转圈 */
  onSubmit: (answers: string[], picked: number[][]) => unknown
  /** 不回答（让 AI 自己选）或改用输入框；不给就没有这个按钮 */
  onSkip?: () => unknown
  skipLabel?: string
  /** 右上角的关闭：这个问题不回答，终止当前对话；不给就没有这个按钮 */
  onClose?: () => unknown
  /** 关闭按钮的提示，默认「不回答，终止对话」 */
  closeLabel?: string
  /** 左上角的标题，默认「需要你回答」 */
  label?: string
  /** 谁在问：Agent 的名字 */
  who?: React.ReactNode
  /** 问题正文里的 @名字 高亮：有名册时穿进来 */
  teamNames?: Set<string>
  className?: string
}) {
  const n = questions.length
  const [at, setAt] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(empty))
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
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
      // 组件库「提问 · AskCard」：停靠在输入框上方，琥珀色浅底（等你回复的状态色）、不描边；
      // 选项是一行行白底，选中的描一圈前景色
      className={cn(
        'relative mx-auto flex max-w-(--content-w) flex-col gap-2 rounded-xl bg-warning/8 p-3 outline-none animate-[pop-in_160ms_ease-out]',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
        <span
          aria-hidden
          className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-warning text-[0.625rem] font-bold text-card"
        >
          ?
        </span>
        <span className="shrink-0 font-semibold text-warning">{label ?? t('需要你回答')}</span>
        {who && <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">{who}</span>}
        <span className="flex-1" />
        {/* 多选跟着标题行，不跟着正文滚走 */}
        {q.multiSelect && (
          <span className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[0.6875rem] text-subtle">{t('多选')}</span>
        )}
        {n > 1 && (
          <div role="tablist" className="flex min-w-0 gap-1 overflow-x-auto">
            {questions.map((x, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === at}
                onClick={() => setAt(i)}
                className={cn(
                  'flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[0.71875rem] font-medium transition-colors',
                  i === at ? 'bg-fg text-bg' : 'bg-card text-muted hover:text-fg',
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
        {onClose && (
          <button
            type="button"
            aria-label={closeLabel ?? t('不回答，终止对话')}
            title={closeLabel ?? t('不回答，终止对话')}
            disabled={closing || busy}
            onClick={async () => {
              setClosing(true)
              try {
                await onClose()
              } finally {
                setClosing(false)
              }
            }}
            className="-mr-1 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-card hover:text-fg disabled:cursor-default disabled:opacity-50"
          >
            {closing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      {/* 问题正文可能是 AI 写的 Markdown：渲染出来，长了在框里滚，选项和底部按钮始终留着 */}
      <div className="text-[0.8125rem]">
        <Markdown
          text={q.question}
          teamNames={teamNames ?? NO_NAMES}
          compact
          className="max-h-[min(50vh,460px)] overflow-y-auto"
        />
      </div>
      <div className="flex max-h-[min(46vh,420px)] flex-col gap-1.5 overflow-y-auto p-px">
        {q.options.map((o, i) => {
          const on = a.picked.includes(i)
          return (
            <button
              key={i}
              type="button"
              onClick={() => pick(i)}
              aria-pressed={on}
              className={cn(
                'flex min-h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-card px-2.5 py-1.5 text-left transition-shadow',
                on ? 'ring-[1.5px] ring-fg ring-inset' : 'hover:ring-1 hover:ring-line-strong hover:ring-inset',
              )}
            >
              <Mark on={on} multi={q.multiSelect} />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.8125rem] font-medium">{o.label}</span>
                {o.description && (
                  <span className="block text-[0.75rem] leading-snug text-subtle">{o.description}</span>
                )}
              </span>
              <Num n={i + 1} />
            </button>
          )
        })}
        {/* 最后一项：自己输入 */}
        <label
          className={cn(
            'flex min-h-8 w-full cursor-text items-center gap-2.5 rounded-lg px-2.5 py-0.5 transition-shadow',
            a.own ? 'bg-card ring-[1.5px] ring-fg ring-inset' : 'bg-card/60 hover:bg-card',
          )}
        >
          <PencilLine className="h-3 w-3 shrink-0 text-subtle" />
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
            className="h-7 min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none placeholder:text-subtle"
          />
          <Num n={q.options.length + 1} />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        {/* 多选：已经选了几个，提示可以接着选 */}
        {q.multiSelect && a.picked.length > 0 && (
          <span className="text-[0.71875rem] text-subtle">{t('已选 {n} 个', { n: a.picked.length })}</span>
        )}
        {at > 0 && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setAt(at - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('上一题')}
          </Button>
        )}
        {/* 跳过和回答都在右下角：次要按钮浅底，只有回答是实心主按钮 */}
        {onSkip && (
          <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={() => void onSkip()} disabled={busy}>
            {skipLabel ?? t('不回答')}
          </Button>
        )}
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={next}
          disabled={!done(a) || (last && !all) || busy}
          title={last && !all ? t('还有问题没回答') : undefined}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {last ? (n > 1 ? t('提交 {n} 个回答', { n }) : t('提交回答')) : t('下一题')}
        </Button>
      </div>
    </div>
  )
}

/** 选项前面的单选圆点（多选是方框）：选中时实心描边，和组件库「提问」一致 */
function Mark({ on, multi }: { on: boolean; multi?: boolean }) {
  if (multi)
    return (
      <span
        className={cn(
          'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] transition-colors',
          on ? 'bg-fg text-bg' : 'shadow-[inset_0_0_0_1px_var(--line-strong)]',
        )}
      >
        {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
    )
  return (
    <span
      className={cn(
        'h-3 w-3 shrink-0 rounded-full transition-shadow',
        on ? 'shadow-[inset_0_0_0_4px_var(--fg)]' : 'shadow-[inset_0_0_0_1px_var(--line-strong)]',
      )}
    />
  )
}

/** 选项行尾的数字键：按这个数字直接选它 */
function Num({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="grid h-4 min-w-4 shrink-0 place-items-center rounded-[4px] bg-sel/70 px-1 font-mono text-[0.625rem] text-subtle tabular-nums"
    >
      {n}
    </span>
  )
}
