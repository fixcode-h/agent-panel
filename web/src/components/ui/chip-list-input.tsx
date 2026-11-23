import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from './button'
import { IconButton } from './icon-button'
import { Input } from './input'

/**
 * 一串短文本（目录、工具名）一项一个 chip：回车或点「添加」加一项，点 × 删一项。
 * clean 先整理输入（去空白、去尾部斜杠），valid 不过的加不进去；extra 放在 chip 后面（只读的说明 chip）
 */
export function ChipListInput({
  value,
  onChange,
  label,
  placeholder,
  clean = (s) => s.trim(),
  valid = (s) => !!s,
  extra,
  inputClass = 'w-[11rem]',
}: {
  value: string[]
  onChange: (v: string[]) => void
  /** 输入框的无障碍名字 */
  label: string
  placeholder: string
  clean?: (s: string) => string
  valid?: (s: string) => boolean
  extra?: React.ReactNode
  inputClass?: string
}) {
  const [text, setText] = useState('')
  const item = clean(text)
  const ok = valid(item)
  const add = () => {
    if (!ok) return
    setText('')
    if (!value.includes(item)) onChange([...value, item])
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((d) => (
        <span key={d} className="flex h-7 items-center gap-1 rounded-md bg-sel/70 pr-1 pl-2 text-footnote text-muted">
          <span className="font-mono">{d}</span>
          <IconButton
            icon={X}
            size="2xs"
            label={t('删除 {name}', { name: d })}
            onClick={() => onChange(value.filter((x) => x !== d))}
          />
        </span>
      ))}
      {extra}
      <Input
        aria-label={label}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          // 回车是加一项，不是提交整个设置表单
          e.preventDefault()
          add()
        }}
        className={`h-7 text-xs ${inputClass}`}
      />
      <Button variant="secondary" size="sm" onClick={add} disabled={!ok} className="h-7">
        <Plus className="h-3.5 w-3.5" />
        {t('添加')}
      </Button>
    </div>
  )
}
