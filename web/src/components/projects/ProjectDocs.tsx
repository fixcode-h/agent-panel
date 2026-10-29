import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { AlertTriangle, Check, Eye, Loader2, PenLine, Sparkles, Square, X } from 'lucide-react'
import type { DocFile, DocJob, ProjectDoc } from '@shared/docs'
import { CLIS } from '@shared/clis'
import { defaultCli, orderClis } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Markdown } from '@/components/tasks/Markdown'
import { ScopeRequests } from '@/components/chat/AskToggle'
import { t } from '@shared/i18n'

const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)
const NO_TEAM = new Set<string>()

/**
 * 一页说明文件：同一个 CLI 可能读好几个文件，用标签切换；可以手动编辑、预览，也可以让 AI 优化。
 * 改动先留在弹窗里，点「确认」时和项目设置一起保存
 */
export function DocPage({
  projectId,
  title,
  desc,
  files,
  docs,
  drafts,
  onDraft,
  note,
  extra,
}: {
  projectId: string
  title: string
  desc: string
  files: DocFile[]
  docs: ProjectDoc[]
  drafts: Partial<Record<DocFile, string>>
  onDraft: (path: DocFile, content: string) => void
  /** 页面顶部的提示（例如检测到 AGENT.md） */
  note?: React.ReactNode
  /** 编辑框下面的其他内容（例如这个 CLI 的 Skill） */
  extra?: React.ReactNode
}) {
  const docOf = (f: DocFile) => docs.find((d) => d.path === f)
  // 默认打开已经存在的第一个文件，都没有就是第一个（保存时新建）
  const [active, setActive] = useState<DocFile>(() => files.find((f) => docOf(f)?.exists) ?? files[0])
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [optimizing, setOptimizing] = useState(false)
  const doc = docOf(active)
  const value = drafts[active] ?? doc?.content ?? ''
  const dirty = drafts[active] !== undefined && drafts[active] !== (doc?.content ?? '')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-subtle">{desc}</p>
      </div>
      {note}

      {files.length > 1 && (
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {files.map((f) => {
            const d = docOf(f)
            const changed = drafts[f] !== undefined && drafts[f] !== (d?.content ?? '')
            return (
              <button
                key={f}
                role="tab"
                aria-selected={f === active}
                onClick={() => setActive(f)}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[0.75rem] transition-colors',
                  f === active ? 'border-accent bg-accent-soft text-fg' : 'text-muted hover:bg-sel hover:text-fg',
                )}
              >
                {f}
                {!d?.exists && !changed && (
                  <span className="font-sans text-[0.6875rem] text-subtle">{t('未创建')}</span>
                )}
                {changed && <span className="h-1.5 w-1.5 rounded-full bg-accent" title={t('有未保存的改动')} />}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-xl bg-sel/40">
        <div className="flex flex-wrap items-center gap-2 border-b bg-panel/60 px-3 py-2">
          <span className="font-mono text-[0.75rem]">{active}</span>
          <span className="text-xs text-subtle">
            {doc?.tooLarge
              ? t('文件太大（{size}），不在这里编辑', { size: size(doc.bytes) })
              : dirty
                ? t('已修改，确认后保存')
                : doc?.exists
                  ? size(doc.bytes)
                  : t('还没有这个文件，写好后确认就会创建')}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex rounded-lg border p-0.5">
              {(
                [
                  ['edit', PenLine, t('编辑')],
                  ['preview', Eye, t('预览')],
                ] as const
              ).map(([m, Icon, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={cn(
                    'flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs',
                    mode === m ? 'bg-sel text-fg' : 'text-subtle hover:text-fg',
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
            <Button size="sm" variant="secondary" disabled={!!doc?.tooLarge} onClick={() => setOptimizing(true)}>
              <Sparkles className="h-3.5 w-3.5 text-accent-text" />
              {t('AI 优化')}
            </Button>
          </div>
        </div>

        {optimizing && (
          <Optimizer
            key={active}
            title={t('用 AI 优化 {file}', { file: active })}
            start={(request, cli) =>
              api.optimizeDoc(projectId, { path: active, content: value, request, cli, model: '', effort: '' })
            }
            onClose={() => setOptimizing(false)}
            onApply={(c) => {
              onDraft(active, c)
              setOptimizing(false)
              toast.success(t('已替换为优化后的内容，确认后保存'))
            }}
          />
        )}

        {mode === 'edit' ? (
          <Textarea
            value={value}
            disabled={!!doc?.tooLarge}
            onChange={(e) => onDraft(active, e.target.value)}
            spellCheck={false}
            aria-label={active}
            placeholder={t('# 项目约定\n\n写给编码助手看的项目说明：常用命令、目录结构、代码风格、注意事项…')}
            className="min-h-[280px] flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[0.8125rem] leading-[1.65] focus:ring-0"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {value.trim() ? (
              <Markdown text={value} teamNames={NO_TEAM} />
            ) : (
              <p className="text-[0.8125rem] text-subtle">{t('还没有内容')}</p>
            )}
          </div>
        )}
      </div>
      {extra}
    </div>
  )
}

/**
 * AI 优化：用本机 CLI 只读运行，给出完整的新内容，看过再决定用不用。
 * 项目说明在项目目录里跑（核对代码），设置「部署」里的全局说明在用户目录里跑
 */
export function Optimizer({
  title,
  hint = t(
    'Agent 会在项目目录里只读运行：看一下代码、命令和目录，核对并补全说明，不会改项目里的文件。结果先给你看，采用后再确认保存。',
  ),
  placeholder = t('想怎么改（可以不填），例如：补上测试命令，写得更简洁'),
  busyText = t('正在看项目…'),
  start: begin,
  onClose,
  onApply,
}: {
  title: string
  hint?: string
  placeholder?: string
  busyText?: string
  start: (request: string, cli: string) => Promise<DocJob>
  onClose: () => void
  onApply: (content: string) => void
}) {
  const { clis, settings } = useData()
  const usable = useMemo(
    () =>
      orderClis(CLIS, settings?.cliOrder ?? []).filter((c) =>
        clis.some((s) => s.id === c.id && s.installed && s.enabled),
      ),
    [clis, settings],
  )
  const pref = settings?.assist.cli || (settings ? defaultCli(settings) : '')
  const [cli, setCli] = useState(() => usable.find((c) => c.id === pref)?.id ?? usable[0]?.id ?? '')
  const [request, setRequest] = useState('')
  const [job, setJob] = useState<DocJob | null>(null)
  const [now, setNow] = useState(Date.now())
  const jobRef = useRef(job)
  jobRef.current = job

  // 生成中轮询；关掉面板时停掉还在跑的 CLI
  useEffect(() => {
    if (job?.status !== 'running') return
    const timer = setTimeout(async () => {
      try {
        setJob(await api.docJob(job.id))
      } catch (e) {
        setJob({ ...job, status: 'failed', error: (e as Error).message })
      }
      setNow(Date.now())
    }, 700)
    return () => clearTimeout(timer)
  }, [job])
  useEffect(
    () => () => {
      const j = jobRef.current
      if (j?.status === 'running') void api.stopDocJob(j.id).catch(() => {})
    },
    [],
  )

  const start = async () => {
    try {
      setJob(await begin(request, cli))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const running = job?.status === 'running'
  const secs = job ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0
  const lastThought = job?.thinking?.trim().split('\n').filter(Boolean).at(-1)

  return (
    <div className="flex flex-col gap-3 border-b bg-accent-soft/40 px-4 py-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-text" />
        <span className="text-[0.8125rem] font-medium">{title}</span>
        <button
          onClick={onClose}
          aria-label={t('关闭')}
          title={running ? t('关闭并终止生成') : t('关闭')}
          className="ml-auto grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!job || job.status === 'failed' ? (
        <>
          <p className="text-xs leading-relaxed text-subtle">{hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && cli && void start()}
              placeholder={placeholder}
              className="h-9 min-w-[240px] flex-1"
            />
            {usable.length ? (
              <Select
                aria-label="Agent"
                value={cli}
                onChange={(e) => setCli(e.target.value)}
                className="h-9 w-[160px]"
                options={usable.map((c) => ({ value: c.id, label: c.name }))}
              />
            ) : (
              <span className="text-xs text-warning">{t('没有可用的 Agent，请先在设置里安装并启用')}</span>
            )}
            <Button size="sm" className="h-9" disabled={!cli} onClick={start}>
              {job ? t('重试') : t('开始优化')}
            </Button>
          </div>
          {job?.error && (
            <p className="flex gap-1.5 text-xs whitespace-pre-wrap text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {job.error}
            </p>
          )}
        </>
      ) : running ? (
        <>
          <ScopeRequests scope={`doc:${job.id}`} active className="mb-0 max-w-none" />
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-text" />
            <span className="min-w-0 flex-1 truncate">
              {lastThought
                ? t('正在思考：{text}', { text: lastThought })
                : job.tools?.length
                  ? t('正在查看：{files}', { files: job.tools.join('、') })
                  : busyText}
            </span>
            <span className="tabular-nums text-subtle">
              {secs}s{job.outChars ? ` · ${t('已输出 {n} 字', { n: job.outChars })}` : ''}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void api.stopDocJob(job.id).catch(() => {})}>
              <Square className="h-3 w-3" />
              {t('停止')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {job.text && <p className="text-[0.8125rem] leading-relaxed">{job.text}</p>}
          <pre className="max-h-72 overflow-auto rounded-lg border bg-[var(--code-bg)] px-3 py-2.5 font-mono text-[0.75rem] leading-[1.6] whitespace-pre-wrap">
            {job.result}
          </pre>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => onApply(job.result ?? '')}>
              <Check className="h-3.5 w-3.5" />
              {t('采用')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setJob(null)}>
              {t('重新生成')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('放弃')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
