/**
 * `calltree` 代码块画成调用栈树（设计稿 2026-11-13「诊断报告：关键调用栈」第 6 节）：诊断报告和对话回复共用。
 * 文本解析在 shared/bug/call-tree.ts；这里只拼 HTML（Markdown 渲染是字符串，和 mermaid、表格一样走 renderer.code）。
 * 样式在 web/src/components/ui/call-tree.css，可调项是设置 → 组件 → 调用栈树的 --c-callTree-*。
 * 位置画成和正文一样的文件标记（能点开、悬停看全路径）；旁支收进 <details>，不用脚本就能展开
 */
import { parseCallTree, type CallItem, type CallNode, type CallRef } from '@shared/bug/call-tree'
import { t } from '@shared/i18n'
import { fileRefHtml } from '../file-path'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** 图标：入口圆圈、路过的点、出错点菱形、没走到的虚线圈、现象的「!」、旁支空心点（形状在 CSS 里画） */
const ROLE_CLS: Record<CallNode['role'], string> = {
  entry: 'ct-entry',
  path: 'ct-path',
  fault: 'ct-fault',
  missed: 'ct-missed',
  symptom: 'ct-symptom',
  side: 'ct-side',
}

const refLabel = (r: CallRef) => {
  const head = /^L\d/i.test(r.id) ? t('日志') : /^H\d/i.test(r.id) ? t('假设') : ''
  if (r.hit === true) return { cls: 'ct-ref-hit', text: `${r.id} ✓`, title: t('{id} 打出来了', { id: r.id }) }
  if (r.hit === false) return { cls: 'ct-ref-miss', text: `${r.id} ✗`, title: t('{id} 该打没打', { id: r.id }) }
  if (r.wait) return { cls: 'ct-ref-wait', text: r.id, title: t('{id} 还没复现', { id: r.id }) }
  return { cls: '', text: r.id, title: head ? `${head} ${r.id}` : r.id }
}

function tagHtml(tag: string): string {
  const [kind, arg = ''] = tag.split(':')
  if (kind === 'fix') return `<span class="ct-chip ct-chip-fix">${esc(t('改这里 · 方案 {id}', { id: arg }))}</span>`
  if (kind === 'alt') return `<span class="ct-chip ct-chip-alt">${esc(t('方案 {id}', { id: arg }))}</span>`
  if (kind === 'nomatch') return `<span class="ct-chip ct-chip-warn">${esc(t('位置没对上代码'))}</span>`
  if (kind === 'frame') return `<span class="ct-chip ct-chip-ok">${esc(t('对上报错堆栈'))}</span>`
  return `<span class="ct-chip">#${esc(tag)}</span>`
}

/** 位置：带目录的画成文件标记，目录部分可在设置里隐藏（--c-callTree-dir） */
function locHtml(n: CallNode): string {
  if (!n.file) return ''
  const parts = n.file.replace(/\\/g, '/').split('/')
  const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : undefined
  return `<span class="ct-loc">${fileRefHtml({ path: n.file, line: n.line }, { parent })}</span>`
}

function codeHtml(n: CallNode): string {
  if (!n.code.length) return ''
  const rows = n.code
    .map(
      (c) =>
        `<div class="ct-code-row${c.mark ? ' ct-code-mark' : ''}"><span class="ct-code-ln">${c.line ?? ''}</span><span>${esc(c.text) || ' '}</span></div>`,
    )
    .join('')
  return `<div class="ct-code">${rows}</div>`
}

function metaHtml(n: CallNode): string {
  const parts: string[] = []
  if (n.cond)
    parts.push(
      `<span class="ct-cond">${esc(t('分支'))} <code class="ct-val">${esc(n.cond.text)}</code>${n.cond.took ? ` ${esc(t('走了'))} <b>${esc(n.cond.took)}</b>` : ''}</span>`,
    )
  for (const v of n.values) {
    const actual = v.name ? `${v.name} = ${v.actual}` : v.actual
    parts.push(
      v.expected
        ? `<span class="ct-val ct-val-bad">${esc(actual)}<span class="ct-expect">${esc(t('期望 {v}', { v: v.expected }))}</span></span>`
        : `<span class="ct-val">${esc(actual)}</span>`,
    )
  }
  for (const r of n.refs) {
    const l = refLabel(r)
    parts.push(`<span class="ct-chip ${l.cls}" title="${esc(l.title)}">${esc(l.text)}</span>`)
  }
  parts.push(...n.tags.map(tagHtml))
  return parts.length ? `<div class="ct-meta">${parts.join('')}</div>` : ''
}

