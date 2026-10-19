import { useEffect, useMemo, useRef } from 'react'
import { renderDoc } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { linkPaths, parsePath, useFileOpen } from './FileDialog'

let seq = 0
let mermaidLoad: Promise<typeof import('mermaid').default> | undefined
let mermaidTheme = ''

/** mermaid 体积大，只在真的遇到图时才加载；主题跟随当前明暗 */
async function getMermaid() {
  mermaidLoad ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidLoad
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  if (theme !== mermaidTheme) {
    // 用面板自己的配色画图：节点是卡片色、线是次要文字色，和代码块的底色融在一起
    const css = getComputedStyle(document.documentElement)
    const v = (k: string) => css.getPropertyValue(k).trim()
    mermaid.initialize({
      startOnLoad: false,
      // 语法错误时不要在页面最底下画一张「Syntax error」的图（会把页面撑出一大截空白）
      suppressErrorRendering: true,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: getComputedStyle(document.body).fontFamily,
      themeVariables: {
        darkMode: theme === 'dark',
        background: v('--code-bg'),
        primaryColor: v('--card'),
        primaryTextColor: v('--fg'),
        primaryBorderColor: v('--line-strong'),
        secondaryColor: v('--field'),
        tertiaryColor: v('--panel'),
        lineColor: v('--subtle'),
        textColor: v('--fg'),
        edgeLabelBackground: v('--code-bg'),
        clusterBkg: v('--panel'),
        clusterBorder: v('--line'),
        fontSize: '13px',
      },
    })
    mermaidTheme = theme
  }
  return mermaid
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Agent 回复的 Markdown，排版参照 Claude Code：行内代码是小标签，代码块带语言栏、复制按钮和高亮，
 * mermaid 画成图、源码收在下面。流式输出时不画图，等这段输出完再画，免得半截的图反复报错。
 */
export function Markdown({
  text,
  teamNames,
  live,
  className,
}: {
  text: string
  teamNames: Set<string>
  live?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const openFile = useFileOpen()
  // 在任务页里时，像文件路径的行内代码可以点开看文件
  const canOpen = !!openFile
  const html = useMemo(() => {
    const h = renderDoc(text, teamNames)
    return canOpen ? linkPaths(h) : h
  }, [text, teamNames, canOpen])

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
          box.innerHTML = `<div class="md-mermaid-svg">${svg}</div><details><summary>${t('源码')}</summary><pre><code>${escape(src)}</code></pre></details>`
        } catch (e) {
          // 语法不对的图按普通代码块显示源码，标出画不出来的原因
          box.dataset.done = 'error'
          const why = String((e as Error)?.message ?? '').split('\n')[0]
          box.innerHTML = `<div class="md-code"><div class="md-code-bar"><span>mermaid · ${escape(t('图的语法有误，显示源码'))}</span><button type="button" class="md-copy" data-copy>${t('复制')}</button></div><pre><code title="${escape(why)}">${escape(src)}</code></pre></div>`
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
    const file = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (file && openFile) {
      const p = parsePath(file.textContent ?? '')
      if (p) openFile(p.path, p.line)
      return
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]')
    if (!btn) return
    const code = btn.closest('.md-code')?.querySelector('code')?.textContent ?? ''
    void navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = t('已复制')
      setTimeout(() => (btn.textContent = t('复制')), 1500)
    })
  }

  return (
    <div
      ref={ref}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).dataset.path) onClick(e as unknown as React.MouseEvent)
      }}
      className={cn('chat-md [overflow-wrap:anywhere]', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
