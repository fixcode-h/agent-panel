/**
 * 工作流节点在「提问」关着时提的问题：不再一律「按你的判断选、直接继续」。
 * 2026-11-26 复盘 P1-9：收尾节点问「要不要改 SubModuleList_BigWorld.lua」被自动回答，Agent 于是签出这个共享注册文件、
 * 删掉别人的几行——收不回的事没人拍板就做了。用户定（同日）：转成不阻塞的「待你决定」，流程照常往下走。
 * 所以这里：问题原样记进对话给用户看（不停下等），交回给 Agent 的话写清能收回的按判断继续、收不回的先不做、写进报告交回。
 * 交给 Agent 的话是提示词，不翻译；对话里那一行是界面文案。
 */
import { t } from '../../shared/i18n.ts'
import { makeAlert } from '../../shared/alerts.ts'
import type { Task } from '../../shared/schema.ts'
import type { AskBrief } from './invoke.ts'
import { systemNote } from './recovery.ts'

export const FLOW_AUTO_ANSWER =
  '「提问」开关关着，这个问题没有交给用户（面板把它记在对话里，标成「待用户决定」，流程不停下等）。' +
  '能收回的事按你的判断选最合适的做法继续，并写清是你自己定的；' +
  '收不回或会影响别人的事（改共享的注册表、配置和别人也在用的文件，删别人的内容，提交、推送、发消息到外部）先不做：' +
  '写进这一步要交的东西里交回给用户——有阶段报告的写成决策（推荐项 + 理由），评审写进 blockers，子任务写进 left。不要再提问。'

/** 问题写成一行：多个问题时逐个列出 */
export function askBriefText(q: AskBrief) {
  const qs = (q.questions ?? []).map((x) => x.question.trim()).filter(Boolean)
  return (qs.length ? qs.join('；') : [q.title, q.detail].filter((s) => s.trim()).join('：')).slice(0, 400)
}

/** 给 invokeCli 的 autoAnswer：工作流节点里的调用才换成上面的回答，并在对话里记一行「待你决定」 */
export function flowAutoAnswer(ctx: {
  task: Task
  agentId: string
  step: string
  newId: () => string
  changed: (save?: boolean) => void
}) {
  if (!ctx.step) return undefined
  return (q: AskBrief) => {
    ctx.task.messages.push({
      ...systemNote(
        ctx.newId(),
        ctx.agentId,
        ctx.step,
        t('待你决定：Agent 想问「{q}」。提问关着没有弹给你，流程照常往下走；收不回的事它先不做，会写进报告交给你定。', {
          q: askBriefText(q),
        }),
      ),
      alert: makeAlert('warn', askBriefText(q), 'panel'),
    })
    ctx.changed(true)
    return FLOW_AUTO_ANSWER
  }
}
