/**
 * 回复里的 Markdown 表格（分析稿第 28、29 条）：外面包一层 .md-table，放悬停工具条（复制成 TSV / Markdown、全屏看），
 * 点表头按这一列排序（只改显示，不动回复原文）。渲染在 workflow-doc.ts 的 renderer.table，点击由 Markdown.tsx 委托过来。
 *
 * 纯函数（HTML 拼接、TSV / Markdown 生成、排序顺序）在前面，单测在 table.test.ts；后面几个直接动 DOM 的只在页面里用。
 */
import { t } from '@shared/i18n'
import { writeCsv } from '@shared/csv'
import { visibleRows } from '@/lib/sheet-filter'

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// lucide 的 copy、maximize-2：渲染出来的是 HTML 字符串，图标只能内联
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
const ICON_FULL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/></svg>'

/**
 * 表格外面包一层：data-src 是表格的 Markdown 原文（复制成 Markdown 时按显示顺序重排各行），
 * data-rows 是数据行数。工具条放在表格前面，绝对定位浮在右上角、一半压在表格上沿外面，
 * 只有两个图标（悬停看说明），尽量少挡表头（窄表格的最后一列表头还要能点）
 */
export function tableHtml(table: string, raw: string, rows: number) {
  const tools =
    `<span class="md-table-tools">` +
    `<button type="button" class="md-copy" data-table="copy" aria-haspopup="menu" title="${escape(t('复制表格'))}" aria-label="${escape(t('复制表格'))}">${ICON_COPY}</button>` +
    `<button type="button" class="md-copy" data-table="full" title="${escape(t('全屏查看，能查找、筛选、排序'))}" aria-label="${escape(t('全屏查看，能查找、筛选、排序'))}">${ICON_FULL}</button>` +
    `</span>`
  return `<div class="md-table" data-rows="${rows}" data-src="${escape(raw.replace(/\s+$/, ''))}">${tools}${table}</div>`
}

/** 一行行的格子写成 TSV：粘进 Excel / WPS 正好一格一格；格子里有制表符、换行、引号的加引号（和 Excel 复制出来的一样） */
export const toTsv = (rows: string[][]) =>
  writeCsv(rows, { delimiter: '\t', eol: 'lf', bom: false, trailingEol: false })

/**
 * 按显示顺序重排 Markdown 原文的各行：GFM 表格一行就是一行字，第 1 行表头、第 2 行对齐行，后面是数据行。
 * order 是数据行原来的序号；原文行数对不上（不该发生）时原样返回。行首的缩进（列表里的表格）去掉
 */
export function reorderMarkdown(raw: string, order: number[]) {
  const lines = raw
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((l) => l.trimStart())
  if (lines.length !== order.length + 2) return lines.join('\n')
  return [lines[0], lines[1], ...order.map((i) => lines[i + 2])].join('\n')
}

/**
 * 排序用的值：回复里的数字常带千分位、百分号、货币符号、单位（1,234、45%、¥12、300ms），
 * 去掉这些再交给表格共用的比较（数字按大小、文字按自然顺序、空格子在最后）
 */
export function sortKey(text: string) {
  const s = text.trim()
  const m =
    /^[~≈±+]?[$¥€£]?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(%|[a-zA-Z]{1,3}|[一-鿿]{1,2})?$/.exec(s)
  return m ? m[1].replace(/,/g, '') : s
}

/** 按某一列排序后的数据行顺序（原来的序号）；desc 为 undefined 时是原顺序 */
export function sortedOrder(cells: string[], desc: boolean | undefined) {
  const rows = cells.map((c) => [sortKey(c)])
  return visibleRows(rows, 0, {}, desc === undefined ? null : { col: 0, desc })
}

// ---- 下面直接动页面上的表格 ----

/** 格子里的字：<br> 换成换行（innerText 按排版取），没排版时（藏着的）退回 textContent */
const cellText = (el: HTMLTableCellElement | undefined) =>
  ((el?.isConnected && el.innerText) || el?.textContent || '').trim()

