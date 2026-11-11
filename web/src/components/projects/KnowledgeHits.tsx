import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { hitLabel, type KnowledgeHit, type KnowledgeHitsView } from '@shared/knowledge-hits'
import { experienceApi } from '@/lib/api-experience'
import { Badge } from '@/components/ui/badge'
import { ChipGroup } from '@/components/ui/chip-group'

/**
 * 经验、教训列表共用的「用没用上」：命中记录（shared/knowledge-hits.ts）、排序切换、每行的小字和过期标记。
 * 两个列表长得一样，放一处免得一边改了另一边忘了
 */

/** 拉一次命中记录；没保存过的项目（没有 id）、请求失败都当成没有记录，列表照常显示 */
export function useKnowledgeHits(projectId?: string) {
  const [hits, setHits] = useState<KnowledgeHitsView>()
  useEffect(() => {
    if (!projectId) return
    let live = true
    experienceApi
      .hits(projectId)
      .then((v) => live && setHits(v))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [projectId])
  return hits
}

export type KnowledgeSort = 'default' | 'idle'

/** 「默认 / 很久没用上」：清理时切到后者，最久没用上的、从没用上的排在前面 */
export function KnowledgeSortChips({
  value,
  onChange,
}: {
  value: KnowledgeSort
  onChange: (v: KnowledgeSort) => void
}) {
  return (
    <ChipGroup
      label={t('排序')}
      size="sm"
      value={value}
      onChange={onChange}
      options={[
        { id: 'default' as KnowledgeSort, label: t('原顺序') },
        { id: 'idle' as KnowledgeSort, label: t('很久没用上的在前') },
      ]}
    />
  )
}

/** 行里副标题后面的小字：用上几次、最近一次；路径已经不在时加一个「可能过期」 */
export function HitMeta({ hit, stale }: { hit?: KnowledgeHit; stale?: string[] }) {
  return (
    <>
      <span className="shrink-0" title={t('Agent 查到并拿到全文、或改文件时推给它的次数；只列出标题的不算')}>
        {hitLabel(hit)}
      </span>
      {stale && stale.length > 0 && (
        <Badge
          tone="warning"
          className="shrink-0 text-caption"
          title={t('这些路径在项目里已经找不到了：{paths}', { paths: stale.join('、') })}
        >
          {t('可能过期')}
        </Badge>
      )}
    </>
  )
}
