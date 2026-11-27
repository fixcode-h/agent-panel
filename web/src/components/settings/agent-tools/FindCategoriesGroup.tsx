import { t } from '@shared/i18n'
import { FIND_CATEGORIES, type FindCategory, type FindOrder } from '@shared/capability-router/find/categories'
import { Badge } from '@/components/ui/badge'
import { Group, Row } from '../parts'

/** 每种走法写成一串路：设置页上一眼看出先问谁 */
const ORDER_STEPS: Record<FindOrder, (c: FindCategory) => string[]> = {
  specialist: (c) => [c.via?.() ?? t('外部服务（VS / IDEA）'), t('面板按文本补')],
  panel: () => [t('文件索引'), 'rg'],
  'panel-first': () => [t('文件索引 + rg'), t('没查到再问 VS / IDEA')],
}

/**
 * 「工具路由」页的「查找按类型分流」：照 shared/capability-router/find/categories.ts 的分类表只读显示，
 * 每类怎么认（扩展名、目录、名字写法）和先走哪条路。改分类只改那张表，这里跟着变
 */
export function FindCategoriesGroup() {
  return (
    <Group title={t('查找按类型分流')}>
      {FIND_CATEGORIES.map((c) => (
        <Row
          key={c.id}
          title={c.label()}
          desc={
            <span className="flex flex-col gap-1">
              <span>{c.why()}</span>
              {c.exts.length > 0 && (
                <span className="flex flex-wrap items-center gap-1">
                  {c.id === 'data' ? t('例如：') : t('扩展名：')}
                  {c.exts.map((e) => (
                    <Badge key={e} className="font-mono">
                      .{e}
                    </Badge>
                  ))}
                  {c.id === 'data' && <span>{t('等所有不是代码的扩展名')}</span>}
                </span>
              )}
            </span>
          }
        >
          <span className="flex flex-wrap justify-end gap-1 text-footnote text-subtle" data-find-category={c.id}>
            {ORDER_STEPS[c.order](c).map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden>→</span>}
                <Badge tone={i === 0 ? 'success' : 'neutral'}>{s}</Badge>
              </span>
            ))}
          </span>
        </Row>
      ))}
    </Group>
  )
}
