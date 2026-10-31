import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert, GitFork, Loader2, MessageCircleQuestion, RotateCw, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { childCounts, sortChildren, visibleChildren } from '@shared/task'
import { cn } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { useUserName } from '@/lib/user-name'
import { UnreadDot } from '@/components/ui/badge'
import { IconButton } from '@/components/ui/icon-button'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { AnalysisMark } from './AnalysisMark'
import { ChildRowContent, childGroups } from './ChildSwitcher'
import { ChildLetters } from './ChildMail'
import { HelperBar } from './HelperCards'
import { usePeerMail } from './child-open'
import { childClosedHint, childDirty, childNote, staleLine, type ChildSummary } from './child-line'

/**
 * 输入框上方的状态栏（计划、子任务、子对话各一行）：不套框，当作轻量信息。
 * 每行各自 flex-nowrap、只占一行；左内边距 2.5 加上行内按钮自己的 px-1.5，
 * 正好和输入框文字（外层 px-3/md:px-6 + 文字 px-4）左对齐
 */
export const plainRow = 'flex min-w-0 items-center gap-2 px-2.5 text-body'

/**
 * 子对话入口：贴在输入框上方的一条状态栏，点开是悬浮窗列表。
 * 默认只列进程还活着的子对话（预热、等下一句、正在执行），切到「全部」能看到已关闭的。
 * 排序：正在执行的在上，其余按最近一条消息的时间倒序。
 */
