/**
 * 直接修的用户 Bug 的简版报告（分析稿 B2 第 ③ 条）：用户发 /fix、选了直接修，或「提问」关着默认直接修时，
 * 父对话派单写 kind: "fix"（task.bug.kind 为 fix）。子对话不交诊断报告、不用用户确认，但收尾（submit_merge）时要写清根因一句，
 * 面板把根因、改了什么、怎么验证的和实际改了的文件存成 task.bug.fixBrief，在子对话里记一行能展开的「修复简报」，
 * 也随收尾请求交给父对话。小 Bug 绕开完整流程，也留得下能回看的记录
 */
import type { FixBrief } from './diagnosis-schema.ts'
import type { HandoffInput } from '../handoff.ts'
import { t } from '../i18n.ts'
import type { Task } from '../schema.ts'

/** 收尾时缺根因就拒收：返回给 Agent 的话（提示词，不翻译）；不是直接修的 Bug 或写了的返回空串 */
export function fixBriefMissing(task: Pick<Task, 'bug'>, handoff: HandoffInput): string {
  if (!(task.bug?.kind === 'fix') || handoff.cause?.trim()) return ''
  return '没有请求收尾：这是用户报的 Bug（直接修），收尾要留一份简版报告：handoff.cause 写根因一句（在什么条件下、哪个文件哪段代码做错了什么，所以用户看到了什么），note 写改了什么，tests 写怎么验证的（复现用例改前失败、改后通过，跑了哪些测试和结果）。'
}

/** 存进任务的简版报告 */
export function fixBriefOf(handoff: HandoffInput, note: string, tests: string, files: string[], at: string): FixBrief {
  return {
    cause: (handoff.cause ?? '').trim().slice(0, 2000),
    change: note.trim().slice(0, 2000),
    verify: tests.trim().slice(0, 3000),
    files: files.slice(0, 50),
    at,
  }
}

/** 子对话里那一行（第一行是标题，展开看全文）：界面文案 */
export function fixBriefMd(b: FixBrief): string {
  const files = b.files.length ? b.files.map((f) => `- \`${f}\``).join('\n') : ''
  return [
    t('修复简报：{cause}', { cause: b.cause.split('\n')[0] }),
    `**${t('根因')}**\n\n${b.cause}`,
    b.change && `**${t('改了什么')}**\n\n${b.change}`,
    files && `**${t('改了的文件')}**\n\n${files}`,
    b.verify && `**${t('怎么验证的')}**\n\n${b.verify}`,
    t('直接修的 Bug 不用你确认，这份简报只留作回看。'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 交给父对话的那一段（提示词，不翻译） */
export const fixBriefPrompt = (b: FixBrief) =>
  `这是用户报的 Bug（直接修），它的简版报告：根因：${b.cause}${b.change ? `；改了什么：${b.change}` : ''}${b.files.length ? `；文件：${b.files.join('、')}` : ''}。验收时对照根因看改动是不是修在原因上；要写 Bug 记录时把这份简报交给「文档」。`
