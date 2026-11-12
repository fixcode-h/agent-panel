/**
 * 对话状态对外的说法：标题栏胶囊、侧栏行尾、运行区子对话行、输入框占位、会话栏「状态」、「状态」窗口
 * 都从这里取同一个短词（分析稿 A8 + U2）。
 *
 * 以前每处各拼一句：标题栏「子对话等你处理」、侧栏「等你回复」、运行区「等用户选择」、
 * 会话栏「这一轮说完了，在等结果推回来」——同一件事五种说法，「这里写执行中、那里写等你」的 Bug 反复出。
 * 现在规矩是：判定只在 convState（shared/task.ts），说法只在 stateWord；要讲清是什么事、要你做什么的
 * 长句子交给输入框上方的悬浮卡（确认卡、等你操作、提问弹窗），别的地方只放这个短词。
 * 单独成文件：shared/task.ts 有行数上限。
 */
import { t } from '../i18n.ts'
import type { Task } from '../schema.ts'
import {
  convState,
  convStateText,
  taskFacts,
  type ChildEntry,
  type ConvFacts,
  type ConvState,
  type TaskFactsInput,
} from '../task.ts'

/** 等你处理的是哪一类：提问、权限确认、工作流阶段确认、等你去做的事、名下子对话在等 */
export type NeedKind = 'answer' | 'confirm' | 'stage' | 'action' | 'children'
/** 等结果时在等什么：名下子对话、派出的子任务、后台命令、工作流运行 */
export type WaitKind = 'children' | 'helpers' | 'background' | 'workflow'

export interface StateWord {
  state: ConvState
  /** 短词：各处只显示它 */
  word: string
  need?: NeedKind
  wait?: WaitKind
  /** 交了 Bug 诊断报告等你确认（ADR 0045）：状态仍是执行中，短词写「报告待确认」 */
  report?: boolean
}

/** 判定说法要看的事实：convState 的那一份，加上第一条待确认请求是哪种（提问、节点确认还是权限） */
export type WordFacts = ConvFacts & { request?: Task['requests'][number]['kind'] }

/** 状态和「等什么」的分类，不带文字：服务端算好放进 TaskLive（shared/live/task-live.ts），页面按 kindWord 换成短词 */
export type StateKind = Omit<StateWord, 'word'>

/**
 * 一组事实对应的状态和分类。等你处理按「自己的事在前、子对话的在后」取第一件：
 * 自己的提问 → 自己的请求 → 等你操作 → 名下子对话在等
 */
export function stateKind(f: WordFacts): StateKind {
  const state = convState(f)
  if (state === 'needs') {
    if (f.asking) return { state, need: 'answer' }
    if (f.requests) {
      // 工作流节点做完等你确认结果：和诊断报告的「报告待确认」一个说法；提问类请求是要你回答
      if (f.request === 'confirm') return { state, need: 'stage' }
      if (f.request === 'question') return { state, need: 'answer' }
      return { state, need: 'confirm' }
    }
    if (f.action) return { state, need: 'action' }
    return { state, need: 'children' }
  }
  if (state === 'running' && f.diagnosis && !f.working) return { state, report: true }
  if (state === 'waiting') {
    // 顺序和 childWait 一致：先说子对话，再说子任务、后台命令、工作流
    if (f.children) return { state, wait: 'children' }
    if (f.helpers) return { state, wait: 'helpers' }
    if (f.background) return { state, wait: 'background' }
    if (f.workflow) return { state, wait: 'workflow' }
  }
  return { state }
}

/** 分类对应的短词：各处只显示它 */
export function kindWord(k: StateKind): string {
  switch (k.need) {
    case 'answer':
      return t('等你回答')
    case 'stage':
      return t('阶段待确认')
    case 'confirm':
      return t('等你确认')
    case 'action':
      return t('等你操作')
    case 'children':
      return t('子对话等你处理')
  }
  if (k.report) return t('报告待确认')
  switch (k.wait) {
    case 'children':
      return t('子对话执行中')
    case 'helpers':
      return t('子任务执行中')
    case 'background':
      return t('后台命令执行中')
    case 'workflow':
      return t('工作流执行中')
  }
  return convStateText(k.state)
}

/** 一组事实对应的状态和短词（stateKind + kindWord） */
export function stateWord(f: WordFacts): StateWord {
  const k = stateKind(f)
  return { ...k, word: kindWord(k) }
}

/** 顶层对话（也适用于子对话自己的页面）的短词：事实取 taskFacts，和 taskState 同一份 */
export function taskWord(x: TaskFactsInput): StateWord {
  return stateWord({ ...taskFacts(x), request: x.requests?.[0]?.kind })
}

/**
 * 父对话页上子对话那一行的短词：事实和 childState 同一份（计划没做完算未完成）。
 * 已解决、已收起的不再算「阶段待确认」：没人会再处理它的请求（见 child-line.ts 的 stageConfirm）
 */
export function childWord(x: ChildEntry & { request?: { kind: Task['requests'][number]['kind'] } }): StateWord {
  const request = x.resolved || x.gone ? undefined : x.request?.kind
  return stateWord({ ...x, unfinished: !!x.plan && x.plan.done < x.plan.total, request })
}

/**
 * 「等结果」时在等什么，名下子对话在等你时也写出来（标题栏悬停、项目首页、会话栏用它）；
 * 别的状态是空串。就是 taskWord 在这两种情况下的短词
 */
export function taskWaitText(x: TaskFactsInput): string {
  const w = taskWord(x)
  return w.wait || w.need === 'children' ? w.word : ''
}
