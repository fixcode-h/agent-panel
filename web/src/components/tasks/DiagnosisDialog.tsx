import { FileSearch } from 'lucide-react'
import type { Attachment, Task, TaskRequest } from '@shared/schema'
import { attachChip } from '@shared/composer'
import type { Diagnosis } from '@shared/bug-diagnosis-schema'
import { diagnosisMarkdown } from '@shared/bug-diagnosis'
import { causeInPlan, phaseOf } from '@shared/bug-phase'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { readBase64 } from '@/components/chat/Attachments'
import { ReviewDialog, type NoteKind, type ReviewRaw } from './ReviewDialog'
import { DiagnosisStages } from './DiagnosisStages'

/**
 * Bug 的诊断报告（ADR 0045）：父对话派来的 Bug，子对话每到一个关口交一版（论证、根因、修复方案、验证），
 * 用户在这里同意、标出疑问、贴日志或取消。
 * 审阅弹窗和工作流节点的确认是同一个（ReviewDialog），多了标注种类、多版切换；
 * 决定交给服务端记下，再把返回的话作为一条消息发给子对话（发消息那条路负责叫醒它）
 */

const KINDS: () => NoteKind[] = () => [
  { id: 'question', label: t('疑问'), placeholder: t('哪里看不明白、觉得不对，要它查清楚') },
  { id: 'change', label: t('改方案'), placeholder: t('方案要怎么改：换修法、缩小或扩大范围') },
  { id: 'info', label: t('补充信息'), placeholder: t('你知道的事实，例如什么时候开始坏的') },
]

/** 贴在框里的日志超过这么多字就存成附件（服务端交给 AI 的文字也按这个上限） */
const MAX_PASTE = 20000

const STATUS: Record<Diagnosis['status'], () => string> = {
  pending: () => t('等你确认'),
  questioned: () => t('你提了意见，它在接着分析'),
  approved: () => t('你已同意'),
  answered: () => t('你给了日志，它在分析'),
  superseded: () => t('已作废，有更新的一版'),
  cancelled: () => t('你取消了，这次不修'),
}

/** 一版的状态：验证阶段的「给了结果」「点了结束」和别的阶段说法不同 */
const statusOf = (d: Diagnosis) => {
  if (d.status === 'pending' && d.awaiting) return t('日志已加好，等你复现')
  if (phaseOf(d) === 'verify' && d.status === 'answered') return t('你给了验证结果，它在分析')
  if (phaseOf(d) === 'verify' && d.status === 'approved') return t('你结束了验证')
  return STATUS[d.status]()
}

/** 每一版的标题、正文和状态：正文按上一版补出「回答上一版的意见」；author：引入点写不写作者（设置里的开关） */
function versionsOf(list: Diagnosis[], author: boolean) {
  return list.map((d, i) => ({
    key: String(d.version),
    label: t('第 {n} 版 · {phase}', { n: d.version, phase: phaseLabel(d) }),
    detail: diagnosisMarkdown(d, list[i - 1], { author, list }),
    status: statusOf(d),
  }))
}

const phaseLabel = (d: Diagnosis) =>
  ({ evidence: t('论证'), cause: t('根因'), plan: t('修复方案'), verify: t('验证') })[phaseOf(d)]

/**
 * 每个阶段的按钮和提示（用户 2026-11-05 定的流程）：
 * 论证同意加日志（手上有日志可以直接交），等你复现时交日志；根因同意或否决；方案确认开始修；验证交日志或直接结束
 */
