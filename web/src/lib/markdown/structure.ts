/**
 * `structure` 代码块画成诊断报告的「功能结构」四个页签（设计稿 2026-11-18「Bug 模式子对话体验」第 2 节，效果图 4a–4c）：
 * 调用栈 / 时序图 / 类图 / 架构页。内容由面板拼（shared/bug/views.ts 的 structureMd，JSON），Agent 不直接写这个代码块。
 * 这里只拼 HTML（Markdown 渲染是字符串）；切页签、点图上的节点、装 Archify 由 web/src/components/tasks/structure-views.ts
 * 用事件委托处理。样式在 web/src/components/ui/structure-views.css，可调项是设置 → 组件 → 功能结构的 --c-structure-*
 */
import type { StructurePayload } from '@shared/bug/views'
import { t } from '@shared/i18n'
import { fileRefHtml } from '../file-path'
import { callTreeHtml } from './call-tree'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** lucide 图标的线条（list-tree、git-compare-arrows、network、layout-template、package），静态 HTML 里画不了 React 组件 */
const ICONS: Record<string, string> = {
  stack:
    '<path d="M8 5h13"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="M3 10a2 2 0 0 0 2 2h3"/><path d="M3 5v12a2 2 0 0 0 2 2h3"/>',
  sequence:
    '<circle cx="5" cy="6" r="3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/><path d="m15 9-3-3 3-3"/><circle cx="19" cy="18" r="3"/><path d="M12 18H7a2 2 0 0 1-2-2V9"/><path d="m9 15 3 3-3 3"/>',
  class:
    '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  page: '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
  package:
    '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
}
const icon = (k: string) =>
  `<svg class="sv-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`

type Kind = StructurePayload['pick']
const KINDS: Kind[] = ['stack', 'sequence', 'class', 'page']
const NAME: Record<Kind, () => string> = {
  stack: () => t('调用栈'),
  sequence: () => t('时序图'),
  class: () => t('类图'),
  page: () => t('架构页'),
}

/** JSON 坏了（手写的、截断的）：按普通代码块的样子显示原文，不让整份报告出错 */
function parse(text: string): StructurePayload | null {
  try {
    const p = JSON.parse(text) as StructurePayload
    return p && typeof p === 'object' && Array.isArray(p.diagrams) ? p : null
  } catch {
    return null
  }
}

/** 调用栈有几跳：数 calltree 里非空、非说明行（% 说明、| 代码、--- 断点、=> 边界）的行 */
const hopCount = (stack: string) =>
  stack.split('\n').filter((l) => {
    const s = l.trim()
    return s && !/^(%|\||---|=>)/.test(s)
  }).length

