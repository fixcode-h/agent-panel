import { isHtmlFile } from '@shared/turn-outputs/pick'

/**
 * 回复里的 HTML 文件换成 HTML 卡片（设计稿 6.6，效果图 6）：在 linkPaths 画好的文件标记后面放卡片的占位，
 * Markdown.tsx 再把 TaskHtmlCard 挂进占位（createPortal）。
 * - 一段话里只有这个文件（「`out/rag-pipeline.html`」单独一行）：整段换成卡片，不再留一个小文件标记
 * - 文件夹在句子里：句子照常显示，卡片接在这段后面
 * - 一条回复里第一个 HTML 文件用带缩略预览的大卡片；第二个起、同一个文件后面再提到时用一行的小卡片，
 *   免得一条回复被几张大图撑得很长
 * 只看段落（<p>）：列表、表格里的文件标记照旧，排版不被卡片撑开。流式输出时不调用（占位每 200ms 重建一次，预览会反复重载）
 */
const PARA = /<p>([\s\S]*?)<\/p>/g
/** fileRefHtml 画的一个文件标记：外层、.fr-text、最后一个 .fr-* 三层一起收尾 */
const REF = /<span class="md-path file-ref"[^>]*?data-path="([^"]*)"[^>]*>[\s\S]*?<\/span><\/span><\/span>/g

const unattr = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** 去掉标签后只剩标点和空白：这段话里除了文件标记没别的内容 */
const onlyRefs = (rest: string) => !rest.replace(/<[^>]+>/g, '').replace(/[\s\p{P}]/gu, '')

export function htmlCardSlots(html: string) {
  if (!html.includes('data-file-ref')) return html
  const seen = new Set<string>()
  return html.replace(PARA, (all: string, body: string) => {
    const paths: string[] = []
    for (const m of body.matchAll(REF)) {
      const p = unattr(m[1])
      if (p && isHtmlFile(p) && !paths.includes(p)) paths.push(p)
    }
    if (!paths.length) return all
    const slots = paths
      .map((p) => {
        const variant = seen.size ? 'small' : 'large'
        seen.add(p)
        return `<div class="html-card-slot" data-html-card-slot data-variant="${variant}" data-path="${attr(p)}"></div>`
      })
      .join('')
    // 只剩 HTML 文件标记（别的文件标记也算正文）：整段换成卡片
    const rest = body.replace(REF, (ref: string, p: string) => (isHtmlFile(unattr(p)) ? '' : ref))
    return onlyRefs(rest) ? slots : all + slots
  })
}
