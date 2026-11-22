import { Suspense, useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { ListEmpty, ListItem, ListPane } from '@/components/layout/ListPane'
import { Detail, DetailHeader } from '@/components/layout/Detail'
import { TOOLS } from '@/components/tools/registry'

/**
 * 「小工具」页：左边是工具列表（可拖边调宽，记在本机），右边是选中工具自己的界面。
 * 工具从注册表（web/src/components/tools/registry.tsx）来，加工具不用改这一页。
 */
export function ToolsPage() {
  const { route, go } = useNav()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const list = TOOLS.filter((x) => !q || `${x.label()}${x.desc()}`.toLowerCase().includes(q))
  const tool = TOOLS.find((x) => x.id === route.id) ?? TOOLS[0]

  useEffect(() => {
    if (tool && route.id !== tool.id) go({ page: 'tools', id: tool.id })
    // 地址里没写或写的工具不在了：换成第一个；go 每次渲染都是新的，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tool?.id, route.id])

  return (
    <>
      <ListPane
        title={t('小工具')}
        count={TOOLS.length}
        onNew={() => {}}
        hideNew
        compact
        resizeKey="tools"
        query={query}
        onQuery={setQuery}
        placeholder={t('搜索工具')}
      >
        {!list.length ? (
          <ListEmpty>{t('没有符合的工具。')}</ListEmpty>
        ) : (
          list.map((x) => (
            <ListItem
              key={x.id}
              compact
              selected={tool?.id === x.id}
              onClick={() => go({ page: 'tools', id: x.id })}
              leading={<x.icon className="h-4 w-4 shrink-0 text-accent-text" />}
              title={x.label()}
              subtitle={x.desc()}
              monoSubtitle={false}
            />
          ))
        )}
      </ListPane>
      {tool && (
        <Detail
          header={
            <DetailHeader
              compact
              quietSave
              leading={
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
                  <tool.icon className="h-5 w-5" />
                </span>
              }
              title={tool.label()}
              subtitle={tool.desc()}
              save={{ status: 'idle', error: '' }}
              actions={null}
            />
          }
          body={
            <Suspense fallback={<p className="px-4 py-6 text-body text-subtle md:px-8">{t('读取中…')}</p>}>
              <tool.Component key={tool.id} />
            </Suspense>
          }
        />
      )}
    </>
  )
}