function phaseTexts(d: Diagnosis, list: Diagnosis[]) {
  const phase = phaseOf(d)
  // 快速级别根因和方案合成一版：点一次就同意根因并开始修
  if (causeInPlan(d, list))
    return {
      texts: {
        approve: t('同意根因并按这个修'),
        revise: t('有疑问，出下一版'),
        hintApprove: t('根因和修复方案一起确认，确认了它才开始改代码；根因或方案有疑问先选中文字标注'),
        hintRevise: t('「有疑问」把标注按编号交回，它逐条回答后交下一版'),
      },
    }
  if (phase === 'evidence' && d.awaiting)
    return {
      texts: {
        approve: '',
        revise: t('有疑问'),
        hintApprove: '',
        hintRevise: t('「有疑问」把标注交回，它先回答再接着论证'),
      },
      supply: {
        label: t('交日志，继续分析'),
        primary: true,
        hint: t('按报告里的步骤复现，把日志贴在右下角或引入日志文件、截图，它接着分析'),
      },
      noApprove: true,
      placeholder: t('把复现得到的日志贴在这里，也可以粘贴或拖进日志文件'),
    }
  if (phase === 'evidence')
    return {
      texts: {
        approve: t('同意加日志'),
        revise: t('继续分析，出下一版'),
        hintApprove: t('同意后它只在日志计划里的文件加临时日志，不改逻辑；手上已有日志可以贴在右下角直接交'),
        hintRevise: t('「继续分析」把标注按编号交回，它逐条回答后交下一版'),
      },
      supply: { label: t('我有日志，直接分析'), hint: t('不用它加日志：直接分析你贴的日志') },
      placeholder: t('整体意见（可选）；手上已有日志可以贴在这里，或粘贴、拖进日志文件'),
    }
  if (phase === 'cause')
    return {
      texts: {
        approve: t('同意根因'),
        revise: t('否决，再分析'),
        hintApprove: t('同意根因它就开始设计修复方案；觉得不对就选中文字标出疑问或补充，再点「否决」'),
        hintRevise: t('「否决」把疑问和补充交回：它认为证据不够会回到论证加日志，否则逐条回答交新一版'),
      },
    }
  if (phase === 'plan')
    return {
      texts: {
        approve: t('确认方案，开始修'),
        revise: t('有疑问，出下一版'),
        hintApprove: t('方案没问题就确认，它才会开始改代码；有疑问先选中文字标注'),
        hintRevise: t('「有疑问」把标注按编号交回，它逐条回答后交下一版'),
      },
    }
  return {
    texts: {
      approve: t('结束，跳过验证'),
      revise: t('还有问题'),
      hintApprove: '',
      hintRevise: t('「还有问题」把标注交回：它会回到论证或重新出方案'),
    },
    supply: {
      label: t('交日志，确认修好'),
      primary: true,
      hint: t('按报告里的步骤复现，把日志贴在右下角或引入文件、截图；不想验证就点「结束」，它删掉临时日志后收尾'),
    },
    placeholder: t('把验证时的日志贴在这里，也可以粘贴或拖进日志文件'),
  }
}

