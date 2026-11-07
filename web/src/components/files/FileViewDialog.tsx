import { useEffect, useMemo, useRef, useState } from 'react'
import { Code2, Copy, GitCompareArrows, Loader2, FileText } from 'lucide-react'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import type { FileContent, FileDiff } from '@shared/files'
import { editorUrl } from '@/lib/editor-url'
import { fmtClock } from '@/lib/tasks'
import { highlightLines, sizeText, useHljs } from '@/lib/file-highlight'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { Lightbox } from '@/components/ui/lightbox'
import { DialogScroll, ProjectDiffDialog } from '@/components/tasks/DiffDialog'
import { Markdown } from '@/components/tasks/Markdown'
import { DocOutline } from '@/components/ui/doc-outline'
import { FileEditor, FileModeBar, isMarkdownPath, useFileEditing } from './file-edit'

/** 读回来的文件：dir 是「在编辑器中打开」用的目录；editable 为 false 时只读（附件、项目外的文件） */
export type FileView = FileContent & { dir?: string; editable?: boolean }

/**
 * 文件从哪里读、往哪里写：对话里点开的文件走任务目录（FileDialog），文件浏览页走项目目录（ProjectFileDialog），
 * 弹窗本身（阅读 / 编辑、高亮、行号、查看改动、保存冲突）是同一个。
 */
export interface FileSource {
  read: (path: string) => Promise<FileView>
  /** 保存；mtime 是打开时读到的修改时间，盘上的对不上时后端回 409。不传这项就只读 */
  write?: (path: string, content: string, mtime?: string) => Promise<unknown>
  /** 和 git 比的改动；不传就没有「查看改动」 */
  diff?: (path: string) => Promise<FileDiff>
  /** 图片：给看图浮层的原图地址；空串表示不是图片，按文字读 */
  image: (path: string) => string
  /** 「在编辑器中打开」的目录；不传时用读回来的 dir */
  dir?: string
  /** 找不到、二进制时的说明 */
  missingText: string
  binaryText: string
  /** 标题栏额外的按钮（附件的「用默认程序打开」这类） */
  actions?: (file: FileView) => React.ReactNode
  /** 能不能在编辑器里打开（本机二进制附件没必要） */
  editorOk?: (file: FileView) => boolean
  /** 保存成功后通知外面（文件树刷新大小、改动标记） */
  onSaved?: () => void
}

/** 文件里渲染 Markdown 时没有 @角色 */
const NO_TEAM = new Set<string>()

/**
 * 点开一个文件：显示内容（带语法高亮和行号），跳到指定的行；能切到编辑直接改完保存，
 * Markdown 阅读时按对话里的样式渲染、编辑时改源码；能看这个文件相对 git 改了什么、在编辑器里打开。图片用看图的浮层看原图。
 */
