import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableDoc, TableSchema } from '@shared/tables'
import { headerOf } from '@shared/table-struct'
import { fieldNames } from '@shared/table-agent'
import type { Problem } from '@shared/table-struct'
import { applyRowOps, setCells } from '@shared/table-edit'
import { addRowsPrompt, explainColumnPrompt, explainTablePrompt, fixProblemsPrompt } from '@shared/table-ai'
import { createAnalysisTask, openAiWindow } from '@/lib/ai-window'
import { tablesApi, type TableProposal } from '@/lib/tables-api'
import { useSheetDiff } from '@/lib/sheet-diff-async'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { DiffSummary, SheetDiffView } from './SheetDiffView'

/** 在项目里开一个对话做这件事，过程在 AI 窗口里看；结束后 onDone（取 AI 提的改动） */
function startAi(projectId: string, title: string, prompt: string, onDone?: () => void) {
  openAiWindow({
    label: t('AI'),
    title,
    create: () => createAnalysisTask({ scope: { kind: 'project', projectId }, kind: 'run', title, prompt }),
    onDone: () => onDone?.(),
  })
}

/** 让 AI 修一组不合规（检查结果里按组修）：结束后 onDone 去取提的改动 */
export function aiFixProblems(
  projectId: string,
  doc: TableDoc,
  sheet: string,
  problems: (Problem & { field: string })[],
  onDone: () => void,
) {
  const name = doc.path.replace(/^.*\//, '')
  startAi(projectId, t('AI 修 {file} 的不合规', { file: name }), fixProblemsPrompt(doc.path, sheet, problems), onDone)
}

/** 这张表上 AI 提的改动：打开时取一次，AI 对话结束后再取 */
export function useProposal(projectId: string, doc: TableDoc) {
  const [p, setP] = useState<TableProposal | null>(null)
  const refresh = useCallback(() => {
    tablesApi
      .proposal(projectId, doc.path)
      .then((r) => setP(r.proposal))
      .catch(() => setP(null))
  }, [projectId, doc.path])
  useEffect(refresh, [refresh])
  return [p, setP, refresh] as const
}

/** 工具栏的「AI」：照着描述加行、解释一列 / 这张表、修这张表的不合规 */
export function AiMenu({
  projectId,
  doc,
  sheet,
  field,
  problems,
  readOnly,
  onProposal,
}: {
  projectId: string
  doc: TableDoc
  sheet: string
  /** 选中格子那一列的字段名 */
  field: string
  problems: (Problem & { field: string })[]
  readOnly: boolean
  /** AI 对话结束：去取提的改动 */
  onProposal: () => void
}) {
  const [adding, setAdding] = useState(false)
  const name = doc.path.replace(/^.*\//, '')
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" className="sheet-tool h-7" title={t('AI')}>
            <Sparkles className="h-3.5 w-3.5" />
            {t('AI')}
          </Button>
        </MenuTrigger>
        <MenuContent className="max-w-[320px]">
          {!readOnly && <MenuItem onSelect={() => setAdding(true)}>{t('照着描述加几行…')}</MenuItem>}
          {!readOnly && (
            <MenuItem
              disabled={!problems.length}
              onSelect={() =>
                startAi(
                  projectId,
                  t('AI 修 {file} 的不合规', { file: name }),
                  fixProblemsPrompt(doc.path, sheet, problems),
                  onProposal,
                )
              }
            >
              {problems.length ? t('让 AI 修这 {n} 处不合规', { n: problems.length }) : t('没有不合规的格子')}
            </MenuItem>
          )}
          {!readOnly && <MenuSeparator />}
          <MenuItem
            disabled={!field}
            onSelect={() =>
              startAi(projectId, t('AI 解释 {field}', { field }), explainColumnPrompt(doc.path, sheet, field))
            }
          >
            {field ? t('解释「{field}」这一列', { field }) : t('解释一列（先选中那一列的格子）')}
          </MenuItem>
          <MenuItem
            onSelect={() =>
              startAi(projectId, t('AI 解释 {file}', { file: name }), explainTablePrompt(doc.path, sheet))
            }
          >
            {t('解释这张表')}
          </MenuItem>
        </MenuContent>
      </Menu>
      {adding && (
        <AddRowsDialog
          onClose={() => setAdding(false)}
          onStart={(count, desc) => {
            setAdding(false)
            startAi(
              projectId,
              t('AI 给 {file} 加 {n} 行', { file: name, n: count }),
              addRowsPrompt(doc.path, sheet, count, desc),
              onProposal,
            )
          }}
        />
      )}
    </>
  )
}

function AddRowsDialog({ onStart, onClose }: { onStart: (n: number, desc: string) => void; onClose: () => void }) {
  const [n, setN] = useState(5)
  const [desc, setDesc] = useState('')
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('照着描述加几行')}
      footer={
        <>
          <span className="mr-auto" />
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button disabled={!desc.trim()} onClick={() => onStart(n, desc)}>
            <Sparkles className="h-3.5 w-3.5" />
            {t('让 AI 写')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('加几行')}>
          <Input
            type="number"
            min={1}
            max={500}
            value={n}
            onChange={(e) => setN(Math.min(500, Math.max(1, Math.round(Number(e.target.value) || 1))))}
            className="w-28"
          />
        </Field>
        <Field
          label={t('要什么样的行')}
          tip={t('AI 会先读这张表和相关的表，照已有数据的写法来；写完先给你看差异，确认后才放进表格')}
        >
          <Textarea
            autoFocus
            rows={4}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={t('比如：5 个蓝色品质的镜子类软装，尺寸从 S 到 L，交互白名单和 1003 一样')}
          />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * AI 提了改动时表格上方的提示：看差异，「放进表格」变成一次改动（还没保存），或者丢掉。
 * 提出之后文件改过、或页面上有没保存的改动时不能直接放（行号对不上）
 */
export function ProposalBar({
  projectId,
  doc,
  proposal,
  schema,
  dirty,
  onApply,
  onDrop,
}: {
  projectId: string
  doc: TableDoc
  proposal: TableProposal | null
  schema: TableSchema
  dirty: boolean
  onApply: (sheet: string, rows: string[][], ops: TableProposal['edit']['rows']) => void
  onDrop: () => void
}) {
  const [open, setOpen] = useState(false)
  if (!proposal) return null
  const stale = proposal.mtime !== doc.mtime
  const drop = () => {
    void tablesApi.dropProposal(projectId, doc.path, proposal.id).catch(() => {})
    onDrop()
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-accent/6 px-3 py-1.5 text-footnote">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-text" />
      <span className="mr-auto min-w-0 truncate" title={proposal.note}>
        {t('AI 提的改动：改 {c} 格、加 {a} 行、删 {d} 行', {
          c: proposal.cells,
          a: proposal.added,
          d: proposal.removed,
        })}
        {proposal.note && <span className="ml-2 text-subtle">{proposal.note}</span>}
      </span>
      {stale && <span className="text-warning">{t('提出之后文件改过了，让 AI 重新提一次')}</span>}
      <Button size="sm" variant="secondary" className="h-6" disabled={stale} onClick={() => setOpen(true)}>
        {t('看差异')}
      </Button>
      <Button size="sm" variant="ghost" className="h-6" onClick={drop}>
        {t('丢掉')}
      </Button>
      {open && (
        <ProposalDialog
          doc={doc}
          proposal={proposal}
          schema={schema}
          dirty={dirty}
          onClose={() => setOpen(false)}
          onApply={(rows) => {
            onApply(proposal.sheet, rows, proposal.edit.rows)
            drop()
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

function ProposalDialog({
  doc,
  proposal,
  schema,
  dirty,
  onApply,
  onClose,
}: {
  doc: TableDoc
  proposal: TableProposal
  schema: TableSchema
  dirty: boolean
  onApply: (rows: string[][]) => void
  onClose: () => void
}) {
  const sheet = doc.sheets.find((s) => s.name === proposal.sheet)
  const after = useMemo(
    () => (sheet ? setCells(applyRowOps(sheet.rows, proposal.edit.rows), proposal.edit.cells) : null),
    [sheet, proposal],
  )
  // 差异按这张表的表头（结构文件 / 自动识别）和主键对齐
  const sides = useMemo(() => {
    if (!sheet || !after) return null
    const h = headerOf(schema, doc.path, sheet)
    const from = h.start + h.roles.length
    const names = fieldNames(sheet.rows, h)
    return { a: { rows: sheet.rows, from, names }, b: { rows: after, from, names } }
  }, [sheet, after, schema, doc.path])
  const { diff, error } = useSheetDiff(sides, schema.style.key)
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('AI 提的改动')}
      size="lg"
      footer={
        <>
          {diff && <DiffSummary diff={diff} />}
          <span className="mr-auto" />
          {dirty && <span className="text-footnote text-warning">{t('先保存或撤掉页面上的改动')}</span>}
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button disabled={!after || dirty} onClick={() => after && onApply(after)}>
            {t('放进表格')}
          </Button>
        </>
      }
    >
      {!sheet ? (
        <p className="text-body text-danger">{t('这个文件里已经没有工作表「{sheet}」', { sheet: proposal.sheet })}</p>
      ) : error ? (
        <p className="text-body text-danger">{error}</p>
      ) : diff && sides ? (
        <div className="flex h-[420px] min-h-0 flex-col">
          <SheetDiffView a={sides.a.rows} b={sides.b.rows} diff={diff} names={sides.b.names} onlyChanges />
        </div>
      ) : null}
    </Modal>
  )
}