/** 数据行按原来的顺序：第一次排序时给每行记下原来的序号 */
function bodyRows(table: HTMLTableElement) {
  const trs = [...(table.tBodies[0]?.rows ?? [])]
  trs.forEach((tr, i) => (tr.dataset.i ??= String(i)))
  return trs
}
const indexOf = (tr: HTMLTableRowElement) => Number(tr.dataset.i ?? 0)

/** 表格现在显示的样子：表头一行 + 数据行（按当前排序） */
export function tableRows(table: HTMLTableElement) {
  const head = [...(table.tHead?.rows[0]?.cells ?? [])].map(cellText)
  const body = bodyRows(table).map((tr) => [...tr.cells].map(cellText))
  return [head, ...body]
}

/** 全屏用：数据行按回复里原来的顺序（全屏里有自己的排序） */
export function tableRowsOriginal(table: HTMLTableElement) {
  const head = [...(table.tHead?.rows[0]?.cells ?? [])].map(cellText)
  const body = bodyRows(table)
    .sort((a, b) => indexOf(a) - indexOf(b))
    .map((tr) => [...tr.cells].map(cellText))
  return [head, ...body]
}

/** 复制成 Markdown：原文按当前显示顺序重排（保留格子里的行内代码、加粗这些写法） */
export function tableMarkdown(box: HTMLElement, table: HTMLTableElement) {
  const raw = box.dataset.src ?? ''
  return reorderMarkdown(raw, bodyRows(table).map(indexOf))
}

/** 点表头：没排 → 升序 → 降序 → 回到原顺序。只重排页面上的行，回复原文不动 */
export function sortByHeader(th: HTMLTableCellElement) {
  const table = th.closest('table')
  const body = table?.tBodies[0]
  if (!table || !body) return
  const now = th.dataset.sort
  const next = now === undefined ? 'asc' : now === 'asc' ? 'desc' : undefined
  for (const h of table.tHead?.rows[0]?.cells ?? []) {
    delete h.dataset.sort
    h.removeAttribute('aria-sort')
  }
  const rows = bodyRows(table).sort((a, b) => indexOf(a) - indexOf(b))
  const order = sortedOrder(
    rows.map((tr) => cellText(tr.cells[th.cellIndex])),
    next === undefined ? undefined : next === 'desc',
  )
  if (next) {
    th.dataset.sort = next
    th.setAttribute('aria-sort', next === 'asc' ? 'ascending' : 'descending')
  }
  body.append(...order.map((i) => rows[i]))
}

/** 设置里关了「点表头排序」时不排（开关落在 CSS 变量上：开是 pointer） */
export const sortEnabled = (el: Element) => getComputedStyle(el).getPropertyValue('--md-table-sort').trim() !== 'auto'

/**
 * 表头钉在顶上时，下面的行从它底下滚过：表头的半透明底色要叠在所在区域的底色上。
 * 往上找第一个不透明的底色记到 --md-table-under（对话正文、卡片、弹窗底色各不相同）
 */
export function markUnderlay(root: HTMLElement) {
  if (!root.querySelector('.md-table')) return
  for (let el: HTMLElement | null = root; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor
    if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) {
      root.style.setProperty('--md-table-under', bg)
      return
    }
  }
}

/** 工具条放到表格右边外面要的宽度（两个图标 + 间距） */
const TOOLS_ROOM = 72

/**
 * 窄表格（右边还有空）：工具条挪到表格右边外面，不压最后一列的表头；宽到占满一行的才浮在右上角。
 * 渲染后、窗口宽度变了以后各量一次
 */
export function placeTools(root: HTMLElement) {
  for (const box of root.querySelectorAll<HTMLElement>('.md-table')) {
    const room = (box.parentElement?.clientWidth ?? 0) - box.offsetWidth
    box.toggleAttribute('data-roomy', room >= TOOLS_ROOM)
  }
}
