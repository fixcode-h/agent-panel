/** 回复里的 Markdown 表格：复制、全屏、点表头排序、长表限高（web/src/lib/markdown/table.ts） */
export const EN_MD_TABLE: Record<string, string> = {
  工具条: 'Toolbar',
  '鼠标移到表格上时右上角浮出：复制成 TSV 或 Markdown、全屏查看。':
    'Appears in the top-right corner when you hover a table: copy as TSV or Markdown, or view full screen.',
  表格工具条: 'Table toolbar',
  点表头排序: 'Sort by header',
  '点一下升序、再点降序、第三下回到原顺序，只改显示。':
    'Click once for ascending, again for descending, a third time for the original order. Only the display changes.',
  长表限高: 'Long table height',
  '超过约这么多行时表格限高、在表格里滚动，表头钉在顶上。0 表示不限高。':
    'Tables longer than about this many rows get a fixed height and scroll inside, with the header pinned. 0 means no limit.',
  长表限高行数: 'Long table row limit',
  '{shown} / {n} 行 · {cols} 列': '{shown} / {n} rows · {cols} columns',
  '{n} 行 · {cols} 列': '{n} rows · {cols} columns',
  在表格中查找: 'Find in table',
  '复制成 TSV（能直接粘进 Excel）': 'Copy as TSV (pastes straight into Excel)',
  '复制成 Markdown': 'Copy as Markdown',
  '复制成 TSV': 'Copy as TSV',
  '粘进 Excel、WPS 正好一格一格': 'Pastes into Excel or WPS cell by cell',
  '按现在的排序，格子里的写法原样保留': 'In the current order, cell formatting kept as written',
  复制表格: 'Copy table',
  '全屏查看，能查找、筛选、排序': 'View full screen with find, filter and sort',
}
