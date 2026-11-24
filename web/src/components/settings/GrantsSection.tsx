import type { Settings } from '@shared/schema'
import { grantKinds, type GrantKind } from '@shared/grants/kinds'
import { t } from '@shared/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from './parts'

type Prefs = Settings['grantRemember']

const GROUPS: { id: GrantKind['group']; title: () => string }[] = [
  { id: 'cli', title: () => t('CLI 的权限请求') },
  { id: 'plugin', title: () => t('插件') },
  { id: 'gate', title: () => t('门禁放行') },
  { id: 'other', title: () => t('其他') },
]

/**
 * 设置 →「授权卡」：所有「要不要允许」的卡片按授权类型列出来，逐类决定卡上给不给「本对话不再询问」。
 * 注册表在 shared/grants/kinds.ts，这里只记和默认不一样的（settings.grantRemember）。
 * 关掉只影响之后弹出的卡，已经放行过的对话照旧；新对话总是重新问
 */
export function GrantsSection({ value, onChange }: { value: Prefs; onChange: (v: Prefs) => void }) {
  const kinds = grantKinds()
  const on = (k: GrantKind) => value[k.id] ?? k.remember
  const set = (k: GrantKind, v: boolean) => {
    const next = { ...value }
    // 和默认一样就不记：以后默认改了跟着走
    if (v === k.remember) delete next[k.id]
    else next[k.id] = v
    onChange(next)
  }
  const changed = Object.keys(value).length
  return (
    <>
      <Group title={t('授权卡')}>
        <Row
          title={t('本对话不再询问')}
          desc={t(
            '授权卡上的三个按钮：拒绝、允许一次、本对话不再询问（默认）。选了「本对话不再询问」，这个对话里同一类授权之后自动允许、不再弹卡，对话里会留一行记录；不同类的照常问，新对话重新问。',
          )}
          hint={t('同一类按授权类型算：命令按程序名、改文件按目录、门禁按是哪一个门禁、插件按插件自己定的类别。')}
        >
          <Button size="sm" variant="secondary" disabled={!changed} onClick={() => onChange({})}>
            {t('恢复默认')}
          </Button>
        </Row>
      </Group>
      {GROUPS.map((g) => {
        const list = kinds.filter((k) => k.group === g.id)
        if (!list.length) return null
        return (
          <Group key={g.id} title={g.title()}>
            {list.map((k) => (
              <Row
                key={k.id}
                title={k.name()}
                desc={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span>{t('同一类：{scope}', { scope: k.scope() })}</span>
                    {k.fixed && <span className="text-subtle">{k.fixed()}</span>}
                    {!k.fixed && !k.remember && <Badge tone="warning">{t('默认每次都问')}</Badge>}
                  </span>
                }
              >
                <Switch
                  aria-label={t('{name}：给「本对话不再询问」', { name: k.name() })}
                  data-grant-kind={k.id}
                  checked={k.fixed ? true : on(k)}
                  disabled={!!k.fixed}
                  onCheckedChange={(v) => set(k, v)}
                />
              </Row>
            ))}
          </Group>
        )
      })}
    </>
  )
}
