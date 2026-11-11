import { FileOutput } from 'lucide-react'
import { t } from '@shared/i18n'
import { exportName, type TableExport } from '@shared/table-export'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'

/** 表格页工具栏的「导表」：列出项目设置里的导表脚本，点一个对当前这张表执行 */
export function ExportMenu({ exports, onRun }: { exports: TableExport[]; onRun: (index: number) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7">
          <FileOutput className="h-3.5 w-3.5" />
          {t('导表')}
        </Button>
      </MenuTrigger>
      <MenuContent className="max-w-[360px]">
        {exports.length ? (
          exports.map((x, i) => (
            <MenuItem key={i} onSelect={() => onRun(i)} className="flex-col items-start gap-0.5">
              <span>{exportName(x, i)}</span>
              <span className="w-full truncate font-mono text-caption text-subtle" title={x.command}>
                {x.command}
              </span>
            </MenuItem>
          ))
        ) : (
          <p className="max-w-[280px] px-2.5 py-2 text-footnote leading-relaxed text-subtle">
            {t('还没有导表脚本：在项目设置 → 表格 →「导表脚本」里添加，命令里用 {file} 代表表格路径。')}
          </p>
        )}
      </MenuContent>
    </Menu>
  )
}