function nodeHtml(n: CallNode): string {
  const edge = n.edge ? `<div class="ct-edge"><span>${esc(n.edge)}</span></div>` : ''
  const row =
    `<div class="ct-row ${ROLE_CLS[n.role]}-row"><span class="ct-ic ${ROLE_CLS[n.role]}" aria-hidden="true"></span>` +
    `<div class="ct-main"><div class="ct-head"><span class="ct-fn">${esc(n.fn)}</span>` +
    (n.role === 'fault' ? `<span class="ct-chip ct-chip-fault">${esc(t('出错点'))}</span>` : '') +
    (n.role === 'missed' ? `<span class="ct-chip">${esc(t('没走到'))}</span>` : '') +
    (n.note ? `<span class="ct-note">${esc(n.note)}</span>` : '') +
    `${locHtml(n)}</div>${metaHtml(n)}${codeHtml(n)}</div></div>`
  return `<li class="ct-li ${ROLE_CLS[n.role]}-li">${edge}${row}${listHtml(n.children)}</li>`
}

/** 一层子项：连着的旁支收进一个「＋N 个旁支」 */
function listHtml(items: CallItem[]): string {
  if (!items.length) return ''
  const out: string[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'cut') {
      out.push(`<li class="ct-li ct-cut-li"><div class="ct-cut"><span>${esc(it.text)}</span></div></li>`)
      continue
    }
    if (it.node.role !== 'side') {
      out.push(nodeHtml(it.node))
      continue
    }
    const side: CallNode[] = []
    while (i < items.length && items[i].kind === 'node' && (items[i] as { node: CallNode }).node.role === 'side')
      side.push((items[i++] as { node: CallNode }).node)
    i--
    const names = side.map((n) => n.fn).join(' · ')
    out.push(
      `<li class="ct-li ct-more-li"><details class="ct-more"><summary>${esc(t('＋{n} 个旁支', { n: side.length }))}<span class="ct-more-names">${esc(names)}</span></summary><ul class="ct-ul">${side.map(nodeHtml).join('')}</ul></details></li>`,
    )
  }
  return `<ul class="ct-ul">${out.join('')}</ul>`
}

const LEGEND = () =>
  `<div class="ct-legend"><span><i class="ct-lg"></i>${esc(t('执行到了'))}</span><span><i class="ct-lg ct-lg-missed"></i>${esc(t('该走没走到'))}</span><span><i class="ct-lg ct-lg-edge"></i>${esc(t('异步、事件、跨进程'))}</span><span><i class="ct-ic ct-fault"></i>${esc(t('出错点'))}</span></div>`

/** 整个代码块：顶栏（名字、说明、复制原文）+ 树 + 图例；复制按钮复制的是 calltree 原文（data-src） */
export function callTreeHtml(text: string): string {
  const tree = parseCallTree(text)
  const nodes = (items: CallItem[]): number =>
    items.reduce((n, i) => n + (i.kind === 'node' ? 1 + nodes(i.node.children) : 0), 0)
  const count = nodes(tree.items)
  const cap = tree.caption.map((c) => ` · ${esc(c)}`).join('')
  const bar =
    `<div class="md-code-bar"><span class="md-code-lang">${esc(t('调用栈'))} <small>${esc(t('{n} 跳', { n: count }))}${cap}</small></span>` +
    `<span class="md-code-acts"><button type="button" class="md-copy" data-copy><span class="swap"><span>${esc(t('复制'))}</span><span>${esc(t('已复制'))}</span></span></button></span></div>`
  return `<div class="md-code md-calltree" data-src="${esc(text)}">${bar}<div class="ct-body">${listHtml(tree.items)}</div>${LEGEND()}</div>`
}
