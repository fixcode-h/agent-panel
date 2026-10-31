import { createContext, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ensureHljs, hljsReady, renderDoc } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import { splitSummaryCards, unfenceSummaries, type SummaryCard } from '@shared/summary-card'
import { linkPaths } from '@/lib/file-path'
import { useFileOpen } from './FileDialog'
import { useChildSummaryOpen } from './child-open'
import { toast } from '@/lib/toast'
import { enhanceMermaid, mermaidAction, mermaidErrorHtml, mermaidHtml, mermaidThemeVars } from '@/lib/mermaid-fx'

/**
 * 任务页提供：总结卡「要你处理」那一行的「处理」按钮把这些事交给当前对话的 Agent（新的一轮，不新建对话）。
 * 没有提供时（设置预览、导出、只读的导入对话）不画按钮
 */
export const HandleNeedsCtx = createContext<((text: string) => Promise<void>) | null>(null)

/**
 * 回复里的总结要不要画成卡片：子对话的任务页给 false。子对话写的是详细总结（shared/summary-card.ts 的
 * summaryDetailRules），用户要它照普通 Markdown 显示；旧的子对话里写过的卡片也一样不画
 */
export const SummaryCardsCtx = createContext(true)

/** 「处理」按钮发给 Agent 的话：卡片标题说清是哪件事，原文照搬，要用户拍板的地方让它先给建议再问 */
export const handleNeedsText = (title: string, needs: string) =>
  t(
    '请直接处理总结卡「{title}」里原本要我处理的事：\n\n{needs}\n\n能自己做的直接做完并验证；必须由我决定的，给出建议后再问我。处理完从刚才停下的地方接着往下做。',
    { title, needs },
  )

let seq = 0
let mermaidLoad: Promise<typeof import('mermaid').default> | undefined
let mermaidTheme = ''

