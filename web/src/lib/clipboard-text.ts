// 复制 / 剪切输入框里的一段内容时写进剪贴板的两种格式：
// - text/plain：面板自己的输入框只读这一种（onPaste 里 getData('text/plain')），卡片按标记、路径还原成卡片；
// - text/html：粘到 Word、Excel、邮件这些富文本目标时不再是一整行，换行和行首空白还在。
// 两种格式由同一份文字生成，只有一份事实源，不会各写一套。

/** 剪贴板里要写的格式和内容 */
export type ClipboardText = Record<'text/plain' | 'text/html', string>

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

/** 文字里的 HTML 特殊字符换成实体，粘到别的程序里不会把一段文字当成标签 */
export const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPE[c])

/**
 * 纯文本转成最小的 HTML：换行用 <br>（Word、Excel 都认），
 * white-space: pre-wrap 让行首缩进和连续空格原样保留。不加字号、颜色这些样式，粘贴目标自己的格式优先
 */
export function textToHtml(text: string): string {
  const body = text.split('\n').map(escapeHtml).join('<br>')
  return `<div style="white-space: pre-wrap">${body}</div>`
}

/** 一段文字对应的两种格式 */
export function clipboardText(text: string): ClipboardText {
  return { 'text/plain': text, 'text/html': textToHtml(text) }
}

/**
 * 把两种格式一起写进剪贴板事件的数据。
 * 只用到 setData，测试里传一个收集用的假对象就能核对写了哪些格式
 */
export function setClipboardText(data: Pick<DataTransfer, 'setData'>, text: string) {
  const formats = clipboardText(text)
  for (const type of Object.keys(formats) as (keyof ClipboardText)[]) data.setData(type, formats[type])
}
