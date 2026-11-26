import { t } from '../i18n.ts'
import type { GrantVia } from '../schema.ts'

/**
 * 放行来源注册表：对话里工具卡片上的放行小标、合并行、「放行规则」浮层都按这一份显示（用户 2026-11-26 选的方案 A）。
 * 新加一种放行来源：在 GrantVia 里加一个值，这里加一条
 */
export interface GrantSource {
  /** 卡片小标上的短说法 */
  badge: () => string
  /** 点开卡片、合并行里的完整说法；label 是规则的说法 / 工作流名 / 权限名 */
  long: (label: string) => string
  /** 有规则键可以撤销（这个对话里记下的放行规则） */
  revocable: boolean
}

export const GRANT_SOURCES: Record<GrantVia, GrantSource> = {
  rule: {
    badge: () => t('规则放行'),
    long: () => t('按这个对话的放行规则自动允许'),
    revocable: true,
  },
  preset: {
    badge: () => t('工作流自带授权'),
    long: (label) => t('工作流「{name}」自带授权，自动允许', { name: label }),
    revocable: false,
  },
  readonly: {
    badge: () => t('只读，自动允许'),
    long: () => t('整条都是只读命令，自动允许'),
    revocable: false,
  },
  test: {
    badge: () => t('测试步骤，自动允许'),
    long: () => t('是这个项目的测试步骤命令，自动允许'),
    revocable: false,
  },
  mode: {
    badge: () => t('权限设为不确认'),
    long: (label) => t('权限是「{mode}」，自动允许', { mode: label }),
    revocable: false,
  },
  user: {
    badge: () => t('你允许的'),
    long: () => t('你在授权卡上允许了'),
    revocable: true,
  },
}
