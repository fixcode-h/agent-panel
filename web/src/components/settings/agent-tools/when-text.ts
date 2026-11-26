import { t } from '@shared/i18n'
import { SKILL_PHASES, SKILL_WHEN_KINDS, type SkillWhen, type SkillWhenKind } from '@shared/skills/schema'

/**
 * 技能条件（shared/skills/when.ts）在界面上的说法：设置「Agent 工具 → 技能」的条件下拉、列表行的摘要都按这里写。
 * 条件的含义只在 shared 里定义一次，这里只管翻成给人看的话
 */
export const whenKindLabel = (k: SkillWhenKind): string =>
  ({
    edit: t('改文件'),
    read: t('读文件'),
    command: t('跑命令'),
    tool: t('调工具'),
    failed: t('命令失败后'),
    phase: t('阶段'),
    project: t('项目里有'),
    message: t('消息里写到'),
    params: t('节点参数'),
  })[k]

export const phaseLabel = (v: string) =>
  ({ finishing: t('开始收尾时'), 'finishing-edited': t('收尾且改过文件'), bug: t('Bug 模式开跑') })[v] ?? v

/** 输入框的占位：写什么 */
export const whenPlaceholder = (k: SkillWhenKind): string =>
  ({
    edit: '**/*.lua',
    read: '**/*.md',
    command: t('vcs、vcs-write、test、build、search 或程序名'),
    tool: 'blender_*',
    failed: 'test',
    phase: '',
    project: '*.uproject',
    message: '**/*.lua',
    params: 'lang=lua',
  })[k]

export const WHEN_KIND_OPTIONS = () => SKILL_WHEN_KINDS.map((k) => ({ value: k, label: whenKindLabel(k) }))
export const PHASE_OPTIONS = () => SKILL_PHASES.map((v) => ({ value: v, label: phaseLabel(v) }))

/** 一条条件的一句话 */
export function whenText(w: SkillWhen): string {
  switch (w.kind) {
    case 'edit':
      return t('改 {v} 前', { v: w.value })
    case 'read':
      return t('读 {v} 前', { v: w.value })
    case 'command':
      return t('跑 {v} 命令', { v: w.value })
    case 'tool':
      return t('调 {v} 工具前', { v: w.value })
    case 'failed':
      return t('{v} 命令失败后', { v: w.value })
    case 'phase':
      return phaseLabel(w.value)
    case 'project':
      return t('开跑时：项目里有 {v}', { v: w.value })
    case 'message':
      return t('消息里写到 {v}', { v: w.value })
    case 'params':
      return t('参数 {v}', { v: w.value })
  }
}

/** 列表行下面那一行摘要 */
export const whenSummary = (when: SkillWhen[]) => when.map(whenText).join(' · ')
