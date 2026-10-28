import { useEffect, useMemo, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Code2, Copy, GitCompareArrows, Loader2, PencilLine, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import type { FileContent, FileDiff } from '@shared/files'
import { api } from '@/lib/api'
import { editorUrl } from '@/lib/editor-url'
import { fmtClock } from '@/lib/tasks'
import { ensureHljs } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Lightbox } from '@/components/ui/lightbox'
import { DialogScroll, ProjectDiffDialog } from '@/components/tasks/DiffDialog'

/** 按扩展名先认出图片，直接看原图，不用等文本接口回来再切换 */
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

type Hljs = Awaited<ReturnType<typeof ensureHljs>>

/** 扩展名 → highlight.js 的语言名；common 包里只带了这些语言，没有的按纯文本显示 */
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
}

/**
 * 高亮后的 HTML 按行拆开：高亮结果里跨行的 <span> 在这一行结尾补上闭合、下一行开头重新打开，
 * 这样每一行仍是独立的元素，行号和 data-line 定位都还用得上，不会变成一整块。
 */
function splitHtmlLines(html: string) {
  const out: string[] = []
  const open: string[] = []
  let cur = ''
  let i = 0
  while (i < html.length) {
    if (html[i] === '\n') {
      out.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
      i++
    } else if (html[i] === '<') {
      const end = html.indexOf('>', i)
      const tag = html.slice(i, end < 0 ? html.length : end + 1)
      if (/^<span\b/.test(tag)) open.push(tag)
      else if (tag === '</span>') open.pop()
      cur += tag
      i = end < 0 ? html.length : end + 1
    } else {
      // 一整段文字一次拷过去，只有换行需要单独处理
      const next = html.indexOf('<', i)
      const stop = next < 0 ? html.length : next
      const nl = html.indexOf('\n', i)
      if (nl >= 0 && nl < stop) {
        cur += html.slice(i, nl)
        i = nl
      } else {
        cur += html.slice(i, stop)
        i = stop
      }
    }
  }
  out.push(cur)
  return out
}

/** 高亮每一行；语言认不出来时返回 null，调用方按纯文本显示 */
function highlightLines(hl: Hljs | null, code: string, path: string) {
  if (!hl || !code) return null
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const lang = LANG[ext]
  if (!lang || !hl.getLanguage(lang)) return null
  return splitHtmlLines(hl.highlight(code, { language: lang, ignoreIllegals: true }).value)
}

/** 文件大小：1 KB 以下给字节，再往上给 KB / MB，单位不用翻 */
function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 文件浏览页里点开一个文件：显示内容（带语法高亮），跳到指定的行，可以在编辑器里打开、
 * 直接改完保存，也能看这个文件相对 git 的改了什么。图片用看图的浮层看原图。
 */
