import { t } from '@shared/i18n'
import { useData } from '@/lib/data'

/**
 * 界面上对用户的称呼（提问卡片「需要用户回答」、子对话「等用户选择」这类）：设置里「称呼」填了就用它，
 * 没填写「用户」。不写「你」：面板是给人看 Agent 在问谁，第二人称读起来像 Agent 在跟界面说话（用户要求）
 */
export function useUserName() {
  const { settings } = useData()
  return settings?.userName?.trim() || t('用户')
}
