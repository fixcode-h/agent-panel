/**
 * 诊断报告 Markdown 的几种基本写法：表格、小节、提示块、位置、Agent 写的一段文字。
 * 各步骤的页面（bug-diagnosis-md.ts、修复那一步的 bug-fix-md.ts）共用
 */
import { prose } from './prose.ts'
import { codeTerms, marked } from './terms.ts'

/** 表格单元格：文件名、函数名补上反引号（bug-terms.ts）；竖线和换行会打断表格，换行换成 <br> 保住分行 */
export const cell = (v: string) =>
  codeTerms(v)
    .replace(/\|/g, '\\|')
    .trim()
    .replace(/\s*\n\s*/g, '<br>') || '—'
export const table = (head: string[], rows: string[][]) =>
  rows.length
    ? [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
      ].join('\n')
    : ''

/** 一节：这一步要审的用 ##，收起的背景里用 ###（目录里缩在「依据和背景」下面） */
export const sec = (title: string, body: string, level = 2) =>
  body.trim() ? `${'#'.repeat(level)} ${title}\n${body.trim()}` : ''
/** 提示块（> [!WARNING] 这类，渲染成带色条的框）：风险、没经同意就改了的文件，不能和普通正文一个颜色 */
export const alert = (kind: 'important' | 'warning' | 'caution', body: string) =>
  body.trim()
    ? [
        `> [!${kind.toUpperCase()}]`,
        ...body
          .trim()
          .split('\n')
          .map((l) => `> ${l}`.trimEnd()),
      ].join('\n')
    : ''
/** 位置写全路径加行号：渲染时画成文件标记，只显示「文件名:行」，目录在悬停卡片上，点了打开到那一行 */
export const at = (file: string, line?: number) => `\`${file}${line ? `:${line}` : ''}\``

/** Agent 写的一段文字：拆行（prose）、补代码标记、标出要注意的行（bug-terms.ts） */
export const px = (text: string | undefined) => marked(prose(text))
