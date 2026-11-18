import { t } from '@shared/i18n'

/** 示例里的行：只是撑出能滚的内容 */
const ROWS = Array.from({ length: 24 }, (_, i) => i + 1)

/**
 * 设置 → 组件里滚动条的样张：一块竖着滚、一块横竖都能滚，和全站滚动区同一套样式（index.css 的 ::-webkit-scrollbar），
 * 调宽度、颜色、「平时」时边调边看
 */
export function ScrollbarSpecimen() {
  return (
    <div className="flex w-full flex-wrap items-start gap-4">
      <div className="flex w-56 flex-col gap-1.5">
        <span className="text-footnote text-subtle">{t('竖向列表')}</span>
        <div className="h-40 overflow-y-auto rounded-lg bg-panel p-1.5">
          {ROWS.map((n) => (
            <div key={n} className="rounded-(--c-nav-radius) px-2 py-1 text-body text-fg hover:bg-sel">
              {t('第 {n} 行', { n })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
        <span className="text-footnote text-subtle">{t('横竖都能滚（代码、表格）')}</span>
        <pre className="h-40 overflow-auto rounded-lg bg-(--code-bg) p-3 font-mono text-footnote text-fg">
          {ROWS.map(
            (n) =>
              `${String(n).padStart(2, '0')}  const value${n} = compute(${'input, '.repeat((n % 9) + 4)}options)\n`,
          ).join('')}
        </pre>
      </div>
    </div>
  )
}
