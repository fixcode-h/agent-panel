import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { parseCodeIndexItem } from '@shared/mcp-catalog/code-index'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ParamRow } from '@/components/agents/ParamFields'

/**
 * 代码索引 MCP 工具：一项一个 chip，写成「服务名/工具名」。
 * 留空时面板按项目里装的 MCP 服务自动认（search_lua、search_symbols 这类），自动认错了或漏了才在这里指定。
 */
export function CodeIndexField({ value, onChange }: { value: string[] | undefined; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
  const list = value ?? []
  const item = text.trim()
  const valid = !!parseCodeIndexItem(item)
  const add = () => {
    if (!valid || list.includes(item)) return
    setText('')
    onChange([...list, item])
  }
  return (
    <ParamRow
      label={
        <>
          <span className="truncate font-medium text-muted">{t('代码索引工具')}</span>
          <span className="shrink-0 text-caption text-subtle">{t('服务名/工具名')}</span>
        </>
      }
      hint={t(
        'Agent 找函数、类、GM 命令这类代码时，先用这些 MCP 工具按符号查，查不到才用 rg 搜目录。留空时面板按项目里装的 MCP 服务自动认出 search_lua、search_symbols 这类工具；认错或漏了再在这里指定，指定后只用这里的。',
      )}
      stacked
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {list.map((d) => (
          <span key={d} className="flex h-7 items-center gap-1 rounded-md bg-sel/70 pr-1 pl-2 text-footnote text-muted">
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
          aria-label={t('代码索引工具')}
          value={text}
          placeholder={t('例如 uetovs/search_lua，回车添加')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // 回车是加一项，不是提交整个设置表单
            e.preventDefault()
            add()
          }}
          className="h-7 w-[15rem] text-xs"
        />
        <Button variant="secondary" size="sm" onClick={add} disabled={!valid} className="h-7">
          <Plus className="h-3.5 w-3.5" />
          {t('添加')}
        </Button>
      </div>
    </ParamRow>
  )
}
