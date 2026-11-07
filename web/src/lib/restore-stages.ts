import { t } from '@shared/i18n'
import { RESTORE_STEPS, stepOf, type RestoreState, type RestoreStep } from '@shared/restore/schema'
import { stepName } from '@shared/restore/steps'
import type { StageState } from './design-stages'

const HINT: Record<RestoreStep, () => string> = {
  source: () => t('确认要还原的原画'),
  elements: () => t('核对拆出来的元素：位置、类型、名字、文字'),
  assets: () => t('看切图和干净背景像不像原画'),
  build: () => t('看搭出来的控件树'),
  verify: () => t('逐个核对和原画差多少'),
  deliver: () => t('确认交付，进入画布继续改或导出'),
}

/** 现在该处理哪一步：第一个还没确认的（全做完了停在最后一步） */
export function activeStep(r: RestoreState | undefined): RestoreStep {
  return RESTORE_STEPS.find((s) => stepOf(r, s).status !== 'done') ?? 'deliver'
}

/** 六步的状态，给标题行的步骤条 */
export function restoreStages(r: RestoreState | undefined) {
  const cur = activeStep(r)
  return RESTORE_STEPS.map((s) => {
    const st = stepOf(r, s)
    const state: StageState =
      st.status === 'running' ? 'busy' : st.status === 'done' ? 'done' : s === cur ? 'current' : 'todo'
    return { id: s, label: stepName(s), state, hint: HINT[s]() }
  })
}
