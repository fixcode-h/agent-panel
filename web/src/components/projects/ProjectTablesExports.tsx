import { useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { EXPORT_VARS, exportLines, type ExportVar, type TableExport } from '@shared/table-export'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input, Textarea } from '@/components/ui/input'

/** 每个占位的说明（取值函数：t() 跟着当前语言） */
const VAR_TIP: Record<ExportVar, () => string> = {
  file: () => t('表格的完整路径'),
  files: () => t('选中的所有表格，空格分隔；写了它就只执行一次'),
  rel: () => t('表格在表格页里的路径'),
  name: () => t('文件名，不带扩展名'),
  folder: () => t('表格所在的文件夹'),
  project: () => t('项目目录'),
}

const BLANK: TableExport = { name: '', command: '', cwd: '', timeoutMin: 30 }

/**
 * 项目设置 → 表格的「导表脚本」：一项一个命令，路径用 {file} 这类占位，表格页执行时才换成真实路径。
 * 下面实时给出拿一张示例表替换后的样子，写错占位一眼能看出来
 */
export function ProjectTablesExports({
  value,
  onChange,
  sample,
  base,
}: {
  value: TableExport[]
  onChange: (v: TableExport[]) => void
  /** 示例用的表格路径（项目里找到的第一张） */
  sample: string
  base: string
}) {
  const set = (i: number, p: Partial<TableExport>) => onChange(value.map((x, j) => (j === i ? { ...x, ...p } : x)))
  return (
    <div className="flex flex-col gap-3">
      {value.map((x, i) => (
        <ExportItem
          key={i}
          item={x}
          onChange={(p) => set(i, p)}
          onRemove={() => onChange(value.filter((_, j) => j !== i))}
          sample={sample}
          base={base}
        />
      ))}
      <div>
        <Button size="sm" variant="secondary" onClick={() => onChange([...value, BLANK])} disabled={value.length >= 20}>
          <Plus className="h-3.5 w-3.5" />
          {t('添加导表脚本')}
        </Button>
      </div>
    </div>
  )
}

function ExportItem({
  item,
  onChange,
  onRemove,
  sample,
  base,
}: {
  item: TableExport
  onChange: (p: Partial<TableExport>) => void
  onRemove: () => void
  sample: string
  base: string
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  // 点占位：插到光标处，插完光标停在占位后面
  const insert = (v: ExportVar) => {
    const el = box.current
    const tok = `{${v}}`
    const at = el ? el.selectionStart : item.command.length
    const end = el ? el.selectionEnd : at
    const next = item.command.slice(0, at) + tok + item.command.slice(end)
    onChange({ command: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + tok.length, at + tok.length)
    })
  }
  const full = sample.startsWith('/') || /^[a-zA-Z]:/.test(sample) ? sample : `${base}/${sample}`
  const preview = item.command.trim() ? exportLines(item.command, [{ file: full, rel: sample }], base, 'sh')[0] : ''
  return (
    <div className="flex flex-col gap-3 rounded-(--c-row-radius) border p-3">
      <div className="flex items-end gap-2">
        <Field label={t('名字')} className="flex-1">
          <Input
            value={item.name}
            placeholder={t('比如：导出 JSON')}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </Field>
        <IconButton icon={Trash2} label={t('删除这个导表脚本')} onClick={onRemove} />
      </div>
      <Field label={t('命令')} tip={t('用设置里选的命令行环境执行。占位在执行时换成真实路径，自动加引号。')}>
        <Textarea
          ref={box}
          rows={2}
          value={item.command}
          placeholder="python tools/export.py {file} -o {project}/out"
          onChange={(e) => onChange({ command: e.target.value })}
          className="font-mono text-footnote"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5 text-caption text-subtle">
        {t('插入占位：')}
        {EXPORT_VARS.map((v) => (
          <Button
            key={v}
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 font-mono"
            title={VAR_TIP[v]()}
            onClick={() => insert(v)}
          >
            {`{${v}}`}
          </Button>
        ))}
      </div>
      {preview && (
        <p className="rounded-(--c-row-radius) bg-(--code-bg) px-2.5 py-1.5 font-mono text-caption break-all text-muted">
          <span className="mr-1.5 font-sans text-subtle">{t('执行时：')}</span>
          {preview}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-[1fr_9rem]">
        <Field label={t('执行目录')} tip={t('相对项目目录或绝对路径，空着就是项目目录')}>
          <Input
            value={item.cwd}
            placeholder={t('项目目录')}
            onChange={(e) => onChange({ cwd: e.target.value })}
            className="font-mono text-footnote"
          />
        </Field>
        <Field label={t('最长（分钟）')} tip={t('超过这么久还没跑完就停掉')}>
          <Input
            type="number"
            min={1}
            max={240}
            value={item.timeoutMin}
            onChange={(e) =>
              onChange({ timeoutMin: Math.min(240, Math.max(1, Math.round(Number(e.target.value) || 30))) })
            }
          />
        </Field>
      </div>
    </div>
  )
}
