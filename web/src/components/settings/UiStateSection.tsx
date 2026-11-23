import { RotateCcw } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { local, prefFamilies, prefLabel, resetPrefs, storedKeys, usePrefsVersion, type PrefGroup } from '@/lib/prefs'
import { toast } from '@/lib/toast'
import { Group, Row } from './parts'

/**
 * 设置 →「外观」→「界面状态」：本机记住的界面状态（拖过的尺寸、折叠、页签、筛选……），按登记的族（lib/prefs）列出，
 * 能一项一项重置，也能把「布局」「看什么」两类一起重置（主题、语言这类真正的设置不在「全部重置」里）。
 * 只列现在存着东西的；重置后已经打开的页面下次挂载时回到默认
 */
const GROUPS: { id: PrefGroup; title: () => string }[] = [
  { id: 'layout', title: () => t('尺寸和折叠') },
  { id: 'view', title: () => t('页签、筛选和打开的内容') },
  { id: 'settings', title: () => t('本机设置') },
  { id: 'other', title: () => t('其他') },
]

export function UiStateSection() {
  usePrefsVersion()
  const keys = local.keys()
  const rows = prefFamilies()
    .map((f) => ({ f, n: storedKeys(f, keys).length }))
    .filter((x) => x.n > 0)
  const resettable = rows.filter((x) => x.f.group === 'layout' || x.f.group === 'view')
  const resetAll = () => {
    for (const x of resettable) resetPrefs(x.f)
    toast(t('已重置 {n} 项，刷新页面后生效', { n: resettable.length }))
  }
  return (
    <>
      <Group plain>
        <Row
          title={t('全部重置')}
          desc={t('把拖过的尺寸、折叠、页签和筛选都恢复成默认；主题、语言这些设置不动')}
          hint={t('只影响这个浏览器。插件记住的（例如 UE 页的分栏）也在下面列出，一起重置。')}
        >
          <Button size="sm" variant="secondary" disabled={!resettable.length} onClick={resetAll}>
            <RotateCcw className="size-3.5" />
            {t('全部重置')}
          </Button>
        </Row>
      </Group>
      {GROUPS.map((g) => {
        const list = rows.filter((x) => x.f.group === g.id)
        if (!list.length) return null
        return (
          <Group key={g.id} title={g.title()}>
            {list.map(({ f, n }) => (
              <Row
                key={f.id}
                title={prefLabel(f)}
                desc={[f.owner ? t('插件 {id}', { id: f.owner }) : '', n > 1 ? t('记了 {n} 处', { n }) : '']
                  .filter(Boolean)
                  .join(' · ')}
              >
                <Button variant="link" tone="muted" onClick={() => resetPrefs(f)}>
                  {t('重置')}
                </Button>
              </Row>
            ))}
          </Group>
        )
      })}
      {!rows.length && (
        <Group>
          <Row title={t('还没有记住的界面状态')} desc={t('拖过分栏、折叠过分组之后会出现在这里')}>
            {null}
          </Row>
        </Group>
      )}
    </>
  )
}
