/**
 * 事件触发的计划：计划除了「到点就跑」，还可以「条件成立才跑」——某个目录的文件变了、
 * git 远端分支有新提交、一条命令的退出码变了（CI 红了、导表失败）。
 *
 * - 面板按 everyMin 定期检查一次，第一次只记下现状（baseline），之后和上一次不一样才新建对话
 * - 新建对话走和定时计划同一条链路：执行上限、上游依赖、跑完的通知都复用（server/schedules.ts）
 * - 这里只放前后端共用的结构、判定和文案；真正去读目录、问远端、跑命令在 server/schedule-triggers.ts
 *
 * 不 import shared/schedule.ts：那边的 ScheduleInput 要引用这里的结构，反过来引用会成环
 */
import { z } from 'zod'
import { t } from '../i18n.ts'

/** 触发方式：按时间（原来的定时计划）/ 目录文件变了 / 远端分支有新提交 / 命令退出码变了 */
export const TriggerKind = z.enum(['time', 'files', 'git', 'command'])
export type TriggerKind = z.infer<typeof TriggerKind>

/** 检查间隔的上下限（分钟）：太密会一直跑命令、问远端，一天一次以上用定时计划就够了 */
export const TRIGGER_MIN_EVERY = 1
export const TRIGGER_MAX_EVERY = 24 * 60
/** 检查间隔的选项（分钟）：编辑界面的下拉框按它列 */
export const TRIGGER_EVERY_OPTIONS = [1, 5, 15, 30, 60, 180, 720, 1440] as const

export const ScheduleTrigger = z.object({
  kind: TriggerKind.catch('time').default('time'),
  /**
   * files：要看的目录；git / command：在哪个目录里跑。
   * 相对路径按项目目录算，空表示项目目录本身；不属于项目的计划必须填绝对路径（见 triggerConfigError）
   */
  path: z.string().trim().max(1000).default(''),
  /** git：远端名 */
  remote: z.string().trim().max(200).default('origin'),
  /** git：远端分支名（不带 refs/heads/） */
  branch: z.string().trim().max(200).default(''),
  /** command：要跑的命令，交给设置里选的命令行环境 */
  command: z.string().trim().max(2000).default(''),
  /** command：只在退出码变成非 0（由好变坏）时触发；关着时退出码一变就触发（修好了也算） */
  onlyFailure: z.boolean().default(false),
  /** 隔多少分钟检查一次 */
  everyMin: z.number().int().min(TRIGGER_MIN_EVERY).max(TRIGGER_MAX_EVERY).catch(5).default(5),
})
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>

/** 检查的现状：服务端写，界面读来显示「上次检查」「检查出错」 */
export const TriggerState = z.object({
  /** 上一次检查到的值：目录的指纹 / 远端分支的提交 / 命令的退出码。空表示还没检查过 */
  baseline: z.string().default(''),
  /** 上一次检查的时间 */
  checkedAt: z.string().default(''),
  /** 上一次检查出的错（目录不存在、远端连不上、命令没跑起来），原文显示给用户；成功时清空 */
  error: z.string().default(''),
  /** 最近一次条件成立的时间 */
  firedAt: z.string().default(''),
})
export type TriggerState = z.infer<typeof TriggerState>

export const EMPTY_TRIGGER_STATE: TriggerState = { baseline: '', checkedAt: '', error: '', firedAt: '' }

type WithTrigger = { trigger?: Pick<ScheduleTrigger, 'kind'> }

/** 是不是按事件触发的计划（不是按时间）。旧数据没有 trigger，算按时间 */
export const isEventSchedule = (s: WithTrigger) => !!s.trigger && s.trigger.kind !== 'time'

/** 这一刻该不该检查：开着的、按事件的，没检查过或离上次检查够 everyMin 分钟 */
export function triggerCheckDue(
  s: { enabled: boolean; trigger?: ScheduleTrigger; triggerState?: TriggerState },
  now: number,
): boolean {
  if (!s.enabled || !s.trigger || !isEventSchedule(s)) return false
  const last = Date.parse(s.triggerState?.checkedAt ?? '')
  return !Number.isFinite(last) || now - last >= s.trigger.everyMin * 60_000
}

