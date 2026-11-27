import { useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { stageConfirm, type ChildSummary } from './child-line'
import { GrantActions, type GrantChoice } from './GrantActions'

/** 一次最多列几行：再多就在最后一行写「还有 N 个」，点开子对话列表看全部 */
const MAX_ROWS = 3

/**
 * 在等你确认的子对话：自己有待确认的请求，或者它下面的子对话在等你（childNeeds）。
 * 只等你回答提问（asking）的不在这里：子对话栏已经有一枚「请你选择」，父对话里也有提问卡片。
 * 工作流节点做完等你确认结果的也不在这里：它留在子对话那一行上，行尾「查看结果」（见 child-line.ts 的 stageConfirm）
 */
export function childrenConfirming(kids: ChildSummary[]) {
  return kids.filter((c) => (c.requests || c.childNeeds) && !c.resolved && !c.gone && !stageConfirm(c))
}

/** 一行写什么：「子对话「X」等你确认：运行命令：npm test」 */
function rowText(c: ChildSummary) {
  const req = c.request
  if (!req) return t('子对话「{title}」下面的子对话等你处理', { title: c.title })
  return req.kind === 'question'
    ? t('子对话「{title}」等你回答：{what}', { title: c.title, what: req.title })
    : t('子对话「{title}」等你确认：{what}', { title: c.title, what: req.title })
}

/**
 * 子对话在等你确认：和自己的授权卡一样浮在输入框上方（FloatAbove，用户 2026-11-27），一个子对话一行（实测报告问题 1）。
 * 以前夹在计划行和子对话栏之间，离输入框远、不像要你处理的东西。
 * 卡在权限确认上的子对话不转圈，运行区和子对话小块都不列它，以前只有点进子对话才看得到「需要你确认」。
 * 只是允许 / 拒绝一个操作（命令、改文件、工具）的，行上直接给两个按钮，不用点进子对话；
 * 提问、孙对话在等的要看完整内容，点「去处理」在右栏打开它
 */
export function ChildRequestBar({
  kids,
  onOpen,
  onAnswer,
  className,
}: {
  kids: ChildSummary[]
  className?: string
  onOpen: (id: string) => void
  /** 允许 / 拒绝子对话的请求：出错由调用方提示（错误要显示给用户），这里只管按钮的转圈 */
  onAnswer?: (childId: string, requestId: string, allow: boolean, always?: boolean) => Promise<void>
}) {
  // 正在提交的是哪一个按钮（请求 id + 选的哪个）：提交期间几个按钮都不能再点，免得重复回答
  const [busy, setBusy] = useState('')
  const list = childrenConfirming(kids)
  if (!list.length) return null
  const shown = list.slice(0, MAX_ROWS)
  const rest = list.length - shown.length
  const send = async (c: ChildSummary, pick: GrantChoice) => {
    if (!c.request || !onAnswer || busy) return
    setBusy(`${c.request.id}:${pick}`)
    try {
      await onAnswer(c.id, c.request.id, pick !== 'deny', pick === 'always')
    } finally {
      setBusy('')
    }
  }
  return (
    <div
      data-child-requests=""
      aria-label={t('子对话等你确认')}
      // 浮在消息上面：底色不透明，边框和投影跟自己的授权卡（RequestCard）一致
      className={cn(
        'mx-auto mb-2 flex w-full max-w-(--content-w) flex-col gap-1 rounded-xl border border-warning/50 bg-card p-1 shadow-pop animate-[pop-in_160ms_ease-out]',
        className,
      )}
    >
      {shown.map((c, i) => {
        const req = c.request
        const more = (c.requests ?? 0) - 1
        const mine = req && busy.startsWith(`${req.id}:`) ? (busy.slice(req.id.length + 1) as GrantChoice) : ''
        return (
          <div
            key={c.id}
            data-child-request={c.id}
            className="flex h-8 min-w-0 items-center gap-2 rounded-lg bg-warning/10 pr-1 pl-2.5 text-xs"
          >
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={2.4} />
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              // 命令可能很长：行上截断，悬停看完整的标题和说明
              title={[req?.title, req?.detail].filter(Boolean).join('\n') || c.title}
              className={cn(
                'min-w-0 flex-1 cursor-pointer truncate text-left font-medium text-warning hover:underline',
                req?.kind === 'command' && 'font-mono',
              )}
            >
              {rowText(c)}
            </button>
            {more > 0 && <span className="shrink-0 text-subtle">{t('还有 {n} 个', { n: more })}</span>}
            {i === shown.length - 1 && rest > 0 && (
              <span className="shrink-0 text-subtle">{t('另有 {n} 个子对话在等', { n: rest })}</span>
            )}
            {req?.quick && onAnswer ? (
              <GrantActions
                compact
                req={req}
                busy={mine}
                // 别的行在提交时这一行也不能点
                disabled={!!busy}
                onPick={(p) => void send(c, p)}
                className="shrink-0 flex-nowrap"
              />
            ) : (
              <Button size="sm" variant="secondary" onClick={() => onOpen(c.id)} className="h-6 px-2 text-xs">
                {t('去处理')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
