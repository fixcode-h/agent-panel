import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { useHljs } from '@/lib/file-highlight'
import { cn } from '@/lib/utils'

// 编辑器（CodeMirror）和文件弹窗同一个，按需加载：没打开代码框的页面不用下载它
const CodeEditor = lazy(() => import('@/components/files/CodeEditor'))

/**
 * 表单里的代码框：一小段代码（Lua、JSON、命令……）直接在表单里写，带语法高亮、Tab 缩进、撤销。
 * 和文件弹窗的编辑区是同一个 CodeMirror 编辑器（files/CodeEditor），高亮也是同一套（按 lang 当扩展名认语言）；
 * 不抢焦点、不带保存键（Ctrl/Cmd+S 交给 onSave，不给就什么也不做）。插件经 host.ui.CodeField 用（2026-11-28 加的）
 */
export function CodeField({
  value,
  onChange,
  lang,
  height = 160,
  onSave,
  label,
  placeholder,
  className,
}: {
  value: string
  onChange: (v: string) => void
  /** 语言：扩展名写法（lua、json、ts、sh…），高亮按它选 */
  lang: string
  /** 编辑区高度（px），右下角能拖大小 */
  height?: number
  onSave?: () => void
  label?: string
  /** 空着时在上面显示的提示 */
  placeholder?: string
  className?: string
}) {
  const hl = useHljs()
  // 回调要拿最新的 onChange / onSave；ed 本身只建一次，免得编辑器重建
  const cb = useRef({ onChange, onSave })
  cb.current = { onChange, onSave }
  const ed = useMemo(
    () => ({
      text: value,
      setText: (v: string) => cb.current.onChange(v),
      save: async () => cb.current.onSave?.(),
    }),
    [value],
  )
  return (
    <div
      className={cn(
        'relative resize-y overflow-hidden rounded-(--c-input-radius) border-(length:--c-input-border) border-line-strong bg-(--c-input-bg) focus-within:border-accent',
        className,
      )}
      style={{ height, minHeight: 60 }}
    >
      <Suspense fallback={<pre className="h-full overflow-auto px-4 py-2 font-mono text-footnote">{value}</pre>}>
        <CodeEditor ed={ed} path={`snippet.${lang}`} hl={hl} autoFocus={false} label={label ?? t('代码')} />
      </Suspense>
      {!value && placeholder && (
        <span className="pointer-events-none absolute top-2 left-4 font-mono text-footnote text-subtle">
          {placeholder}
        </span>
      )}
    </div>
  )
}

/** 设置 → 组件里的样子 */
export function CodeFieldSpecimen() {
  const [code, setCode] = useState('local Bag = require("Game.Bag.BagModule")\nreturn Bag.GetCount(itemId)\n')
  return (
    <div className="w-full max-w-[520px]">
      <CodeField value={code} onChange={setCode} lang="lua" height={120} placeholder="return 1 + 1" />
    </div>
  )
}
