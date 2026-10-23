import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Copy,
  Download,
  FileInput,
  Globe,
  Loader2,
  Lock,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react'
import {
  LOCAL_MODELS,
  WORKFLOW_USES,
  WORKFLOW_USE_LABEL,
  autoPlaceholders,
  checkWorkflow,
  localModel,
  type ComfyWorkflow,
} from '@shared/local-image'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ComfyWebDialog } from '@/components/design/ComfyWeb'
import { useLocalImage } from '@/components/settings/LocalImageSection'
import { ComfyGraphView } from '@/components/comfy/ComfyGraphView'

type Kind = 'game' | 'web'
type View = 'graph' | 'json'
const VIEW_KEY = 'agent-panel:comfy-view'
const loadView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'json' ? 'json' : 'graph'
  } catch {
    return 'graph'
  }
}
const newId = () => `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * ComfyUI 工作流管理：游戏和网页分开。内置的是调好的工作流（只读，可以复制后改）；
 * 自己的可以手动改、从 ComfyUI 导入、让 AI 生成或优化。UI 设计生成图片时选「本机」就会用到这里的工作流
 */
export function ComfyPage() {
  const { route, go, openSettings } = useNav()
  const kind: Kind = route.id === 'web' ? 'web' : 'game'
  const [data, setData] = useState<{ list: ComfyWorkflow[]; ready: string[] }>()
  const [sel, setSel] = useState(route.sub ?? '')
  const [draft, setDraft] = useState<ComfyWorkflow | null>(null)
  const [graphText, setGraphText] = useState('')
  const [note, setNote] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ask, setAsk] = useState<'create' | 'optimize' | null>(null)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [web, setWeb] = useState(false)
  const [st] = useLocalImage()
  const [view, setViewState] = useState<View>(loadView)
  const setView = (v: View) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // 存不了就只在这次有效
    }
  }

  const load = () =>
    api
      .comfyWorkflows()
      .then(setData)
      .catch((e) => toast.error((e as Error).message))
  useEffect(() => {
    void load()
  }, [])

  const mine = useMemo(() => data?.list.filter((w) => w.kind === kind) ?? [], [data, kind])
  const current = mine.find((w) => w.id === sel) ?? mine[0]
  // 换了选中的工作流：编辑区换成它（新建、AI 结果还没保存时保留草稿）
  useEffect(() => {
    if (!current || (draft && dirty)) return
    setDraft(current)
    setGraphText(JSON.stringify(current.graph, null, 2))
    setNote('')
    setDirty(false)
    // 只在选中的工作流变化时重置
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.updatedAt])

  const pick = (id: string) => {
    if (dirty && !confirm(t('还有没保存的修改，确定放弃？'))) return
    setDirty(false)
    setDraft(null)
    setSel(id)
    go({ page: 'comfy', id: kind, sub: id })
  }
  const openDraft = (w: ComfyWorkflow, why = '') => {
    setDraft(w)
    setGraphText(JSON.stringify(w.graph, null, 2))
    setNote(why)
    setDirty(true)
    setSel(w.id)
  }
  const edit = (patch: Partial<ComfyWorkflow>) => {
    if (!draft) return
    setDraft({ ...draft, ...patch })
    setDirty(true)
  }

  // 节点图的 JSON 改到一半可能不合法：合法时才检查
  const graph = useMemo(() => {
    try {
      return JSON.parse(graphText) as ComfyWorkflow['graph']
    } catch {
      return null
    }
  }, [graphText])
  const problems = graph ? checkWorkflow(graph) : [t('节点图不是合法的 JSON')]
  // 图上改了值，写回 JSON；保持引用不变，免得节点图每次渲染都重建
  const onGraph = useCallback((g: ComfyWorkflow['graph']) => {
    setGraphText(JSON.stringify(g, null, 2))
    setDirty(true)
  }, [])
  const readOnly = !!draft?.builtin
  const ready = (w: ComfyWorkflow) => data?.ready.includes(w.id)

  const save = async () => {
    if (!draft || !graph || problems.length) return
    setSaving(true)
    try {
      const saved = await api.saveComfyWorkflow({ ...draft, graph })
      toast.success(t('已保存'))
      setDirty(false)
      setNote('')
      await load()
      setSel(saved.id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const duplicate = () =>
    draft &&
    openDraft({
      ...draft,
      id: newId(),
      name: t('{name}（副本）', { name: draft.name }),
      builtin: undefined,
      graph: graph ?? draft.graph,
    })

  const exportJson = () => {
    if (!draft) return
    const blob = new Blob([JSON.stringify(graph ?? draft.graph, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${draft.name}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const running = !!st?.running
  const model = draft?.model ? localModel(draft.model) : undefined
  const builtins = mine.filter((w) => w.builtin)
  const own = mine.filter((w) => !w.builtin)
  const draftIsNew = draft && !data?.list.some((w) => w.id === draft.id)

  return (
    <main className="flex min-w-0 flex-1 flex-col lg:h-full lg:overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 md:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-[0.9375rem] font-semibold">{t('ComfyUI 工作流')}</h1>
          <p className="mt-0.5 text-[0.78125rem] text-subtle">
            {t('UI 设计里选「本机」生成图片时用这里的工作流；自动模式按图片用途（图标、按钮、面板、背景…）挑选。')}
          </p>
        </div>
        <Segmented
          label={t('工作流分类')}
          value={kind}
          onChange={(k) => {
            setDraft(null)
            setDirty(false)
            setSel('')
            go({ page: 'comfy', id: k })
          }}
          options={[
            { id: 'game', label: t('游戏 UI') },
            { id: 'web', label: t('网页 UI') },
          ]}
        />
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
            <FileInput className="h-3.5 w-3.5" />
            {t('导入')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAsk('create')}>
            <Sparkles className="h-3.5 w-3.5" />
            {t('AI 生成')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setWeb(true)} title={t('在面板里打开 ComfyUI 的网页')}>
            <Globe className="h-3.5 w-3.5" />
            {t('ComfyUI 网页')}
            <span className={cn('h-1.5 w-1.5 rounded-full', running ? 'bg-success' : 'bg-line-strong')} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('本机生图设置')}
            title={t('本机生图设置：安装、下载模型')}
            onClick={() => openSettings('local-image')}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[42vh] shrink-0 flex-col gap-3 overflow-y-auto border-b p-3 lg:max-h-none lg:w-[204px] lg:border-r lg:border-b-0 2xl:w-[248px]">
          {!data ? (
            <p className="p-3 text-[0.8125rem] text-subtle">{t('读取中…')}</p>
          ) : (
            <>
              {[
                { title: t('内置'), items: builtins },
                { title: t('我的'), items: own },
              ].map((g) => (
                <section key={g.title} className="flex flex-col gap-0.5">
                  <h2 className="px-2 pb-1 text-[0.71875rem] font-medium text-subtle">{g.title}</h2>
                  {!g.items.length && (
                    <p className="px-2 pb-1 text-[0.75rem] leading-relaxed text-subtle">
                      {t('还没有，可以导入或让 AI 生成')}
                    </p>
                  )}
                  {g.items.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => pick(w.id)}
                      aria-current={current?.id === w.id}
                      className={cn(
                        'flex cursor-pointer flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left',
                        draft?.id === w.id ? 'bg-sel' : 'hover:bg-sel/60',
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5 text-[0.8125rem] font-medium">
                        <span className="min-w-0 flex-1 truncate">{w.name}</span>
                        <span
                          title={ready(w) ? t('模型已下载，可以用') : t('模型还没下载')}
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            ready(w) ? 'bg-success' : 'bg-line-strong',
                          )}
                        />
                      </span>
                      <span className="text-[0.71875rem] text-subtle">
                        {WORKFLOW_USE_LABEL[w.use]}
                        {w.model ? ` · ${localModel(w.model)?.name ?? w.model}` : ''}
                      </span>
                    </button>
                  ))}
                </section>
              ))}
              {draftIsNew && (
                <section className="flex flex-col gap-0.5">
                  <h2 className="px-2 pb-1 text-[0.71875rem] font-medium text-subtle">{t('未保存')}</h2>
                  <div className="rounded-lg bg-sel px-2.5 py-2 text-[0.8125rem] font-medium">{draft.name}</div>
                </section>
              )}
            </>
          )}
        </aside>

        <section className="min-h-0 flex-1 overflow-y-auto">
          {!draft ? (
            <p className="p-8 text-center text-[0.8125rem] text-subtle">{t('选一个工作流查看和修改')}</p>
          ) : (
            <div className="flex flex-col gap-4 p-4 md:p-6">
              <div className="flex flex-wrap items-center gap-2">
                {readOnly && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-sel px-2 py-0.5 text-[0.75rem] text-muted">
                    <Lock className="h-3 w-3" />
                    {t('内置，只读')}
                  </span>
                )}
                {model && (
                  <span
                    className={cn(
                      'rounded-md px-2 py-0.5 text-[0.75rem]',
                      ready(draft) ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
                    )}
                  >
                    {ready(draft)
                      ? t('{name} 已下载', { name: model.name })
                      : t('需要先下载 {name}', { name: model.name })}
                  </span>
                )}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setAsk('optimize')}>
                  <Wand2 className="h-3.5 w-3.5" />
                  {t('AI 优化')}
                </Button>
                <Button size="sm" variant="ghost" onClick={exportJson}>
                  <Download className="h-3.5 w-3.5" />
                  {t('导出 JSON')}
                </Button>
                <Button size="sm" variant="ghost" onClick={duplicate}>
                  <Copy className="h-3.5 w-3.5" />
                  {t('复制')}
                </Button>
                {!readOnly && !draftIsNew && (
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('删除')}
                  </Button>
                )}
                {!readOnly && (
                  <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || problems.length > 0}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {t('保存')}
                  </Button>
                )}
              </div>
              {note && (
                <p className="rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2 text-[0.8125rem] leading-relaxed whitespace-pre-wrap">
                  {note}
                </p>
              )}
              <div className="flex max-w-[1000px] flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('名称')}>
                    <Input value={draft.name} disabled={readOnly} onChange={(e) => edit({ name: e.target.value })} />
                  </Field>
                  <Field label={t('用途')}>
                    <Select
                      aria-label={t('用途')}
                      value={draft.use}
                      disabled={readOnly}
                      onChange={(e) => edit({ use: e.target.value as ComfyWorkflow['use'] })}
                      options={WORKFLOW_USES.map((u) => ({ value: u, label: WORKFLOW_USE_LABEL[u] }))}
                    />
                  </Field>
                  <Field label={t('用到的模型')}>
                    <Select
                      aria-label={t('用到的模型')}
                      value={draft.model || 'none'}
                      disabled={readOnly}
                      onChange={(e) => edit({ model: e.target.value === 'none' ? '' : e.target.value })}
                      options={[
                        ...LOCAL_MODELS.map((m) => ({ value: m.id, label: m.name })),
                        { value: 'none', label: t('自己的模型（不检查下载）') },
                      ]}
                    />
                  </Field>
                  <Field label={t('说明')}>
                    <Input
                      value={draft.description}
                      disabled={readOnly}
                      onChange={(e) => edit({ description: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label={t('附加要求（英文，加在每张图的描述后面）')}>
                  <Textarea
                    rows={2}
                    value={draft.extra}
                    disabled={readOnly}
                    onChange={(e) => edit({ extra: e.target.value })}
                  />
                </Field>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-[0.78125rem] font-medium text-muted">
                    {t('节点图（ComfyUI 接口格式）')}
                  </span>
                  <Segmented
                    label={t('节点图的显示方式')}
                    value={graph ? view : 'json'}
                    onChange={setView}
                    options={[
                      // JSON 改坏了画不出图，只能先在配置里改好
                      { id: 'graph', label: t('图形'), disabled: !graph },
                      { id: 'json', label: t('配置') },
                    ]}
                  />
                </div>
                {graph && view === 'graph' ? (
                  <ComfyGraphView graph={graph} readOnly={readOnly} onChange={onGraph} />
                ) : (
                  <Textarea
                    rows={18}
                    spellCheck={false}
                    aria-label={t('节点图（ComfyUI 接口格式）')}
                    value={graphText}
                    readOnly={readOnly}
                    onChange={(e) => {
                      setGraphText(e.target.value)
                      setDirty(true)
                    }}
                    className="font-mono text-[0.75rem] leading-[1.5]"
                  />
                )}
                <span className="text-[0.75rem] leading-relaxed text-subtle">
                  {t(
                    '占位符：{{prompt}} 描述、{{negative}} 反向描述、{{width}} {{height}} 尺寸、{{count}} 张数、{{seed}} 随机种子',
                  )}
                </span>
              </div>
              {problems.length > 0 && (
                <ul className="flex flex-col gap-1 text-[0.78125rem] text-danger">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      {ask && (
        <AssistModal
          mode={ask}
          kind={kind}
          base={ask === 'optimize' ? (draft && graph ? { ...draft, graph } : undefined) : undefined}
          onClose={() => setAsk(null)}
          onResult={(w, why) => {
            setAsk(null)
            openDraft(w, why)
          }}
        />
      )}
      {importing && (
        <ImportModal
          kind={kind}
          onClose={() => setImporting(false)}
          onResult={(w) => {
            setImporting(false)
            openDraft(w, t('已自动换上占位符，检查无误后保存。'))
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除工作流「{name}」？', { name: draft?.name ?? '' })}
        confirmText={t('删除')}
        onConfirm={async () => {
          if (!draft) return
          await api.deleteComfyWorkflow(draft.id)
          setDeleting(false)
          setDraft(null)
          setDirty(false)
          setSel('')
          await load()
        }}
      />
      <ComfyWebDialog open={web} onOpenChange={setWeb} />
    </main>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[0.78125rem] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[0.75rem] leading-relaxed text-subtle">{hint}</span>}
    </label>
  )
}

/** AI 生成新的工作流，或者按要求优化当前的 */
function AssistModal({
  mode,
  kind,
  base,
  onClose,
  onResult,
}: {
  mode: 'create' | 'optimize'
  kind: Kind
  base?: ComfyWorkflow
  onClose: () => void
  onResult: (w: ComfyWorkflow, note: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const examples =
    mode === 'create'
      ? kind === 'game'
        ? [
            t('二次元手游的技能图标，描边粗、颜色饱和'),
            t('写实风格的武器图标，金属质感'),
            t('卡牌游戏的卡框，九宫格拉伸'),
          ]
        : [t('SaaS 官网的扁平插画，蓝紫配色'), t('电商活动横幅，留出放标题的位置')]
      : [t('出图更清晰、边缘更干净'), t('加一步放大再缩小，提高细节'), t('换成更快的设置，适合批量')]
  const run = async () => {
    setBusy(true)
    try {
      const r = await api.assistComfyWorkflow({ kind, instruction: text, base })
      onResult(r.workflow, r.note)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={mode === 'create' ? t('AI 生成工作流') : t('AI 优化「{name}」', { name: base?.name ?? '' })}
      footer={
        <>
          <span className="flex-1 text-[0.75rem] text-subtle">
            {t('用「AI 创建」里设置的 Agent；ComfyUI 在运行时会按它装的节点来写')}
          </span>
          <Button onClick={() => void run()} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {busy ? t('生成中…') : mode === 'create' ? t('生成') : t('优化')}
          </Button>
        </>
      }
    >
      <Textarea
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={mode === 'create' ? t('想生成什么样的资源、什么风格？') : t('想怎么改？')}
      />
      <div className="flex flex-wrap gap-1.5">
        {examples.map((x) => (
          <button
            key={x}
            onClick={() => setText(x)}
            className="cursor-pointer rounded-full border px-2.5 py-1 text-[0.75rem] text-muted hover:border-accent hover:text-accent"
          >
            {x}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** 导入 ComfyUI 里「导出（API）」得到的 JSON，自动换上占位符 */
function ImportModal({
  kind,
  onClose,
  onResult,
}: {
  kind: Kind
  onClose: () => void
  onResult: (w: ComfyWorkflow) => void
}) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const go = () => {
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      if (Array.isArray((raw as { nodes?: unknown }).nodes))
        return setError(t('这是界面格式的工作流。请在 ComfyUI 里用「导出（API）」再导出一次。'))
      const graph = autoPlaceholders(((raw as { graph?: unknown }).graph ?? raw) as ComfyWorkflow['graph'])
      onResult({
        id: newId(),
        name: name.trim() || t('导入的工作流'),
        kind,
        use: 'any',
        description: '',
        model: '',
        extra: '',
        graph,
        updatedAt: '',
      })
    } catch (e) {
      setError(t('JSON 解析失败：{error}', { error: (e as Error).message }))
    }
  }
  return (
    <Modal
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t('从 ComfyUI 导入工作流')}
      footer={
        <>
          <span className="flex-1 text-[0.75rem] text-danger">{error}</span>
          <Button onClick={go} disabled={!text.trim()}>
            <Plus className="h-3.5 w-3.5" />
            {t('导入')}
          </Button>
        </>
      }
    >
      <p className="text-[0.78125rem] leading-relaxed text-subtle">
        {t(
          '在 ComfyUI 里打开工作流，菜单「工作流 → 导出（API）」，把得到的 JSON 贴在下面。描述、尺寸、种子会自动换成占位符。',
        )}
      </p>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('名称')} />
      <Textarea
        rows={12}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setError('')
        }}
        className="font-mono text-[0.75rem]"
        placeholder='{ "3": { "class_type": "KSampler", "inputs": { ... } } }'
      />
    </Modal>
  )
}