export function ProjectFileDialog({
  projectId,
  dir,
  target,
  onOpenChange,
  onSaved,
}: {
  projectId: string
  /** 项目目录：拼「在编辑器中打开」的地址 */
  dir: string
  target: { path: string; line?: number } | null
  onOpenChange: (open: boolean) => void
  /** 保存成功后通知外面刷新文件树（大小、改动标记都会变） */
  onSaved?: () => void
}) {
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState('')
  /** 编辑中的内容；null 表示不在编辑 */
  const [draft, setDraft] = useState<string | null>(null)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [askClose, setAskClose] = useState(false)
  const [hl, setHl] = useState<Hljs | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffData, setDiffData] = useState<FileDiff | null>(null)
  const [diffError, setDiffError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const path = target?.path ?? ''
  const isImage = !!target && IMAGE.test(target.path)
  const raw = isImage ? api.projectFileRaw(projectId, target!.path) : ''
  useEffect(() => {
    if (!target) return
    setFile(null)
    setError('')
    setDraft(null)
    setSaveError('')
    if (raw) return
    api
      .projectFile(projectId, target.path)
      .then(setFile)
      .catch((e) => setError((e as Error).message))
  }, [projectId, target, raw])
  // 高亮库体积不小，和对话里的代码块一样按需加载；加载完这次渲染就有颜色了
  useEffect(() => {
    let alive = true
    void ensureHljs().then((h) => alive && setHl(h))
    return () => {
      alive = false
    }
  }, [])
  // 内容出来后滚到提到的那一行
  useEffect(() => {
    if (!file || !target?.line) return
    box.current?.querySelector(`[data-line="${target.line}"]`)?.scrollIntoView({ block: 'center' })
  }, [file, target])

  // 去掉结尾的换行再分列，最后一行不会是个空行；高亮用同一份内容，行数才对得上
  const body = file?.content ? file.content.replace(/\n$/, '') : ''
  const lines = body ? body.split('\n') : []
  const highlighted = useMemo(
    () =>
      // 截断的文件、二进制和图片都不用高亮：不是完整内容，或者根本不是代码
      file?.exists && !file.binary && !file.truncated && !isImage ? highlightLines(hl, body, path) : null,
    [hl, body, path, file?.exists, file?.binary, file?.truncated, isImage],
  )
  const size = typeof file?.size === 'number' ? sizeText(file.size) : ''
  const mtime = file?.mtime ? fmtClock(file.mtime) : ''
  const editing = draft !== null
  const dirty = editing && !!file && draft !== file.content
  // 截断的文件不提供编辑：存回去会把后面没读到的部分删掉
  const canEdit = !!file?.exists && !file.binary && !file.truncated
  const canDiff = !!file?.exists && !file.binary && !isImage
  const textOpen = !!target && !raw

  const close = () => {
    setDraft(null)
    setSaveError('')
    setDiffOpen(false)
    onOpenChange(false)
  }
  // 有没保存的修改时先问一句，别手滑关掉就丢了
  const change = (open: boolean) => {
    if (open) return
    if (dirty) return setAskClose(true)
    close()
  }
  const save = async () => {
    if (!file || draft === null || saving) return
    setSaving(true)
    setSaveError('')
    try {
      await api.writeProjectFile(projectId, file.path, draft)
      // 保存后重新读一遍：后端可能调整了换行或截断，界面上显示的应该是盘上的真实内容
      const fresh = await api.projectFile(projectId, file.path)
      setFile(fresh)
      setDraft(null)
      onSaved?.()
      toast.success(t('已保存'))
    } catch (e) {
      // 覆盖、越界、太大这类错误由后端给原因，原文显示
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const openDiff = () => {
    if (!target) return
    setDiffOpen(true)
    setDiffData(null)
    setDiffError('')
    api
      .projectFileDiff(projectId, target.path)
      .then(setDiffData)
      .catch((e) => setDiffError((e as Error).message))
  }

  return (
    <>
      <Lightbox
        images={raw ? [{ src: raw, name: target!.path.split('/').pop()! }] : []}
        index={raw ? 0 : undefined}
        onClose={() => onOpenChange(false)}
      />
      <D.Root open={textOpen} onOpenChange={change}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
          <D.Content
            aria-describedby={undefined}
            onKeyDown={(e) => {
              // 编辑时随时能按 Ctrl/Cmd+S 保存，不用点按钮
              if (editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                void save()
              }
            }}
            className={cn(
              'fixed top-1/2 left-1/2 z-50 flex w-[min(1000px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none',
              // 只有一句说明（找不到、二进制、出错）时弹窗按内容高度，不撑满
              editing || !file || lines.length ? 'h-[min(760px,calc(100dvh-2rem))]' : 'max-w-[560px]',
            )}
          >
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <D.Title className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={target?.path}>
                {file?.path || target?.path}
                {target?.line ? <span className="text-subtle">:{target.line}</span> : null}
                {dirty && <span className="ml-2 text-[0.75rem] font-normal text-warning">{t('未保存')}</span>}
              </D.Title>
              {(size || mtime) && (
                <span className="hidden shrink-0 items-center gap-1.5 font-mono text-[0.6875rem] text-subtle sm:flex">
                  {size && <span title={t('文件大小')}>{size}</span>}
                  {size && mtime && <span aria-hidden>·</span>}
                  {mtime && <span title={t('最后修改')}>{mtime}</span>}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('复制路径')}
                title={t('复制路径')}
                onClick={() => void copyText(file?.path || target?.path || '', { done: t('已复制'), fail: false })}
              >
                <Copy className="h-4 w-4" />
              </Button>
              {canDiff && !editing && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('查看改动')}
                  title={t('查看改动')}
                  onClick={openDiff}
                >
                  <GitCompareArrows className="h-4 w-4" />
                </Button>
              )}
              {canEdit && !editing && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('编辑')}
                  title={t('编辑')}
                  onClick={() => {
                    setDraft(file!.content)
                    setSaveError('')
                  }}
                >
                  <PencilLine className="h-4 w-4" />
                </Button>
              )}
              {editing ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                    {t('取消')}
                  </Button>
                  <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
                    {saving ? t('保存中') : t('保存')}
                  </Button>
                </>
              ) : (
                file?.exists &&
                dir && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(editorUrl(dir, file.path, target?.line))}
                  >
                    <Code2 className="h-4 w-4" />
                    {t('在编辑器中打开')}
                  </Button>
                )
              )}
              <D.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('关闭')} title={t('关闭')}>
                  <X className="h-4 w-4" />
                </Button>
              </D.Close>
            </header>
            {saveError && (
              <p className="shrink-0 border-b bg-danger/10 px-4 py-2 text-[0.8125rem] text-danger">{saveError}</p>
            )}
            <DialogScroll box={box}>
              {error ? (
                <p className="p-6 text-[0.8125rem] text-danger">{error}</p>
              ) : !file ? (
                <div className="flex h-full items-center justify-center text-subtle">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : !file.exists ? (
                <p className="p-6 text-[0.8125rem] text-subtle">
                  {t('项目目录里找不到这个文件，可能已经被移动或删除。')}
                </p>
              ) : file.binary ? (
                <p className="p-6 text-[0.8125rem] text-subtle">{t('这是二进制文件，不显示内容。')}</p>
              ) : editing ? (
                // 编辑时不带行号：行号会随输入变，写起来反而碍眼
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label={t('文件内容')}
                  spellCheck={false}
                  className="h-full w-full resize-none bg-transparent px-4 py-2 font-mono text-[0.78125rem] leading-[1.6] text-fg/90 outline-none"
                />
              ) : (
                <pre className="min-w-max py-2 font-mono text-[0.78125rem] leading-[1.6]">
                  {lines.map((l, i) => (
                    <div
                      key={i}
                      data-line={i + 1}
                      // 奇偶行隔一层浅底（照设计稿），长文件横着看不串行；跳到的那一行高亮盖过它
                      className={cn(
                        'flex whitespace-pre',
                        target?.line === i + 1 ? 'bg-accent/12' : i % 2 === 1 && 'bg-sel/35',
                      )}
                    >
                      <span className="w-14 shrink-0 pr-3 text-right text-subtle/70 select-none">{i + 1}</span>
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
          </D.Content>
        </D.Portal>
      </D.Root>
      <ProjectDiffDialog
        path={diffOpen ? (target?.path ?? null) : null}
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
        onConfirm={close}
      />
    </>
  )
}