export function FileViewDialog({
  source,
  target,
  onOpenChange,
}: {
  source: FileSource
  target: { path: string; line?: number } | null
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = useState<FileView | null>(null)
  const [error, setError] = useState('')
  const [askClose, setAskClose] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffData, setDiffData] = useState<FileDiff | null>(null)
  const [diffError, setDiffError] = useState('')
  const hl = useHljs()
  const box = useRef<HTMLDivElement>(null)
  const path = target?.path ?? ''
  const raw = target ? source.image(target.path) : ''
  const isMd = isMarkdownPath(path)
  const load = (p: string) =>
    source
      .read(p)
      .then(setFile)
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    if (!target) return
    setFile(null)
    setError('')
    if (raw) return
    void load(target.path)
    // source 每次渲染都是新对象，换了文件（target）才重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [target, raw])
  // 内容出来后滚到提到的那一行
  useEffect(() => {
    if (!file || !target?.line) return
    box.current?.querySelector(`[data-line="${target.line}"]`)?.scrollIntoView({ block: 'center' })
  }, [file, target])

  const write = source.write
  // 截断的文件不提供编辑：存回去会把后面没读到的部分删掉；附件、项目外的文件只读
  const canEdit = !!write && !!file?.exists && !file.binary && !file.truncated && file.editable !== false
  const ed = useFileEditing({
    content: file?.exists && !file.binary ? file.content : undefined,
    write: async (text, force) => {
      await write!(file!.path, text, force ? undefined : file!.mtime)
      // 保存后重新读一遍：后端可能调整了换行，界面上显示的应该是盘上的真实内容（修改时间也更新，下次保存才不会误报冲突）
      setFile(await source.read(file!.path))
      source.onSaved?.()
    },
    reload: () => target && void load(target.path),
    resetKey: target,
    // Markdown 阅读是渲染后的文档，对不上行号：带行号打开（从引用跳过来）时直接进编辑看那一行
    startEdit: isMd && !!target?.line,
  })
  const editing = canEdit && ed.mode === 'edit'
  // 去掉结尾的换行再分列，最后一行不会是个空行；高亮用同一份内容，行数才对得上。
  // 阅读时看的是草稿：改了 Markdown 切回阅读就能看渲染效果
  const shown = canEdit ? ed.text : (file?.content ?? '')
  const body = shown ? shown.replace(/\n$/, '') : ''
  const lines = body ? body.split('\n') : []
  const highlighted = useMemo(
    () =>
      // 截断的文件、二进制都不用高亮：不是完整内容，或者根本不是代码
      file?.exists && !file.binary && !file.truncated ? highlightLines(hl, body, path) : null,
    [hl, body, path, file?.exists, file?.binary, file?.truncated],
  )
  const size = typeof file?.size === 'number' ? sizeText(file.size) : ''
  const mtime = file?.mtime ? fmtClock(file.mtime) : ''
  const canDiff = !!source.diff && !!file?.exists && !file.binary && file.editable !== false
  const editorDir = source.dir || file?.dir || ''
  const textOpen = !!target && !raw
  const mdPreview = isMd && !!file?.exists && !file.binary

  // 草稿不用在这里清：下次打开换了 target，编辑状态整个重置
  const close = () => {
    setDiffOpen(false)
    onOpenChange(false)
  }
  // 有没保存的修改时先问一句，别手滑关掉就丢了
  const change = (open: boolean) => {
    if (open) return
    if (ed.dirty) return setAskClose(true)
    close()
  }
  const openDiff = () => {
    if (!target || !source.diff) return
    setDiffOpen(true)
    setDiffData(null)
    setDiffError('')
    source
      .diff(file?.path || target.path)
      .then(setDiffData)
      .catch((e) => setDiffError((e as Error).message))
  }

  return (
    <>
      <Lightbox
        images={raw ? [{ src: raw, name: target!.path.split(/[\\/]/).pop()! }] : []}
        index={raw ? 0 : undefined}
        onClose={() => onOpenChange(false)}
      />
      <Modal
        open={textOpen}
        onOpenChange={change}
        title={null}
        bare
        closeOnOutside
        className={cn(
          // 只有一句说明（找不到、二进制、出错）时弹窗按内容高度，不撑满
          editing || !file || lines.length ? 'h-[min(760px,calc(100dvh-3.75rem))] max-w-[1000px]' : 'max-w-[560px]',
        )}
      >
        <ModalHeader
          icon={FileText}
          title={
            <>
              {file?.path || target?.path}
              {target?.line ? <span className="text-subtle">:{target.line}</span> : null}
            </>
          }
          titleClass="font-mono"
          titleAttr={target?.path}
          meta={ed.dirty ? <span className="text-warning">{t('未保存')}</span> : undefined}
          aside={
            <>
              {(size || mtime) && (
                <span className="hidden shrink-0 items-center gap-1.5 font-mono text-caption text-subtle sm:flex">
                  {size && <span title={t('文件大小')}>{size}</span>}
                  {size && mtime && <span aria-hidden>·</span>}
                  {mtime && <span title={t('最后修改')}>{mtime}</span>}
                </span>
              )}
              {canEdit && <FileModeBar ed={ed} />}
            </>
          }
          actions={
            <>
              <ModalButton
                icon={Copy}
                label={t('复制路径')}
                onClick={() => void copyText(file?.path || target?.path || '', { done: t('已复制'), fail: false })}
              />
              {canDiff && <ModalButton icon={GitCompareArrows} label={t('查看改动')} onClick={openDiff} />}
              {file && source.actions?.(file)}
              {file?.exists && editorDir && (source.editorOk?.(file) ?? true) && (
                <ModalButton
                  icon={Code2}
                  label={t('在编辑器中打开')}
                  onClick={() => window.open(editorUrl(editorDir, file.path, target?.line))}
                />
              )}
            </>
          }
        />
        {ed.saveError && (
          <p className="shrink-0 border-b bg-danger/10 px-4 py-2 text-body text-danger">{ed.saveError}</p>
        )}
        {/* Markdown 阅读时右边是标题目录，编辑源码时不要 */}
        <DialogScroll box={box} aside={mdPreview && !editing && <DocOutline scrollEl={box} className="bottom-7" />}>
          {error ? (
            <p className="p-6 text-body text-danger">{error}</p>
          ) : !file ? (
            <div className="flex h-full items-center justify-center text-subtle">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !file.exists ? (
            <p className="p-6 text-body text-subtle">{source.missingText}</p>
          ) : file.binary ? (
            <p className="p-6 text-body text-subtle">{source.binaryText}</p>
          ) : editing ? (
            <FileEditor ed={ed} line={target?.line} path={file.path} hl={hl} />
          ) : mdPreview ? (
            <div className="mx-auto max-w-[860px] px-8 py-6">
              <Markdown text={shown} teamNames={NO_TEAM} />
            </div>
          ) : (
            <pre className="min-w-max py-2 font-mono text-footnote leading-[1.6]">
              {lines.map((l, i) => (
                <div
                  key={i}
                  data-line={i + 1}
                  // 不画斑马纹：深色下底色和隔行浅底明暗差太大，看久了累眼（用户 2026-10-31 反馈）。
                  // 改成悬停那一行淡淡高亮帮着横向对行；跳到的那一行用强调色盖过悬停
                  className={cn('flex whitespace-pre', target?.line === i + 1 ? 'bg-accent/12' : 'hover:bg-fg/4')}
                >
                  <span className="w-14 shrink-0 pr-3 text-right text-subtle/55 select-none">{i + 1}</span>
                  {highlighted?.[i] !== undefined ? (
                    <span
                      className="pr-4"
                      // 高亮结果是 highlight.js 生成的，内容已经过它转义
                      dangerouslySetInnerHTML={{ __html: highlighted[i] || ' ' }}
                    />
                  ) : (
                    <span className="pr-4 text-fg/90">{l || ' '}</span>
                  )}
                </div>
              ))}
            </pre>
          )}
        </DialogScroll>
        {file?.truncated && (
          <p className="shrink-0 border-t px-4 py-2 text-xs text-subtle">
            {t('文件太大，只显示了前面一部分。完整内容请在编辑器里查看。')}
          </p>
        )}
      </Modal>
      <ProjectDiffDialog
        path={diffOpen ? (file?.path ?? target?.path ?? null) : null}
        data={diffData}
        error={diffError}
        onOpenChange={(o) => !o && setDiffOpen(false)}
      />
      <ConfirmDialog
        open={askClose}
        onOpenChange={setAskClose}
        title={t('还有没保存的修改，确定放弃？')}
        description={t('「{path}」这次改的内容不会保存。', { path: target?.path ?? '' })}
        confirmText={t('放弃')}
        onConfirm={() => {
          setAskClose(false)
          close()
        }}
      />
      <ConfirmDialog
        open={ed.conflict}
        onOpenChange={ed.setConflict}
        title={t('文件在你打开之后被改过了')}
        description={t(
          '可能是 Agent 刚改过「{path}」。覆盖保存会丢掉那些改动；也可以先放弃修改，看看现在的内容再改。',
          { path: file?.path ?? '' },
        )}
        confirmText={t('覆盖保存')}
        onConfirm={async () => {
          ed.setConflict(false)
          await ed.save(true)
        }}
      />
    </>
  )
}
