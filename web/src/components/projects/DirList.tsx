import { useState } from 'react'
import { FolderOpen, FolderPlus, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { DirBrowser } from './DirPicker'

/** 选中的目录在 base 里时换成相对 base 的路径（跟着项目走，换台电脑也对）；不在就留绝对路径 */
export function relTo(base: string, picked: string) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const b = norm(base)
  const p = norm(picked)
  if (!b) return p
  // Windows 盘符、路径不分大小写；Linux / macOS 上大小写不同就当不在里面
  const win = /^[a-zA-Z]:\//.test(b)
  const same = (x: string, y: string) => (win ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (same(p, b)) return '.'
  const head = p.slice(0, b.length + 1)
  return same(head, `${b}/`) ? p.slice(b.length + 1) : p
}

/**
 * 一组目录：每个目录一行（可以直接改路径、点「浏览」换、删掉），「添加目录」弹出目录选择器选一个就多一行。
 * 选到 base 里的目录自动写成相对路径。每行下面的状态（找到几个文件、找不到）由调用处给
 */
export function DirList({
  value,
  onChange,
  base,
  status,
  placeholder,
  addLabel = t('添加目录'),
  browseTitle = t('选择目录'),
}: {
  value: string[]
  onChange: (v: string[]) => void
  /** 相对路径的基准（项目目录，已展开成绝对路径）；也是选择器打开时的起点 */
  base: string
  /** 第 i 行下面的一行状态 */
  status?: (dir: string, i: number) => React.ReactNode
  placeholder?: string
  addLabel?: string
  browseTitle?: string
}) {
  // null：没在选；-1：选好后新增一行；其它：换掉第几行
  const [picking, setPicking] = useState<number | null>(null)
  const join = (d: string) => (d === '.' || !d ? base : /^([a-zA-Z]:)?[\\/]|^~/.test(d) ? d : `${base}/${d}`)
  const put = (i: number, v: string) => onChange(value.map((x, k) => (k === i ? v : x)))
  return (
    <div className="flex flex-col gap-2">
      {value.map((d, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Input
              value={d}
              onChange={(e) => put(i, e.target.value)}
              placeholder={placeholder}
              aria-label={t('第 {n} 个目录', { n: i + 1 })}
              className="font-mono text-footnote"
            />
            <IconButton icon={FolderOpen} size="sm" label={t('浏览')} onClick={() => setPicking(i)} />
            <IconButton
              icon={X}
              size="sm"
              label={t('删掉这个目录')}
              onClick={() => onChange(value.filter((_, k) => k !== i))}
            />
          </div>
          {status && <div className="pl-1">{status(d, i)}</div>}
        </div>
      ))}
      <div>
        <Button variant="secondary" size="sm" onClick={() => setPicking(-1)}>
          <FolderPlus className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
      <DirBrowser
        open={picking !== null}
        start={picking !== null && picking >= 0 && value[picking]?.trim() ? join(value[picking].trim()) : base}
        onOpenChange={(o) => !o && setPicking(null)}
        title={browseTitle}
        description={t('浏览本机目录，选中一个文件夹')}
        onPick={(p) => {
          const v = relTo(base, p)
          if (picking === -1) {
            if (!value.includes(v)) onChange([...value, v])
          } else if (picking !== null) put(picking, v)
          setPicking(null)
        }}
      />
    </div>
  )
}