/** mermaid 体积大，只在真的遇到图时才加载；主题跟随当前明暗 */
async function getMermaid() {
  mermaidLoad ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidLoad
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  if (theme !== mermaidTheme) {
    // 用面板自己的配色画图：节点、连线、饼图、甘特都取 Markdown 那组色相（mermaid-fx.ts 的 mermaidThemeVars）
    mermaid.initialize({
      startOnLoad: false,
      // 语法错误时不要在页面最底下画一张「Syntax error」的图（会把页面撑出一大截空白）
      suppressErrorRendering: true,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: getComputedStyle(document.body).fontFamily,
      themeVariables: mermaidThemeVars(theme === 'dark'),
      flowchart: { curve: 'basis', padding: 16, nodeSpacing: 46, rankSpacing: 52 },
      // 时序图、甘特图按自然宽度画，不撑满容器（撑满时字会被放大或缩得很小）
      sequence: { mirrorActors: false, useMaxWidth: false, messageFontSize: 13, actorFontSize: 13, noteFontSize: 13 },
      gantt: { fontSize: 12, sectionFontSize: 12, barHeight: 22, barGap: 6, leftPadding: 56, useWidth: 760 },
    })
    mermaidTheme = theme
  }
  return mermaid
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * 总结卡（shared/summary-card.ts）：类型标签 + 一句话结论在顶上，字段名一列对齐、内容一列，
 * 一眼扫下来就是「原因 / 修复 / 验证」。字段内容仍按 Markdown 渲染（行内代码、路径、链接照常可点）
 */
function cardHtml(card: SummaryCard, teamNames: Set<string>, live?: boolean, act?: boolean, jump?: boolean) {
  const rows = card.fields
    .map((f) => {
      const empty = /^(无|没有|none|n\/a)[。.]?$/i.test(f.text.trim())
      // 「要你处理」：可以一键交给当前对话的 Agent；流式输出还没写完时不放，免得发出去半截
      const handle =
        act && !live && !empty && f.key === 'needs'
          ? `<button type="button" class="md-card-act" data-needs="${escape(f.text)}" data-card="${escape(card.title)}" title="${escape(t('交给当前对话的 Agent 处理'))}">${escape(t('处理'))}</button>`
          : ''
      return `<div class="md-card-row"${f.key ? ` data-key="${f.key}"` : ''}${empty ? ' data-empty' : ''}><dt>${escape(f.label)}${handle}</dt><dd>${renderDoc(f.text, teamNames, live)}</dd></div>`
    })
    .join('')
  const title = renderDoc(card.title, teamNames, live)
  // 父对话写子对话的结果：标题点了在右栏打开那个子对话、滚到它的详细总结。不在父对话页里（导出、预览）就只是文字
  const head =
    card.child && jump
      ? `<button type="button" class="md-card-title md-card-link" data-child-summary="${escape(card.child)}" title="${escape(t('打开子对话，看详细总结'))}">${title}<span class="md-card-go" aria-hidden="true">›</span></button>`
      : `<span class="md-card-title">${title}</span>`
  return `<section class="md-card" data-kind="${card.kind}"${rows ? '' : ' data-bare'}><header class="md-card-head"><span class="md-card-kind">${escape(card.label)}</span>${head}</header>${rows ? `<dl class="md-card-rows">${rows}</dl>` : ''}</section>`
}

/** 回复里有总结卡时分段渲染：卡片画成卡片，其余照常 */
function renderReply(text: string, teamNames: Set<string>, live?: boolean, act?: boolean, jump?: boolean) {
  const segs = splitSummaryCards(text)
  if (segs.length === 1 && 'md' in segs[0]) return renderDoc(text, teamNames, live)
  return segs
    .map((s) => ('md' in s ? renderDoc(s.md, teamNames, live) : cardHtml(s.card, teamNames, live, act, jump)))
    .join('')
}

/**
 * Agent 回复的 Markdown，排版参照 Claude Code：行内代码是小标签，代码块带语言栏、复制按钮和高亮，
 * mermaid 画成图、源码收在下面。流式输出时不画图，等这段输出完再画，免得半截的图反复报错。
 */
export function Markdown({
  text,
  teamNames,
  live,
  compact,
  className,
}: {
  text: string
  teamNames: Set<string>
  live?: boolean
  /** 窄面板里用（提问面板）：字号、段距、列表缩进都收一档 */
  compact?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const openFile = useFileOpen()
  // 在任务页里时，像文件路径的行内代码可以点开看文件
  const canOpen = !!openFile
  const handleNeeds = useContext(HandleNeedsCtx)
  const canAct = !!handleNeeds
  const cards = useContext(SummaryCardsCtx)
  const openSummary = useChildSummaryOpen()
  const canJump = !!openSummary
  // 流式输出每 200ms 换一次文字：解析放到低优先级，输入和滚动不被长回复卡住
  const deferred = useDeferredValue(text)
  const [ready, setReady] = useState(() => hljsReady())
  useEffect(() => {
    if (ready) return
    let off = false
    void ensureHljs().then(() => !off && setReady(true))
    return () => {
      off = true
    }
  }, [ready])
  const html = useMemo(() => {
    // 高亮库加载完（ready 变了）要重算一次，否则代码块一直是没有颜色的原文
    void ready
    const h = cards
      ? renderReply(deferred, teamNames, live, canAct, canJump)
      : renderDoc(unfenceSummaries(deferred), teamNames, live)
    return canOpen ? linkPaths(h) : h
  }, [deferred, teamNames, canOpen, live, ready, canAct, cards, canJump])

  useEffect(() => {
    const root = ref.current
    if (!root || live) return
    const boxes = [...root.querySelectorAll<HTMLElement>('.md-mermaid:not([data-done])')]
    if (!boxes.length) return
    let cancelled = false
    void (async () => {
      const mermaid = await getMermaid().catch(() => null)
      if (!mermaid) return
      for (const box of boxes) {
        if (cancelled) return
        const src = box.dataset.src ?? ''
        const id = `md-mermaid-${++seq}`
        try {
          const { svg } = await mermaid.render(id, src)
          if (cancelled) return
          box.dataset.done = '1'
          box.innerHTML = mermaidHtml(svg, src)
          enhanceMermaid(box)
        } catch (e) {
          // 语法不对的图按普通代码块显示源码，标出画不出来的原因
          box.dataset.done = 'error'
          const why = String((e as Error)?.message ?? '').split('\n')[0]
          box.innerHTML = mermaidErrorHtml(src, why)
        } finally {
          // 出错时 mermaid 会把临时节点留在 body 末尾，清掉；画好的图也用这个 id，只清 body 下面的
          for (const tmp of [`d${id}`, `i${id}`, id]) {
            const el = document.getElementById(tmp)
            if (el && !root.contains(el)) el.remove()
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [html, live])

  // 复制按钮是渲染出来的 HTML，用事件委托处理
  const onClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (el && openFile) {
      // 路径和行号是 linkPaths 解析好放在 data-* 上的，这里直接用
      openFile(el.dataset.path ?? '', el.dataset.mdLine ? Number(el.dataset.mdLine) : undefined)
      return
    }
    const go = (e.target as HTMLElement).closest<HTMLElement>('[data-child-summary]')
    if (go && openSummary) return openSummary(go.dataset.childSummary ?? '')
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-needs]')
    if (act && handleNeeds) {
      if (act.disabled) return
      // 发出去之前就锁住：连点两下不会让 Agent 收到两遍。按钮是渲染出来的 HTML，状态直接写在元素上
      act.disabled = true
      act.textContent = t('发送中')
      handleNeeds(handleNeedsText(act.dataset.card ?? '', act.dataset.needs ?? '')).then(
        () => (act.textContent = t('已交给 Agent')),
        (err: Error) => {
          act.disabled = false
          act.textContent = t('处理')
          toast.error(err.message)
        },
      )
      return
    }
    const mmd = (e.target as HTMLElement).closest<HTMLElement>('[data-mmd]')
    if (mmd) return mermaidAction(mmd)
    // 折行：只切这一个代码块，不改设置
    const wrap = (e.target as HTMLElement).closest<HTMLElement>('[data-wrap]')
    if (wrap) {
      const box = wrap.closest<HTMLElement>('.md-code')
      if (!box) return
      if (box.toggleAttribute('data-wrap')) wrap.dataset.on = ''
      else delete wrap.dataset.on
      return
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]')
    if (!btn) return
    const code = btn.closest('.md-code')?.querySelector('code')?.textContent ?? ''
    void copyText(code, { fail: false }).then((ok) => {
      if (!ok) return
      // 「复制」「已复制」两个字样叠在按钮里（workflow-doc.ts 的 codeBar），切 data-done 交叉切换，按钮宽度不跳
      const swap = btn.querySelector<HTMLElement>('.swap')
      swap?.setAttribute('data-done', '')
      setTimeout(() => swap?.removeAttribute('data-done'), 1500)
    })
  }

  return (
    <div
      ref={ref}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).dataset.path) onClick(e as unknown as React.MouseEvent)
      }}
      className={cn('chat-md [overflow-wrap:anywhere]', compact && 'chat-md-compact', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