/** 审阅弹窗：最新一版在等你时能处理，否则只读（随时回看） */
export function DiagnosisDialog({
  task,
  open,
  onOpenChange,
  onDone,
}: {
  task: Pick<Task, 'id' | 'title' | 'diagnoses'>
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: (task: Task) => void
}) {
  const { settings } = useData()
  const author = settings?.bugAuthor !== false
  const list = task.diagnoses ?? []
  const last = list.at(-1)
  if (!last) return null
  const req: Pick<TaskRequest, 'id' | 'title' | 'detail'> = {
    // 等你复现是同一版回到等你：换一个 id，标注和输入从头开始
    id: `${task.id}:${last.version}${last.awaiting ? ':logs' : ''}`,
    title: t('诊断报告 · {title}', { title: task.title }),
    detail: diagnosisMarkdown(last, list.at(-2), { author, list }),
  }
  // 候选方案里没选的那几个：点一下加一条「改方案」意见，退回让它按这个方案交新一版（ADR 0046，档案不由界面直接改）
  const presets =
    phaseOf(last) === 'plan'
      ? last.options
          .filter((o) => o.id && o.id !== last.chosen?.id)
          .map((o) => ({
            label: t('改用方案 {id}', { id: o.id }),
            quote: t('方案 {id}：{title}', { id: o.id, title: o.title }),
            comment: t('改用这个方案'),
            kind: 'change',
          }))
      : []
  const cfg = phaseTexts(last, list)
  // 决定已经记下：把话（和附上的日志文件）交给子对话，叫醒它接着做（在跑、在等下一句、停着都由发消息那条路处理）
  const hand = async (message: string, files: Attachment[], fallback: Task) => {
    const next = await api.sendMessage(task.id, message, files).catch((e: Error) => {
      toast.error(t('你的决定已经记下，但没能交给子对话：{error}', { error: e.message }))
      return fallback
    })
    onDone?.(next)
  }
  const notesOf = (raw?: ReviewRaw) =>
    (raw?.notes ?? []).map((n) => ({
      quote: n.quote,
      comment: n.comment,
      kind: (n.kind || 'question') as 'question' | 'change' | 'info',
    }))
  return (
    <ReviewDialog
      req={req}
      open={open}
      onOpenChange={onOpenChange}
      kinds={KINDS()}
      versions={versionsOf(list, author)}
      presets={presets}
      readOnly={last.status !== 'pending'}
      // 阶段条按正在看的那一版画：切到旧版看的是那时候走到哪一步
      top={(key) => (
        <DiagnosisStages list={list.slice(0, list.findIndex((d) => String(d.version) === key) + 1 || list.length)} />
      )}
      texts={cfg.texts}
      noApprove={cfg.noApprove}
      feedbackFirst
      attach
      overallPlaceholder={cfg.placeholder}
      supply={
        cfg.supply && {
          ...cfg.supply,
          onSupply: async (raw) => {
            // 贴的日志太长：存成一个文件交路径过去，提示词里只放短的，不截断用户给的内容
            const long = raw.overall.length > MAX_PASTE
            const files = long
              ? [
                  ...raw.files,
                  await api.upload({
                    name: 'pasted-log.txt',
                    mime: 'text/plain',
                    data: await readBase64(new Blob([raw.overall], { type: 'text/plain' })),
                  }),
                ]
              : raw.files
            const r = await api.decideDiagnosis(task.id, last.version, {
              approve: false,
              supply: true,
              logs: long ? '' : raw.overall,
              // 图片不算日志文件：它的路径已经在整体意见的文字里
              logFiles: files.filter((f) => attachChip(f) !== 'image').map((f) => f.path),
              notes: notesOf(raw),
              overall: '',
            })
            await hand(r.message, files, r.task)
          },
        }
      }
      cancel={{
        label: t('取消修复'),
        title: t('取消这次修复？'),
        description: t(
          '不再等你确认，这一轮就此结束，计划标记为完成，之后不会再改文件。已经加进代码的 [排查-…] 临时日志不会自动删，要删就在这个对话里跟它说。',
        ),
        confirm: t('不修了'),
        // 不发话给子对话：交报告那一轮已经结束了，计划由服务端收口，它停着等你的下一句
        onCancel: async (overall) => {
          const r = await api.decideDiagnosis(task.id, last.version, {
            approve: false,
            cancel: true,
            notes: [],
            overall,
          })
          onDone?.(r.task)
        },
      }}
      onAnswer={async (allow, _text, raw) => {
        const r = await api.decideDiagnosis(task.id, last.version, {
          approve: allow,
          notes: notesOf(raw),
          overall: raw?.overall ?? '',
        })
        await hand(r.message, raw?.files ?? [], r.task)
      }}
    />
  )
}

/**
 * 对话里的一行记录：你确认了第几版、对第几版提了意见。「查看报告」只放在交报告的那一行工具调用上（用户 2026-11-03 定的），
 * 这里不再放入口，免得同一份报告到处都是按钮
 */
export function BugReportLine({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 text-footnote text-subtle">
      <FileSearch className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  )
}
