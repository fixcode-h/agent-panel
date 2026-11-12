import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardCopy, FileCode2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { copyText } from '@/lib/copy-text'
import {
  markUnderlay,
  placeTools,
  sortByHeader,
  sortEnabled,
  tableMarkdown,
  tableRows,
  tableRowsOriginal,
  toTsv,
} from '@/lib/markdown/table'
import { MenuItem, PointMenu } from '@/components/ui/menu'
import { MdTableDialog } from './MdTableDialog'

/**
 * 回复里 Markdown 表格的交互（分析稿第 28、29 条）：表格是渲染出来的 HTML，点击由 Markdown.tsx 委托到 onClick，
 * 这里管复制菜单（TSV / Markdown）、全屏弹窗和点表头排序。流式输出时 HTML 每 200ms 换一次，不排序（排了也会被冲掉）
 */
export function useMdTables(root: React.RefObject<HTMLDivElement | null>, html: string, live?: boolean) {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; box: HTMLElement } | null>(null)
  const [full, setFull] = useState<{ rows: string[][]; src: string } | null>(null)

  // 表头钉住时要不透明的底：按表格所在区域的底色来；窄表格的工具条挪到表格右边外面（宽度变了重新量）
  useEffect(() => {
    const el = root.current
    if (!el || !el.querySelector('.md-table')) return
    markUnderlay(el)
    placeTools(el)
    const ro = new ResizeObserver(() => placeTools(el))
    ro.observe(el)
    return () => ro.disconnect()
  }, [root, html])

  // 菜单开着时工具条别淡出去
  useEffect(() => {
    if (!menu) return
    const tools = menu.box.querySelector<HTMLElement>('.md-table-tools')
    tools?.setAttribute('data-open', '')
    return () => tools?.removeAttribute('data-open')
  }, [menu])

  /** 是表格上的点击就处理掉并返回 true */
  const onClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement
    const box = el.closest<HTMLElement>('.md-table')
    const table = box?.querySelector('table')
    if (!box || !table) return false
    const btn = el.closest<HTMLElement>('[data-table]')
    if (btn?.dataset.table === 'copy') {
      const r = btn.getBoundingClientRect()
      setMenu({ at: { x: r.left, y: r.bottom }, box })
      return true
    }
    if (btn?.dataset.table === 'full') {
      setFull({ rows: tableRowsOriginal(table), src: box.dataset.src ?? '' })
      return true
    }
    // 表头里的链接、文件标记照常点开
    const th = el.closest('th')
    if (th && !live && !el.closest('a, button, [data-file-ref]') && sortEnabled(th)) {
      sortByHeader(th)
      return true
    }
    return false
  }

  const copy = (kind: 'tsv' | 'md') => {
    const table = menu?.box.querySelector('table')
    if (!menu || !table) return
    const text = kind === 'tsv' ? toTsv(tableRows(table)) : tableMarkdown(menu.box, table)
    void copyText(text, { done: t('已复制'), fail: t('复制失败') })
  }

  // 菜单的锚点是 fixed 定位：放进 body，免得在有 transform 的弹窗（设置预览）里按弹窗算坐标、菜单飘走
  const layer = (
    <>
      {createPortal(
        <PointMenu at={menu?.at ?? null} open={!!menu} onOpenChange={(o) => !o && setMenu(null)}>
          <MenuItem onSelect={() => copy('tsv')}>
            <ClipboardCopy className="h-4 w-4 text-subtle" />
            <span className="flex min-w-0 flex-col">
              <span>{t('复制成 TSV')}</span>
              <span className="text-caption text-subtle">{t('粘进 Excel、WPS 正好一格一格')}</span>
            </span>
          </MenuItem>
          <MenuItem onSelect={() => copy('md')}>
            <FileCode2 className="h-4 w-4 text-subtle" />
            <span className="flex min-w-0 flex-col">
              <span>{t('复制成 Markdown')}</span>
              <span className="text-caption text-subtle">{t('按现在的排序，格子里的写法原样保留')}</span>
            </span>
          </MenuItem>
        </PointMenu>,
        document.body,
      )}
      <MdTableDialog table={full} onClose={() => setFull(null)} />
    </>
  )
  return { onClick, layer }
}