/** 时序图里写了别名的参与者（participant Store as cart/store）图上显示的是别名：点图上的字时按它对回节点 */
function labelOf(source: string, id: string): string {
  const w = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*(?:participant|actor)\\s+${w}\\s+as\\s+(.+?)\\s*$`, 'm').exec(source)?.[1] ?? id
}

/** 图下面一行：节点对到代码的哪里，点了打开文件；对不上的标出来 */
function nodesHtml(d: StructurePayload['diagrams'][number]): string {
  const placed = d.nodes.filter((n) => n.file)
  if (!placed.length) return ''
  const items = placed
    .map((n) => {
      const bad = n.ok === false
      const warn = bad
        ? `<span class="ct-chip ct-chip-warn" title="${esc(n.why ?? '')}">${esc(t('位置没对上代码'))}</span>`
        : ''
      return `<span class="sv-node${bad ? ' sv-node-bad' : ''}" data-sv-node="${esc(n.id)}" data-sv-label="${esc(labelOf(d.source, n.id))}"><span class="sv-node-id">${esc(n.id)}</span>${fileRefHtml({ path: n.file, line: n.line })}${warn}</span>`
    })
    .join('')
  return `<div class="sv-nodes"><span class="sv-nodes-k">${esc(t('节点在代码里'))}</span>${items}</div>`
}

/** 架构页：画好了显示成 HTML 卡片（段落里只有这个 .html 文件标记，html-cards.ts 换成卡片）；没画时说明和安装入口 */
function pageHtml(p: StructurePayload, other?: Kind): string {
  if (p.page) {
    const title = p.page.title ? `<p class="sv-page-title">${esc(p.page.title)}</p>` : ''
    return `${title}<p>${fileRefHtml({ path: p.page.file })}</p>`
  }
  const back = other
    ? `<button type="button" class="sv-link" data-sv-tab="${other}">${esc(t('先看{name}', { name: NAME[other]() }))}</button>`
    : ''
  return (
    `<div class="sv-empty"><span class="sv-empty-ic">${icon('page')}</span><div class="sv-empty-main">` +
    `<div class="sv-empty-head"><b>${esc(t('画成一页能点的架构页'))}</b><span class="sv-badge sv-off">${esc(t('Archify 还没装'))}</span><span class="sv-badge sv-idle">${esc(t('Archify 没打开'))}</span></div>` +
    `<p>${esc(t('一个功能牵涉五六个模块、几十个节点，图放不下时，Archify 会画成单页 HTML：模块总览，点一个模块展开它的调用和数据流，出错点标红。画好在右栏网页页签里打开。'))}</p>` +
    `<p class="sv-on">${esc(t('Archify 已经装好：这一版没有画架构页。要的话在报告上提问「补一张架构页」，下一版它会画好放在这里。'))}</p>` +
    `<p class="sv-idle">${esc(t('Archify 装了但没打开，打开后 Agent 才能用它画。'))}</p>` +
    `<div class="sv-empty-acts"><button type="button" class="sv-btn sv-off" data-sv-act="archify">${icon('package')}${esc(t('安装 Archify（官方配方）'))}</button>` +
    `<button type="button" class="sv-btn sv-idle" data-sv-act="plugins">${esc(t('去插件页打开'))}</button>${back}` +
    `<span class="sv-hint sv-off">${esc(t('装好后这里直接显示 HTML 卡片'))}</span></div></div></div>`
  )
}

/** 整块：页签条 + 「它选的」+ 四个面板（没内容的页签灰掉，架构页总能点：没画时给说明和安装入口） */
export function structureHtml(text: string, mermaid: (src: string) => string): string {
  const p = parse(text)
  if (!p) return `<div class="md-code"><pre><code>${esc(text)}</code></pre></div>`
  const diagram = (k: Kind) => p.diagrams.find((d) => d.kind === k)
  const has: Record<Kind, boolean> = {
    stack: !!p.stack.trim(),
    sequence: !!diagram('sequence'),
    class: !!diagram('class'),
    page: true,
  }
  const on = has[p.pick] ? p.pick : (KINDS.find((k) => has[k] && k !== 'page') ?? 'page')
  const tabs = KINDS.map((k) => {
    const count = k === 'stack' && has.stack ? ` <small>${esc(t('{n} 跳', { n: hopCount(p.stack) }))}</small>` : ''
    return (
      `<button type="button" role="tab" class="sv-tab${k === on ? ' seg-thumb' : ''}" data-sv-tab="${k}" aria-selected="${k === on}"${has[k] ? '' : ' disabled'}>` +
      `${icon(k)}<span>${esc(NAME[k]())}</span>${count}</button>`
    )
  }).join('')
  const why = p.why ? `<span class="sv-why">${esc(t('它选的：{why}', { why: p.why }))}</span>` : ''
  const panel = (k: Kind, body: string) =>
    `<div class="sv-panel" role="tabpanel" data-sv-panel="${k}"${k === on ? ' data-on' : ''}>${body}</div>`
  const diagramPanel = (k: Kind) => {
    const d = diagram(k)
    if (!d) return ''
    const title = d.title ? `<p class="sv-title">${esc(d.title)}</p>` : ''
    return panel(k, `${title}${mermaid(d.source)}${nodesHtml(d)}`)
  }
  const other = (['sequence', 'class', 'stack'] as Kind[]).find((k) => has[k])
  return (
    `<div class="md-sv" data-sv-on="${on}" data-archify="off">` +
    `<div class="sv-head"><div class="sv-tabs seg-track" role="tablist" aria-label="${esc(t('功能结构'))}">${tabs}</div>${why}</div>` +
    (has.stack ? panel('stack', callTreeHtml(p.stack)) : '') +
    diagramPanel('sequence') +
    diagramPanel('class') +
    panel('page', pageHtml(p, other)) +
    `</div>`
  )
}