/** 绝对路径（Windows 盘符、UNC、/ 开头）：前后端都要判，不用 node:path */
export const isAbsolutePath = (p: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(p)

/** 保存前的校验（界面和服务端同一份）：返回给用户看的原因，通过返回空字符串 */
export function triggerConfigError(s: { projectId: string; trigger?: ScheduleTrigger }): string {
  const tr = s.trigger
  if (!tr || tr.kind === 'time') return ''
  if (tr.kind === 'git' && !tr.branch) return t('请填写要关注的远端分支')
  if (tr.kind === 'command' && !tr.command) return t('请填写要检查的命令')
  if (!s.projectId && !isAbsolutePath(tr.path)) return t('不属于项目的计划，目录要填绝对路径')
  if (tr.path.split(/[\\/]/).includes('..')) return t('目录里不能有「..」')
  return ''
}

/** 触发条件本身有没有变：变了就从头记现状，旧的 baseline 不再拿来比 */
export function sameTriggerConfig(a?: ScheduleTrigger, b?: ScheduleTrigger): boolean {
  const pick = (x?: ScheduleTrigger) =>
    x && x.kind !== 'time'
      ? [x.kind, x.path, x.kind === 'git' ? `${x.remote}/${x.branch}` : '', x.kind === 'command' ? x.command : '']
      : ['time']
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b))
}

/**
 * 这次检查算不算条件成立：第一次检查（还没有 baseline）只记现状不触发，
 * 免得刚建好、刚改完条件就冒出一个对话；之后和上一次不一样才触发。
 * 命令勾了「只在失败时」：退出码变了、并且变成了非 0 才算
 */
export function triggerFires(trigger: Pick<ScheduleTrigger, 'kind' | 'onlyFailure'>, prev: string, next: string) {
  if (!prev || !next || prev === next) return false
  if (trigger.kind === 'command' && trigger.onlyFailure) return next !== '0'
  return true
}

/** 到点交给 Agent 的内容：计划的原话后面附上这次为什么触发（变了哪些文件、新提交、命令输出），Agent 不用自己再去查 */
export function triggerPrompt(prompt: string, detail: string): string {
  return detail ? `${prompt}\n\n---\n本次由触发条件启动：\n${detail}` : prompt
}

/** 触发方式的选项（编辑弹窗、详情面板共用） */
export function triggerKindOptions(): { id: TriggerKind; label: string }[] {
  return [
    { id: 'time', label: t('按时间') },
    { id: 'files', label: t('文件变了') },
    { id: 'git', label: t('远端新提交') },
    { id: 'command', label: t('命令结果变了') },
  ]
}

/** 卡片徽标：按事件的计划写触发方式，代替「每天」「每周」 */
export function triggerLabel(trigger: Pick<ScheduleTrigger, 'kind'>): string {
  return triggerKindOptions().find((x) => x.id === trigger.kind)?.label ?? ''
}

/** 检查间隔的写法：「每 5 分钟」「每 3 小时」「每天」 */
export function everyLabel(min: number): string {
  if (min >= 1440 && min % 1440 === 0) return min === 1440 ? t('每天') : t('每 {n} 天', { n: min / 1440 })
  if (min >= 60 && min % 60 === 0) return t('每 {n} 小时', { n: min / 60 })
  return t('每 {n} 分钟', { n: min })
}

/** 一句话说清楚在看什么：「每 5 分钟看一次 origin/main 有没有新提交」 */
export function triggerSummary(trigger: ScheduleTrigger): string {
  const every = everyLabel(trigger.everyMin)
  const where = trigger.path || t('项目目录')
  switch (trigger.kind) {
    case 'files':
      return t('{every}检查一次「{where}」里的文件有没有变化', { every, where })
    case 'git':
      return t('{every}检查一次 {remote}/{branch} 有没有新提交', {
        every,
        remote: trigger.remote || 'origin',
        branch: trigger.branch,
      })
    case 'command':
      return trigger.onlyFailure
        ? t('{every}跑一次命令，退出码变成失败时新建对话', { every })
        : t('{every}跑一次命令，退出码变了就新建对话', { every })
    default:
      return ''
  }
}

/** 上次检查的现状（卡片、详情面板）：出错写原因，还没检查写「还没检查」 */
export function triggerStateLabel(state: TriggerState | undefined, when: (iso: string) => string): string {
  if (!state?.checkedAt) return t('还没检查过：第一次检查只记下现状，之后有变化才新建对话')
  if (state.error) return t('{time} 检查出错：{error}', { time: when(state.checkedAt), error: state.error })
  if (state.firedAt && state.firedAt === state.checkedAt)
    return t('{time} 检查到变化，已按条件启动', { time: when(state.checkedAt) })
  return t('上次检查 {time}，没有新的变化', { time: when(state.checkedAt) })
}
