/** 表头行角色的显示名：表头设置里的下拉、表格行号列上的小字、设置 → 组件里的颜色项都用这一份 */
import type { SheetRole } from '@shared/sheet-header'
import { t } from '@shared/i18n'

export const roleLabel = (r: SheetRole) =>
  ({
    modifier: t('修饰（optional / repeated）'),
    side: t('导出端（Client / Server / Editor）'),
    type: t('类型'),
    name: t('字段名（当列标题）'),
    comment: t('注释'),
    other: t('其他'),
  })[r]

/** 行号列里的两个字 */
export const roleShort = (r: SheetRole) =>
  ({
    modifier: t('修饰'),
    side: t('导出'),
    type: t('类型'),
    name: t('字段'),
    comment: t('注释'),
    other: t('表头'),
  })[r]