export function ChildrenBar({
  children,
  helpers,
  openChild,
  onOpen,
  onClose,
  onResume,
}: {
  children: ChildSummary[]
  /** 派出的子任务：单独占子任务那一行，点开看它的实时对话流 */
  helpers?: { task: Task; ids: string[]; teamNames: Set<string> }
  openChild: string
  onOpen: (id: string) => void
  onClose: () => void
  /** 停下的子对话一键继续：重新占执行位，从停下的地方接着做 */
  onResume: (id: string) => void
}) {
  const user = useUserName()
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 每个子对话和父对话之间的信、还没被父对话读到的汇报（ADR 0034）：面板按子对话分组，展开才列往来
  const mail = usePeerMail()
  const unreadOf = (id: string) => mail?.unread.get(id) ?? 0
  const unread = children.reduce((n, c) => n + unreadOf(c.id), 0)
  // 展开了哪几个子对话的往来：没手动点过的，有未读汇报的默认展开
  const [fold, setFold] = useState<Record<string, boolean>>({})
  const expanded = (id: string) => fold[id] ?? unreadOf(id) > 0
  useEscape(open, () => setOpen(false))
  // 点外面关：和项目里其他浮层一样
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  // 在等你选择的子对话：最醒目，排在状态栏最前面；已经解决、已经收起（归档 / 独立分支被删掉）的
  // 不再算你要处理的事——用户已经把它删了，不能还在状态栏上催他回答
  const asking = children.filter((c) => c.asking && !c.resolved && !c.gone)
  // 转圈的那一批：和行首图标、行内徽标、悬浮层默认列表、运行区的子对话是同一套判定（见 visibleChildren）
  const busy = visibleChildren(children)
  // 分子（还在进行）和分母（进程还活着的）同一份数据算出来，不再各处各算一遍
  const { running: working, total } = childCounts(children)
  // 「运行中」列转圈的那些：计划没做完、后台命令还没回、已解决但还在跑的子对话也算（见 visibleChildren）
  const shown = all ? sortChildren(children) : visibleChildren(children)
  const current = children.find((c) => c.id === openChild)

  // 小块的个数按这一行实际能用的宽度算：放不下的收成「+N」，不折到下一行去挤子任务，
  // 窗口拉宽 / 缩窄时跟着变（不再是写死的 slice(0, 3)）。
  // 用回调 ref + ResizeObserver，节点挂上再量；卡片大小跟着根字号（设置里能改字号）走，不写死像素
  const [cardsEl, setCardsEl] = useState<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ room: 0, card: 224, gap: 6, more: 40 })
  useLayoutEffect(() => {
    if (!cardsEl) return
    const read = () => {
      // w-56 = 14rem、gap-1.5 = 0.375rem；「+N」按钮连同间距按 2.5rem 预留
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setBox({ room: cardsEl.clientWidth, card: rem * 14, gap: rem * 0.375, more: rem * 2.5 })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(cardsEl)
    return () => ro.disconnect()
  }, [cardsEl])
  const cardSlot = box.card + box.gap
  const fitAll = Math.floor((box.room + box.gap) / cardSlot)
  const shownCards =
    fitAll >= busy.length ? busy.length : Math.max(0, Math.floor(Math.max(0, box.room - box.more) / cardSlot))
  const hiddenCards = busy.length - shownCards
  // CLI 还活着的子对话数：「子对话」入口流光、悬浮说明用
  const cliKids = children.filter((c) => c.cliAlive).length

  return (
    <div ref={ref} className="shrink-0 px-3 md:px-6">
      {/* 弹窗以这两行为基准：左边和输入框左对齐，不跟着外层的内边距和居中偏移走 */}
      <div className="relative mx-auto max-w-(--content-w)">
        {/* 状态栏的后两行（计划在调用处单独一行）：子任务在上、子对话在下，各自只占一行、不换行。
            子对话行左边是计数入口、右边是关闭按钮，中间的小块放不下就收成「+N」 */}
        {helpers && (
          <div data-status-row="helpers" className={cn(plainRow, 'mb-1 flex-nowrap')}>
            <HelperBar task={helpers.task} ids={helpers.ids} teamNames={helpers.teamNames} />
          </div>
        )}
        {children.length > 0 && (
          <div data-status-row="children" className={cn(plainRow, 'mb-1 flex-nowrap')}>
            <button
              type="button"
              aria-expanded={open}
              aria-label={
                working > 0
                  ? t('子对话，{n} 个进行中，共 {total} 个', { n: working, total })
                  : t('子对话 {n}', { n: total })
              }
              onClick={() => setOpen((v) => !v)}
              title={cliKids ? t('Agent 存活：{n} 个子对话', { n: cliKids }) : undefined}
              className="flex min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-body text-muted transition-colors hover:bg-sel hover:text-fg"
            >
              <GitFork className="h-3.5 w-3.5 shrink-0 text-subtle" />
              {/* 有子对话的 CLI 还活着：「子对话」三个字流光，和标题、侧栏一致 */}
              <span
                className={cn('shrink-0 font-medium', cliKids > 0 && 'cli-alive-title')}
                style={cliKids > 0 ? ({ '--cli-base': 'var(--muted)' } as React.CSSProperties) : undefined}
              >
                {t('子对话')}
              </span>
              {/* 进行中的在前、总数在后：转圈 3/5 读作「3 个还在进行，一共 5 个」，总数不重复说两遍 */}
              {working > 0 ? (
                <span className="flex shrink-0 items-center gap-1 pr-1 text-xs text-accent-text tabular-nums">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {working}/{total}
                </span>
              ) : (
                // 没在跑时只写总数，不出现 0/2
                <span className="shrink-0 text-xs text-subtle tabular-nums">{total}</span>
              )}
              {/* 子对话交回、父对话还没读到的汇报：面板里展开那个子对话就能看到是哪一封 */}
              {unread > 0 && (
                <span data-child-unread className="flex shrink-0 items-center gap-1 pr-1 text-xs text-accent-text">
                  <UnreadDot />
                  {t('{n} 封未读', { n: unread })}
                </span>
              )}
            </button>
            {asking.length > 0 && (
              <button
                type="button"
                onClick={() => onOpen(asking[0].id)}
                title={asking.map((c) => c.title).join('\n')}
                className="flex h-7 max-w-64 min-w-0 shrink cursor-pointer items-center gap-2 rounded-lg bg-warning/12 px-2.5 text-xs font-medium text-warning transition-colors hover:bg-warning/18"
              >
                <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                  {asking.length > 1
                    ? t('{n} 个子对话请{who}选择', { n: asking.length, who: user })
                    : t('「{title}」请{who}选择', { title: asking[0].title, who: user })}
                </span>
              </button>
            )}
            {/* 正在执行的子对话一个一块，宽度固定不随内容和个数伸缩：名字后面接着它这会儿在做什么，点一下在右栏打开。
                这一层量到的宽度就是能放小块的宽度，超出被裁掉之前已经按个数收成「+N」 */}
            {busy.length > 0 && (
              // 至少给「+N」留出 2.5rem：窄屏下「请你选择」占满行时，这个容器会被挤成 0 宽，
              // 里面的数字被 overflow-hidden 整个裁掉，看着像没显示
              <div
                ref={setCardsEl}
                data-child-cards
                className="flex min-w-10 flex-1 items-center gap-1.5 overflow-hidden"
              >
                {busy.slice(0, shownCards).map((c) => {
                  // 执行中很久没新输出：文字变黄 / 红，一眼看出可能是它卡住了（等待原因不在这里标）
                  const stale = staleLine(c)
                  const line = childNote(c, true)
                  // 进程回收了但还在跑：卡片上不写「已关闭」，悬停补一句（和悬浮层列表同一个提示）
                  const gone = childClosedHint(c)
                  return (
                    <button
                      key={c.id}
                      data-child-card
                      type="button"
                      onClick={() => onOpen(c.id)}
                      title={`${c.title}${line ? ` · ${line}` : ''}${stale ? ` · ${stale.text}` : ''}${gone ? ` · ${gone}` : ''}`}
                      className={cn(
                        // 不描边、不加阴影：和计划条同一层浅底，正在看的那个深一档
                        'flex h-7 w-56 max-w-full min-w-0 shrink cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs transition-colors hover:bg-sel',
                        c.id === openChild ? 'bg-sel' : 'bg-sel/45',
                      )}
                    >
                      {/* 执行中的子对话用和列表、行首同一套转圈，不再另画一个跳动的小点 */}
                      <Loader2 className={cn('h-3 w-3 shrink-0 animate-spin', stale?.cls ?? 'text-accent-text')} />
                      {c.analysis && <AnalysisMark kind={c.analysis} />}
                      <span
                        className={cn(
                          'max-w-[60%] min-w-0 shrink-0 truncate font-medium text-fg',
                          c.cliAlive && 'cli-alive-title',
                        )}
                      >
                        {c.title}
                      </span>
                      <span className={cn('min-w-0 flex-1 truncate', stale?.cls ?? 'text-subtle')}>
                        {stale ? stale.text : line}
                      </span>
                    </button>
                  )
                })}
                {hiddenCards > 0 && (
                  // 放不下的真实个数：紧跟最后一块，点开还是那个能看全部的浮层
                  <button
                    type="button"
                    data-child-more
                    aria-label={t('还有 {n} 个子对话', { n: hiddenCards })}
                    title={busy
                      .slice(shownCards)
                      .map((c) => c.title)
                      .join('\n')}
                    onClick={() => setOpen((v) => !v)}
                    className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 text-xs text-subtle tabular-nums transition-colors hover:bg-sel hover:text-fg"
                  >
                    +{hiddenCards}
                  </button>
                )}
              </div>
            )}
            {current && <IconButton icon={X} label={t('关闭子对话')} onClick={onClose} className="ml-auto" />}
          </div>
        )}
        {open && (
          <ComposerPopover width="min(480px, calc(100% - 1.5rem))">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="text-body font-medium">{t('子对话')}</span>
              <span data-child-summary className="min-w-0 truncate text-xs text-subtle">
                {unread > 0
                  ? t('{n} 个 · {m} 封未读', { n: children.length, m: unread })
                  : t('{n} 个', { n: children.length })}
              </span>
              {/* 样子和 Segmented 一样，但界面检查按「按钮 + aria-pressed」找「全部」，这里不换成单选组 */}
              <div className="seg-track ml-auto flex shrink-0 rounded-md p-0.5">
                {(
                  [
                    [false, t('运行中')],
                    [true, t('全部')],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={String(v)}
                    type="button"
                    aria-pressed={all === v}
                    onClick={() => setAll(v)}
                    className={cn(
                      'cursor-pointer rounded-sm px-2 py-0.5 text-xs',
                      all === v ? 'seg-thumb font-medium' : 'text-muted hover:text-fg',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[min(46vh,320px)] overflow-y-auto p-1">
              {childGroups(shown, all).map((g) => (
                <Fragment key={g.key}>
                  {g.label && (
                    <p className="px-2.5 pt-2 pb-1 text-caption font-medium text-subtle">
                      {g.label} · {g.items.length}
                    </p>
                  )}
                  {g.items.map((c) => {
                    // 停下时独立分支里还有没提交的改动：在卡片上直接说出来，并给「继续」
                    const dirty = childDirty(c)
                    const letters = mail?.letters.get(c.id) ?? []
                    const n = unreadOf(c.id)
                    const exp = expanded(c.id)
                    return (
                      <Fragment key={c.id}>
                        <div className="group/kid relative flex min-w-0 items-start">
                          <button
                            type="button"
                            data-child-item
                            onClick={() => {
                              // 点条目只切换右边要看的子对话，浮层不关；点浮层外面或按 Escape 才关
                              onOpen(c.id)
                            }}
                            className={cn(
                              'flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-lg py-2 pr-9 pl-2.5 text-left transition-colors hover:bg-sel',
                              c.id === openChild && 'bg-sel',
                            )}
                          >
                            {/* 图标、状态标签、说明、分支和标题旁的下拉读同一份，两处不再各画一套 */}
                            <ChildRowContent c={c} viewing={c.id === openChild} pending={n} />
                          </button>
                          {/* 展开看它和父对话之间的信：只有信（交代、汇报、提问……），状态已经在上面这一行 */}
                          <button
                            type="button"
                            data-child-expand
                            aria-expanded={exp}
                            aria-label={t('「{title}」的往来', { title: c.title })}
                            title={t('看它和父对话之间的信')}
                            onClick={() => setFold((f) => ({ ...f, [c.id]: !exp }))}
                            className="absolute top-1.5 right-1.5 flex h-6 cursor-pointer items-center gap-0.5 rounded-md px-1 text-caption text-subtle tabular-nums hover:bg-sel hover:text-fg"
                          >
                            {letters.length > 0 && letters.length}
                            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', exp && 'rotate-90')} />
                          </button>
                        </div>
                        {exp && <ChildLetters letters={letters} />}
                        {dirty && (
                          // 没提交的改动还在分支目录里：写清几个文件、哪个目录，并给一键继续
                          <div className="flex min-w-0 items-center gap-1.5 pr-1 pb-1 pl-9">
                            <CircleAlert className="h-3 w-3 shrink-0 text-warning" />
                            <span className="shrink-0 text-caption text-warning" title={dirty.dir || undefined}>
                              {dirty.text}
                            </span>
                            {dirty.dir && (
                              <span className="min-w-0 truncate font-mono text-caption text-subtle">{dirty.dir}</span>
                            )}
                            <button
                              type="button"
                              onClick={() => onResume(c.id)}
                              title={t('让它接着做：重新占执行位，从停下的地方继续')}
                              className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-caption text-accent-text hover:bg-sel"
                            >
                              <RotateCw className="h-3 w-3" />
                              {t('继续')}
                            </button>
                          </div>
                        )}
                      </Fragment>
                    )
                  })}
                </Fragment>
              ))}
              {!shown.length && (
                <p className="px-2.5 py-3 text-xs text-subtle">{all ? t('还没有子对话') : t('没有正在运行的子对话')}</p>
              )}
            </div>
          </ComposerPopover>
        )}
      </div>
    </div>
  )
}
