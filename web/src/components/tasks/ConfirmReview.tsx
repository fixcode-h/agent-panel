import { useEffect, useMemo, useState } from 'react'
import type { TaskRequest } from '@shared/schema'
import { changesText, pendingReport, reportChanges, type Picks } from '@shared/flow/stage-report'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { ReviewDialog, type ReviewVersion } from './ReviewDialog'
import { redoLabel, StageCompare, StageLead, StageProcess } from './StageReport'

/** 每一版处理成了什么：看旧版时写在正文上面 */
const RESULT = () => ({
  confirmed: t('这一版你已确认'),
  changed: t('这一版你改了决策，已交给 Agent 重出'),
  revised: t('这一版你提了修改意见，已退回'),
  next: t('这一版你已确认，Agent 接着问下一轮'),
  auto: t('这一版没有新问题，已自动通过'),
})

/**
 * 工作流节点的确认（「X」完成了，看一下结果再继续）：交了阶段报告时按报告分区排版、决策可以改勾选、能切版本和对比上一版
 * （用户 2026-11-15 定，版本参照诊断报告）；没交报告的旧节点照旧整段渲染输出。
 * onAnswer 带上每个决策选了哪项：改了的由后端交回 Agent 重出一版（shared/flow/stage-report.ts）
 */
export function ConfirmReview({
  req,
  agent,
  open,
  onOpenChange,
  onAnswer,
  view,
}: {
  req: Pick<TaskRequest, 'id' | 'title' | 'detail' | 'reports'>
  agent?: { name: string; icon: string; cli: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 出错时抛出：弹窗留着并提示错误，标注和勾选不会白做 */
  onAnswer: (allow: boolean, answer?: string, picks?: Picks) => Promise<void>
  /**
   * 只看不答（流程图节点详情里常驻的报告入口，StageReportBar）：每一版都锁住、勾选按当时交的显示，
   * 打开时停在 version 那一版（从 1 数，不给是最新一版）；hint 是底栏那句说明
   */
  view?: { version?: number; hint: string }
}) {
  const { agents } = useData()
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const list = useMemo(() => req.reports ?? [], [req.reports])
  // 只看时没有「这一版正在等你」：每一版都按当时交的样子锁住
  const viewing = !!view
  const cur = viewing ? undefined : pendingReport(list)
  // 勾选从 Agent 推荐的开始；换了请求（重出了一版）从新一版的推荐重新开始
  const [picks, setPicks] = useState<Picks>({})
  useEffect(() => setPicks({}), [req.id])
  const changed = cur ? reportChanges(cur.report, picks) : []

  const versions = useMemo((): ReviewVersion[] | undefined => {
    if (!list.length) return undefined
    const out: ReviewVersion[] = list.map((v, i) => {
      const live = v === cur
      const prev = list[i - 1]
      return {
        key: String(i + 1),
        label: t('第 {n} 版', { n: i + 1 }),
        detail: v.report.details,
        status: v.result ? RESULT()[v.result] : undefined,
        lead: (
          <StageLead
            v={v}
            picks={live ? picks : (v.picks ?? {})}
            onPick={(id, o) => setPicks((p) => ({ ...p, [id]: o }))}
            locked={!live}
            teamNames={teamNames}
          />
        ),
        // 过程记录只有这一次运行的（req.detail 是这一轮 Agent 的全部文字）
        after: live && <StageProcess text={req.detail} teamNames={teamNames} />,
        compare: prev && <StageCompare base={prev} cur={v} baseNo={i} curNo={i + 1} />,
      }
    })
    // 退回后 Agent 没交新报告：这次要审的是它的文字输出，排在最后
    if (!cur && !viewing)
      out.push({ key: 'text', label: t('第 {n} 版 · 没交报告', { n: list.length + 1 }), detail: req.detail })
    return out
  }, [list, cur, viewing, picks, req.detail, teamNames])

  // 有好几版时正文上面吸顶一条：这是第几版、怎么来的；版本下拉和「对比上一份」放在这条右边（和诊断报告一样）
  const top =
    list.length > 1
      ? (key: string) => {
          const i = key === 'text' ? list.length : Number(key) - 1
          const how = redoLabel(list[i - 1])
          return (
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-body font-medium text-fg">{t('第 {n} 版', { n: i + 1 })}</span>
              {how && <span className="truncate text-footnote text-subtle">{how}</span>}
            </div>
          )
        }
      : undefined

  // 只有一个「确认」（用户 2026-11-27 定）：有标注或整体意见时它把标注、意见连同改了的决策交回 Agent 修改；
  // 全清空了才是确认，这时改了决策也会交回 Agent 按新选择重出一版（后端 shared/flow/stage-report.ts）
  const texts = cur && {
    approve: t('确认'),
    changed: changed.length > 0,
    hintApprove: changed.length
      ? t('改了 {n} 项决策：点「确认」交给 Agent 按你的选择重出一版', { n: changed.length })
      : cur.report.next.trim()
        ? t('确认后 Agent 按报告接着做下一轮')
        : t('都按推荐：没有要改的地方就点「确认」继续'),
    hintRevise: changed.length
      ? t('有标注时「确认」会把标注、意见和改了的决策一起交给 Agent 修改；标注全删掉再点才是确认通过')
      : t('有标注时「确认」会把标注和意见交给 Agent 修改；标注全删掉再点才是确认通过'),
  }

  return (
    <ReviewDialog
      req={req}
      agent={agent}
      open={open}
      onOpenChange={onOpenChange}
      versions={versions}
      top={top}
      readOnly={!!view}
      readOnlyHint={view?.hint}
      initialVersion={view?.version ? String(view.version) : undefined}
      texts={texts || undefined}
      onAnswer={async (allow, answer) => {
        // 退回修改时，改了的决策也写进意见里：Agent 看得到改了哪几项（这是发给 Agent 的提示词，不翻译）
        const diff = cur && !allow ? changesText(cur.report, picks) : ''
        const text = diff ? [answer, `决策改动（没列出的按你的推荐）：\n${diff}`].filter(Boolean).join('\n\n') : answer
        await onAnswer(allow, text, cur ? picks : undefined)
      }}
    />
  )
}
