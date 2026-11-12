import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { DEFAULT_SEARCH_EXCLUDE, UE_SEARCH_EXCLUDE } from '@shared/search-exclude'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ParamRow } from '@/components/agents/ParamFields'

/**
 * 搜索排除目录：一项一个 chip，回车或点「添加」加一项，点 × 删一项。
 * 只存用户填的；内置默认清单（依赖、产物、缓存）始终生效，不占这里的输入。
 */
export function SearchExcludeField({
  value,
  onChange,
}: {
  value: string[] | undefined
  onChange: (v: string[]) => void
}) {
  const [text, setText] = useState('')
  const list = value ?? []
  // 输入时就把首尾空白和尾部斜杠去掉：`Saved/` 和 `Saved` 是同一个目录，存两种写法只会重复
  const clean = (s: string) => s.trim().replace(/[\\/]+$/, '')
  const add = () => {
    const item = clean(text)
    setText('')
    if (!item || list.includes(item)) return
    onChange([...list, item])
  }
  // UE 预设只补缺的：已经填过的项不重复加，用户自己加的也留着
  const preset = () => onChange([...list, ...UE_SEARCH_EXCLUDE.filter((d) => !list.includes(d))])
  return (
    <ParamRow
      label={
        <>
          <span className="truncate font-medium text-muted">{t('搜索时跳过的目录')}</span>
          <span className="shrink-0 text-caption text-subtle">{t('相对项目根')}</span>
        </>
      }
      hint={t(
        'Agent 找文件、搜代码时跳过这些目录。大项目里全仓搜索会跑几分钟、命中大量编译产物，所以先读项目文档定位到模块，再在最小目录里搜。Git 项目里 .gitignore 已经忽略的目录会自动跳过，这里只需填它没覆盖的。',
      )}
      stacked
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {list.map((d) => (
            <span
              key={d}
              className="flex h-7 items-center gap-1 rounded-md bg-sel/70 pr-1 pl-2 text-footnote text-muted"
            >
              <span className="font-mono">{d}</span>
              <IconButton
                icon={X}
                size="2xs"
                label={t('删除 {name}', { name: d })}
                onClick={() => onChange(list.filter((x) => x !== d))}
              />
            </span>
          ))}
          <Input
            aria-label={t('搜索时跳过的目录')}
            value={text}
            placeholder={t('目录名，回车添加')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // 回车是加一项，不是提交整个设置表单
              e.preventDefault()
              add()
            }}
            className="h-7 w-[11rem] text-xs"
          />
          <Button variant="secondary" size="sm" onClick={add} disabled={!clean(text)} className="h-7">
            <Plus className="h-3.5 w-3.5" />
            {t('添加')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Button variant="link" onClick={preset}>
            {t('填入 UE 排除清单')}
          </Button>
          {list.length > 0 && (
            <Button variant="link" tone="muted" onClick={() => onChange([])}>
              {t('清空')}
            </Button>
          )}
        </div>
        <span className="text-xs text-subtle">
          {t('此外始终跳过：{list}', { list: DEFAULT_SEARCH_EXCLUDE.join(t('、')) })}
        </span>
      </div>
    </ParamRow>
  )
}
