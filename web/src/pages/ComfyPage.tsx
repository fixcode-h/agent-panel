import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { toast } from '@/lib/toast'
import {
  Brush,
  Copy,
  Download,
  Frame,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Lock,
  MoreHorizontal,
  Network,
  PanelsTopLeft,
  Play,
  Plus,
  RectangleHorizontal,
  Shapes,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  LOCAL_MODELS,
  WORKFLOW_USES,
  WORKFLOW_USE_LABEL,
  autoPlaceholders,
  checkWorkflow,
  localFile,
  localModel,
  importedWorkflow,
  needsInputImage,
  type ComfyWorkflow,
  type WorkflowUse,
} from '@shared/local-image'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { ChipGroup } from '@/components/ui/chip-group'
import { Progress } from '@/components/ui/progress'
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/menu'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ComfyWebDialog } from '@/components/design/ComfyWeb'
import { useLocalImage } from '@/components/settings/LocalImageSection'
import { ComfyGraphView, ComfyValueField, nodeTone } from '@/components/comfy/ComfyGraphView'
import { ComfyQueuePanel } from '@/components/comfy/ComfyQueuePanel'
import { ComfyChainPanel } from '@/components/comfy/ComfyChainPanel'
import { TemplateStore } from '@/components/comfy/TemplateStore'

type Kind = 'game' | 'web'
type View = 'graph' | 'json'
type Side = 'about' | 'node' | 'models' | 'queue'
type Source = 'all' | 'builtin' | 'mine' | 'imported'
const VIEW_KEY = 'agent-panel:comfy-view'
const loadView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'json' ? 'json' : 'graph'
  } catch {
    return 'graph'
  }
}
const newId = () => `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 列表按分类分组（照设计稿）：游戏、网页各一组，去背景、放大这类处理工作流两边都能用，单独一组 */
const GROUPS: { kind: ComfyWorkflow['kind']; title: string }[] = [
  { kind: 'game', title: t('游戏 UI') },
  { kind: 'web', title: t('网页 UI') },
  { kind: 'both', title: t('图片处理') },
]

/** 列表里的缩略块：没有出过图的工作流也要能一眼分开，按用途给一个颜色和图标 */
const USE_LOOK: Record<WorkflowUse, { color: string; icon: LucideIcon }> = {
  icon: { color: '#7C3AED', icon: Shapes },
  button: { color: '#C98A1B', icon: RectangleHorizontal },
  panel: { color: '#0E6E79', icon: PanelsTopLeft },
  background: { color: '#3D4A63', icon: ImageIcon },
  concept: { color: '#2B3A55', icon: Frame },
  illustration: { color: '#4F46E5', icon: Brush },
  any: { color: '#64748B', icon: Sparkles },
}

/** 画布下面浮着的试生成条占的高度；上面标题 + 工具条的高度量出来（窄了会折成两行） */
const CANVAS_BOTTOM = 76

/** 一次试生成：只在这一页里记着，换页就没了（正式出图在 UI 设计里） */
interface TryRun {
  id: string
  workflow: string
  prompt: string
  status: 'running' | 'done' | 'failed'
  images: string[]
  error?: string
  startedAt: number
  ms?: number
}

/**
 * ComfyUI 工作流管理（照设计稿 ComfyUI 画板）：左边是按分类分组的工作流列表和 ComfyUI 的运行状态，
 * 中间整块是节点图画布（上面浮着工具条，下面是试生成），右栏分「说明 / 节点 / 模型 / 队列」。
 * 内置的是调好的工作流（只读，可以复制后改）；自己的可以手动改、从 ComfyUI 导入、让 AI 生成或优化。
 * UI 设计生成图片时选「本机」就会用到这里的工作流
 */
export function ComfyPage() {
  const { route, go, openSettings } = useNav()
  const [data, setData] = useState<{ list: ComfyWorkflow[]; ready: string[] }>()
  const [sel, setSel] = useState(route.sub ?? '')
  const [draft, setDraft] = useState<ComfyWorkflow | null>(null)
  const [graphText, setGraphText] = useState('')
  const [note, setNote] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ask, setAsk] = useState<{ mode: 'create' | 'optimize'; text?: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [web, setWeb] = useState(false)
  const [side, setSide] = useState<Side>('about')
  const [source, setSource] = useState<Source>('all')
  /** 画布上点中的节点：右栏「节点」页签显示它的参数 */
  const [node, setNode] = useState('')
  /** 「整理」：每点一次加一，节点图把节点摆回自动排布 */
  const [layoutToken, setLayoutToken] = useState(0)
  const [tryText, setTryText] = useState('')
  const [trySize, setTrySize] = useState(TRY_SIZES[0].id)
  const [tryCount, setTryCount] = useState(1)
  const [tries, setTries] = useState<TryRun[]>([])
  /** 刚导入到 ComfyUI 的工作流：网页弹窗顶部告诉用户去侧栏哪里打开 */
  const [webImported, setWebImported] = useState<{ name: string; filename: string } | null>(null)
  const [pushing, setPushing] = useState(false)
  const [store, setStore] = useState(false)
  const [st, setSt] = useLocalImage()
  // 标题和工具条放不下一行时折成两行：量出实际高度，节点图适应时让开
  const [topInset, setTopInset] = useState(64)
  const topBar = useRef<ResizeObserver | null>(null)
  const measureTop = useCallback((el: HTMLDivElement | null) => {
    topBar.current?.disconnect()
    if (!el) return
    const ro = new ResizeObserver(() => setTopInset(Math.round(el.offsetHeight) + 20))
    ro.observe(el)
    topBar.current = ro
  }, [])
  const inset = useMemo(() => ({ top: topInset, bottom: CANVAS_BOTTOM }), [topInset])
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

  const list = useMemo(() => data?.list ?? [], [data])
  // 没指定工作流时：旧链接 #/comfy/web 选第一个网页的，其余选第一个游戏的
  const current =
    list.find((w) => w.id === sel) ?? list.find((w) => w.kind === (route.id === 'web' ? 'web' : 'game')) ?? list[0]
  // 换了选中的工作流：编辑区换成它（新建、AI 结果还没保存时保留草稿）
  useEffect(() => {
    if (!current || (draft && dirty)) return
    setDraft(current)
    setGraphText(JSON.stringify(current.graph, null, 2))
    setNote('')
    setDirty(false)
    setNode('')
    // 只在选中的工作流变化时重置
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.updatedAt])
  /** AI 生成、导入、模板商店默认按当前工作流的分类来 */
  const kind: Kind = (draft ?? current)?.kind === 'web' ? 'web' : 'game'

  const pick = (w: ComfyWorkflow) => {
    if (w.id === draft?.id) return
    if (dirty && !confirm(t('还有没保存的修改，确定放弃？'))) return
    setDirty(false)
    setDraft(null)
    setSel(w.id)
    go({ page: 'comfy', id: w.kind === 'web' ? 'web' : 'game', sub: w.id })
  }
  const openDraft = (w: ComfyWorkflow, why = '') => {
    setDraft(w)
    setGraphText(JSON.stringify(w.graph, null, 2))
    setNote(why)
    setDirty(true)
    setSel(w.id)
    setNode('')
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
  const onPickNode = useCallback((id: string) => {
    setNode(id)
    setSide('node')
  }, [])
  const readOnly = !!draft?.builtin
  const ready = (w: ComfyWorkflow) => !!data?.ready.includes(w.id)

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

  /** 面板 → ComfyUI：把当前工作流写进它的工作流列表；有没保存的修改先保存（ComfyUI 读的是存下来的那份） */
  const pushToComfy = async (o: { openWeb?: boolean; quiet?: boolean } = {}) => {
    if (!draft || pushing) return
    setPushing(true)
    // 先打开网页：ComfyUI 没启动时这里会显示「正在启动并导入」，不用等按钮转完才看到反应
    if (o.openWeb) {
      setWebImported(null)
      setWeb(true)
    }
    try {
      if (dirty) {
        if (!graph || problems.length) {
          toast.error(t('节点图有问题，先修好再导入'))
          return
        }
        await save()
      }
      const r = await api.importComfyWorkflow(draft.id)
      setWebImported(r)
      if (!o.quiet) toast.success(t('已导入到 ComfyUI 的工作流列表：{name}', { name: r.name }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPushing(false)
    }
  }
  // 打开网页时把当前工作流一起带过去；有没保存的修改时不自动导入，免得把旧的内容推过去
  const openWeb = () => {
    setWebImported(null)
    setWeb(true)
    if (draft && dirty) toast.message(t('有没保存的修改：保存后才会把工作流导入到 ComfyUI'))
    else if (draft) void pushToComfy({ quiet: true })
  }

  const exportJson = () => {
    if (!draft) return
    const blob = new Blob([JSON.stringify(graph ?? draft.graph, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${draft.name}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const draftIsNew = !!draft && !list.some((w) => w.id === draft.id)
  // 试生成跑的是存下来的那份（服务端按 id 取工作流），所以没保存、要原图的工作流先拦下并说清楚
  const tryBlock = !draft
    ? t('选一个工作流')
    : dirty || draftIsNew
      ? t('先保存再试生成：试生成用的是保存的那份')
      : graph && needsInputImage(graph)
        ? t('这个工作流要一张原图，到「队列」里的工作流链选图试跑')
        : ''
  /** 试生成：把当前工作流当成只有一段的工作流链跑一次，出图显示在「队列」页签里 */
  const tryRun = async () => {
    if (!draft || tryBlock) return
    const run: TryRun = {
      id: newId(),
      workflow: draft.name,
      prompt: tryText.trim(),
      status: 'running',
      images: [],
      startedAt: Date.now(),
    }
    setTries((xs) => [run, ...xs].slice(0, 8))
    setSide('queue')
    const patch = (p: Partial<TryRun>) => setTries((xs) => xs.map((x) => (x.id === run.id ? { ...x, ...p } : x)))
    try {
      const r = await api.runComfyChain(
        { id: `try_${draft.id}`, name: draft.name, steps: [{ workflowId: draft.id, prompt: '' }], updatedAt: '' },
        undefined,
        run.prompt,
        { ...(TRY_SIZES.find((x) => x.id === trySize) ?? TRY_SIZES[0]), count: tryCount },
      )
      patch({ status: 'done', images: r.images, ms: Date.now() - run.startedAt })
    } catch (e) {
      // 出错原样告诉用户（例如模型没下载、ComfyUI 没装），不悄悄重试
      const error = (e as Error).message
      patch({ status: 'failed', error, ms: Date.now() - run.startedAt })
      toast.error(error)
    }
  }

  const shown = list.filter((w) =>
    source === 'all'
      ? true
      : source === 'builtin'
        ? w.builtin
        : source === 'imported'
          ? !w.builtin && importedWorkflow(w)
          : !w.builtin && !importedWorkflow(w),
  )
  const model = draft?.model ? localModel(draft.model) : undefined
  const picked = node && graph?.[node] ? { id: node, ...graph[node] } : undefined
  const runningTries = tries.filter((x) => x.status === 'running').length
  const comfyState = !st
    ? t('读取中…')
    : st.running
      ? t('ComfyUI 运行中')
      : st.installed || st.external
        ? t('ComfyUI 没在运行')
        : t('还没安装 ComfyUI')

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-2 lg:h-full lg:flex-row lg:overflow-hidden lg:py-2 lg:pr-2 lg:pl-0.5">
      {/* 左：工作流列表（照设计稿的 268px 一栏，宽屏时会话侧栏让开，这一栏就是这页的侧栏） */}
      <section
        aria-label={t('工作流列表')}
        className="flex max-h-[46vh] shrink-0 flex-col gap-2.5 lg:max-h-none lg:w-[268px] lg:py-1"
      >
        <div className="flex flex-wrap items-center gap-1.5 px-1.5">
          <h1 className="min-w-[110px] flex-1 truncate text-[0.96875rem] font-semibold">{t('ComfyUI 工作流')}</h1>
          {/* 照设计稿：标题和两个小按钮挤在一行（28px 高、12px 字），放不下才折行 */}
          <Button size="sm" variant="secondary" className="h-7 px-2 text-[0.75rem]" onClick={() => setImporting(true)}>
            {t('导入')}
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-[0.75rem] font-semibold"
            onClick={() => setAsk({ mode: 'create' })}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('AI 生成')}
          </Button>
        </div>
        <Segmented
          label={t('工作流来源')}
          size="sm"
          fill
          className="mx-1"
          value={source}
          onChange={setSource}
          options={[
            { id: 'all', label: t('全部') },
            { id: 'builtin', label: t('内置') },
            { id: 'mine', label: t('我的') },
            { id: 'imported', label: t('导入的') },
          ]}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {!data ? (
            <p className="p-3 text-[0.8125rem] text-subtle">{t('读取中…')}</p>
          ) : (
            <>
              {draftIsNew && (
                <ListGroup title={t('未保存')}>
                  <WorkflowRow w={draft} on ready={false} onPick={() => {}} />
                </ListGroup>
              )}
              {GROUPS.map((g) => {
                const items = shown.filter((w) => w.kind === g.kind)
                return (
                  items.length > 0 && (
                    <ListGroup key={g.kind} title={g.title}>
                      {items.map((w) => (
                        <WorkflowRow key={w.id} w={w} on={draft?.id === w.id} ready={ready(w)} onPick={() => pick(w)} />
                      ))}
                    </ListGroup>
                  )
                )
              })}
              {!shown.length && (
                <p className="px-2 py-4 text-[0.75rem] leading-relaxed text-subtle">
                  {t('还没有，可以导入或让 AI 生成')}
                </p>
              )}
              <button
                type="button"
                onClick={() => setStore(true)}
                className="mt-2 flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[11px] border border-dashed border-line-strong text-[0.8125rem] text-muted transition-colors hover:bg-sel/60 hover:text-fg"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                {t('模板商店')}
              </button>
            </>
          )}
        </div>
        {/* ComfyUI 的运行状态：出图、导入都要它在跑，放在列表底下常驻 */}
        <div className="mx-1 flex items-center gap-2 rounded-xl bg-card px-2.5 py-2 shadow-[0_0_0_1px_var(--line)]">
          <span
            aria-hidden
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              st?.running
                ? 'bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-success)_18%,transparent)]'
                : 'bg-line-strong',
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[0.78125rem] font-semibold">{comfyState}</span>
            {st && (
              <span className="truncate font-mono text-[0.6875rem] text-subtle">
                {[st.url.replace(/^https?:\/\//, ''), st.gpuName].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => openSettings('local-image')}>
            {t('本机设置')}
          </Button>
        </div>
      </section>

      {/* 中：整块节点图画布，标题和工具条浮在上面，试生成浮在下面（照设计稿） */}
      <section aria-label={t('节点图')} className="panel relative min-h-[70vh] min-w-0 flex-1 @container lg:min-h-0">
        {!draft ? (
          <p className="p-8 text-center text-[0.8125rem] text-subtle">{t('选一个工作流查看和修改')}</p>
        ) : (
          <>
            <div className="absolute inset-0">
              {graph && view === 'graph' ? (
                <ComfyGraphView
                  fill
                  graph={graph}
                  readOnly={readOnly}
                  onChange={onGraph}
                  inset={inset}
                  selected={node}
                  onSelect={onPickNode}
                  layoutToken={layoutToken}
                />
              ) : (
                <Textarea
                  spellCheck={false}
                  aria-label={t('节点图（ComfyUI 接口格式）')}
                  value={graphText}
                  readOnly={readOnly}
                  onChange={(e) => {
                    setGraphText(e.target.value)
                    setDirty(true)
                  }}
                  style={{ top: inset.top, bottom: inset.bottom }}
                  className="absolute right-4 left-4 h-auto resize-none font-mono text-[0.75rem] leading-[1.5]"
                />
              )}
            </div>

            <div
              ref={measureTop}
              className="pointer-events-none absolute inset-x-3 top-3 z-[5] flex flex-wrap items-start justify-end gap-x-3 gap-y-2"
            >
              <div className="pointer-events-auto flex min-w-[160px] flex-1 basis-[160px] flex-col gap-0.5 pt-0.5 pl-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[0.9375rem] font-semibold">{draft.name}</span>
                  {dirty && <span className="shrink-0 text-[0.6875rem] text-warning">{t('未保存')}</span>}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.75rem] text-subtle">
                  {readOnly && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-sel px-1.5 py-px text-muted">
                      <Lock className="h-3 w-3" />
                      {t('内置，只读')}
                    </span>
                  )}
                  {model && (
                    <span
                      className={cn(
                        'rounded-md px-1.5 py-px',
                        ready(draft) ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
                      )}
                    >
                      {ready(draft)
                        ? t('{name} 已下载', { name: model.name })
                        : t('需要先下载 {name}', { name: model.name })}
                    </span>
                  )}
                  {problems.length > 0 && (
                    <span className="rounded-md bg-danger/10 px-1.5 py-px text-danger">
                      {t('{n} 个问题', { n: problems.length })}
                    </span>
                  )}
                  {draft.description && <span className="truncate">{draft.description}</span>}
                </div>
              </div>
              <div
                role="toolbar"
                aria-label={t('工作流工具')}
                className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-[13px] bg-card p-1 shadow-pop"
              >
                <Tool icon={Wand2} label={t('AI 优化')} tone="peer" onClick={() => setAsk({ mode: 'optimize' })} />
                <Tool
                  icon={Network}
                  wide
                  label={t('整理')}
                  title={t('把节点摆回自动排布的位置')}
                  disabled={view !== 'graph' || !graph}
                  onClick={() => setLayoutToken((n) => n + 1)}
                />
                <Sep />
                <Tool
                  icon={pushing ? Loader2 : Upload}
                  spin={pushing}
                  label={t('导入到 ComfyUI')}
                  title={t('把当前工作流导入到 ComfyUI 的工作流列表，在 ComfyUI 网页里打开')}
                  disabled={pushing}
                  onClick={() => void pushToComfy({ openWeb: true })}
                />
                <Tool
                  icon={Globe}
                  wide
                  label={t('ComfyUI 网页')}
                  title={t('在面板里打开 ComfyUI 的网页')}
                  onClick={openWeb}
                  dot={st?.running ? 'bg-success' : 'bg-line-strong'}
                />
                <Segmented
                  label={t('节点图的显示方式')}
                  size="sm"
                  className="mx-1"
                  value={graph ? view : 'json'}
                  onChange={setView}
                  options={[
                    // JSON 改坏了画不出图，只能先在配置里改好
                    { id: 'graph', label: t('图形'), disabled: !graph },
                    { id: 'json', label: t('配置') },
                  ]}
                />
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('更多')}
                      title={t('更多')}
                      className="grid h-8 w-8 cursor-pointer place-items-center rounded-[9px] text-muted transition-colors hover:bg-sel hover:text-fg"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={exportJson}>
                      <Download className="h-3.5 w-3.5" />
                      {t('导出 JSON')}
                    </MenuItem>
                    <MenuItem onSelect={duplicate}>
                      <Copy className="h-3.5 w-3.5" />
                      {t('复制')}
                    </MenuItem>
                    {!readOnly && !draftIsNew && (
                      <MenuItem danger onSelect={() => setDeleting(true)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('删除')}
                      </MenuItem>
                    )}
                  </MenuContent>
                </Menu>
                <Sep />
                {readOnly ? (
                  // 内置的只读：主按钮换成复制（字短，工具条才放得下标题），说明放在悬停提示里
                  <Button size="sm" className="rounded-[9px]" onClick={duplicate} title={t('复制后修改')}>
                    <Copy className="h-3.5 w-3.5" />
                    {t('复制')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="rounded-[9px] font-semibold"
                    onClick={() => void save()}
                    disabled={!dirty || saving || problems.length > 0}
                  >
                    {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t('保存')}
                  </Button>
                )}
              </div>
            </div>

            {note && (
              <div
                style={{ top: inset.top - 8 }}
                className="absolute left-4 z-[5] flex max-w-md items-start gap-2 rounded-xl bg-accent-soft px-3 py-2 text-[0.8125rem] leading-relaxed shadow-pop"
              >
                <p className="min-w-0 flex-1 whitespace-pre-wrap">{note}</p>
                <button
                  type="button"
                  aria-label={t('关闭')}
                  onClick={() => setNote('')}
                  className="shrink-0 cursor-pointer text-subtle hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault()
                void tryRun()
              }}
              className="absolute bottom-4 left-1/2 z-[5] flex w-[min(620px,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-[14px] bg-card py-1.5 pr-1.5 pl-3.5 shadow-pop"
            >
              <span className="shrink-0 text-[0.6875rem] font-semibold tracking-[0.06em] text-subtle">
                {t('试生成')}
              </span>
              <input
                aria-label={t('试生成的描述')}
                value={tryText}
                onChange={(e) => setTryText(e.target.value)}
                placeholder={tryBlock || t('写一句描述，用这个工作流出一张图看看')}
                className="min-w-0 flex-1 border-0 bg-transparent text-[0.84375rem] outline-none placeholder:text-subtle"
              />
              <TryPick
                label={t('试生成的尺寸')}
                value={trySize}
                onChange={setTrySize}
                options={TRY_SIZES.map((x) => ({ id: x.id, label: x.label }))}
              />
              <TryPick
                label={t('试生成的张数')}
                value={String(tryCount)}
                onChange={(v) => setTryCount(Number(v))}
                options={[1, 2, 3, 4].map((n) => ({ id: String(n), label: `× ${n}` }))}
              />
              <Button
                type="submit"
                size="sm"
                className="rounded-[9px] font-semibold"
                disabled={!!tryBlock}
                title={tryBlock}
              >
                <Play className="h-3 w-3 fill-current" />
                {t('生成')}
              </Button>
            </form>
          </>
        )}
      </section>

      {/* 右：说明 / 节点 / 模型 / 队列 */}
      <aside
        aria-label={t('工作流详情')}
        className="panel flex min-h-[60vh] shrink-0 flex-col lg:min-h-0 lg:w-[330px] 2xl:w-[360px]"
      >
        <TabBar label={t('工作流详情')}>
          <TabItem fill active={side === 'about'} onSelect={() => setSide('about')}>
            {t('说明')}
          </TabItem>
          <TabItem fill active={side === 'node'} onSelect={() => setSide('node')}>
            {t('节点')}
          </TabItem>
          <TabItem fill active={side === 'models'} onSelect={() => setSide('models')}>
            {t('模型')}
          </TabItem>
          <TabItem
            fill
            active={side === 'queue'}
            onSelect={() => setSide('queue')}
            tag={runningTries ? <Count n={runningTries} /> : undefined}
          >
            {t('队列')}
          </TabItem>
        </TabBar>
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          {side === 'queue' ? (
            <div className="flex flex-col gap-4">
              {tries.length > 0 && (
                <section className="flex flex-col gap-2">
                  <Label>{t('试生成')}</Label>
                  {tries.map((x) => (
                    <TryCard key={x.id} run={x} />
                  ))}
                </section>
              )}
              <ComfyQueuePanel />
              <ComfyChainPanel kind={kind} />
            </div>
          ) : !draft ? (
            <p className="py-6 text-center text-[0.8125rem] text-subtle">{t('选一个工作流查看和修改')}</p>
          ) : side === 'node' ? (
            !picked ? (
              <p className="py-6 text-center text-[0.8125rem] leading-relaxed text-subtle">
                {t('在画布上点一个节点，这里显示它的参数')}
              </p>
            ) : (
              <div className="flex flex-col gap-3.5">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ background: nodeTone(picked.class_type) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[0.875rem] font-semibold">
                    {String((picked as { _meta?: { title?: string } })._meta?.title ?? '') || picked.class_type}
                  </span>
                  <span className="shrink-0 font-mono text-[0.6875rem] text-subtle">
                    {picked.class_type} · #{picked.id}
                  </span>
                </div>
                {Object.entries(picked.inputs).map(([key, v]) => {
                  const link =
                    Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' ? (v as [string, number]) : null
                  return (
                    <div key={key} className="flex min-w-0 flex-col gap-1.5">
                      <Label>{key}</Label>
                      {link ? (
                        <button
                          type="button"
                          onClick={() => setNode(link[0])}
                          className="flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-field px-2.5 text-left font-mono text-[0.75rem] text-muted hover:text-fg"
                        >
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{ background: nodeTone(graph?.[link[0]]?.class_type ?? '') }}
                          />
                          ← #{link[0]} {graph?.[link[0]]?.class_type ?? ''}
                          {link[1] ? ` · ${link[1]}` : ''}
                        </button>
                      ) : (
                        <ComfyValueField
                          label={key}
                          value={v}
                          readOnly={readOnly}
                          className="h-8 rounded-lg px-2.5 text-[0.75rem]"
                          onChange={(nv) =>
                            graph &&
                            onGraph({
                              ...graph,
                              [picked.id]: { ...graph[picked.id], inputs: { ...graph[picked.id].inputs, [key]: nv } },
                            })
                          }
                        />
                      )}
                    </div>
                  )
                })}
                <span className="text-[0.75rem] leading-relaxed text-subtle">
                  {readOnly
                    ? t('内置工作流只读，复制后再改。')
                    : t('改了参数会标「未保存」；保存后导入到 ComfyUI、试生成才用新的。')}
                </span>
              </div>
            )
          ) : side === 'models' ? (
            <ModelsTab draft={draft} st={st} onStatus={setSt} />
          ) : (
            <div className="flex flex-col gap-3.5">
              <Field label={t('名称')}>
                <Input value={draft.name} disabled={readOnly} onChange={(e) => edit({ name: e.target.value })} />
              </Field>
              <div className="flex flex-col gap-1.5">
                <Label>{t('用途')}</Label>
                <ChipGroup
                  label={t('用途')}
                  size="sm"
                  value={draft.use}
                  onChange={(u) => !readOnly && edit({ use: u })}
                  options={WORKFLOW_USES.map((u) => ({ id: u, label: WORKFLOW_USE_LABEL[u], disabled: readOnly }))}
                />
                <span className="text-[0.75rem] leading-relaxed text-subtle">
                  {t('UI 设计选「本机」出图时，按图片用途自动挑工作流。')}
                </span>
              </div>
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
                <Textarea
                  rows={2}
                  value={draft.description}
                  disabled={readOnly}
                  onChange={(e) => edit({ description: e.target.value })}
                />
              </Field>
              <Field label={t('附加要求（英文，加在每张图的描述后面）')}>
                <Textarea
                  rows={2}
                  value={draft.extra}
                  disabled={readOnly}
                  onChange={(e) => edit({ extra: e.target.value })}
                />
              </Field>
              <span className="text-[0.75rem] leading-relaxed text-subtle">
                {t(
                  '占位符：{{prompt}} 描述、{{negative}} 反向描述、{{width}} {{height}} 尺寸、{{count}} 张数、{{seed}} 随机种子',
                )}
              </span>
              {problems.length > 0 && (
                <ul className="flex flex-col gap-1 text-[0.75rem] text-danger">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-col gap-1.5">
                <Label>{t('AI 优化')}</Label>
                {OPTIMIZE_TIPS().map((tip) => (
                  <button
                    key={tip}
                    type="button"
                    onClick={() => setAsk({ mode: 'optimize', text: tip })}
                    className="flex cursor-pointer items-center gap-2 rounded-[10px] bg-card px-2.5 py-2 text-left text-[0.78125rem] shadow-[0_0_0_1px_var(--line-strong)] transition-colors hover:bg-sel/50"
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-peer" />
                    <span className="min-w-0 flex-1">{tip}</span>
                    <span aria-hidden className="text-subtle">
                      ›
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {ask && (
        <AssistModal
          mode={ask.mode}
          initial={ask.text}
          kind={kind}
          base={ask.mode === 'optimize' ? (draft && graph ? { ...draft, graph } : undefined) : undefined}
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
      <ComfyWebDialog
        open={web}
        onOpenChange={(o) => {
          setWeb(o)
          if (!o) setWebImported(null)
        }}
        imported={webImported}
        importing={pushing}
      />
      {store && (
        <TemplateStore
          kind={kind}
          status={st}
          onClose={() => setStore(false)}
          onImport={() => {
            setStore(false)
            setImporting(true)
          }}
          onAdded={(wf) => {
            setStore(false)
            setDraft(null)
            setDirty(false)
            setSel(wf.id)
            void load()
            go({ page: 'comfy', id: kind, sub: wf.id })
          }}
        />
      )}
    </main>
  )
}

/**
 * 试生成的尺寸：只决定比例，服务端按模型的基准边长换算（localSize）；
 * 和 UI 设计里常用的几种画面对上（方图标、横幅、竖卡、整屏）
 */
const TRY_SIZES = [
  { id: 'square', label: '1024²', width: 1024, height: 1024 },
  { id: 'wide', label: '3:2', width: 1536, height: 1024 },
  { id: 'tall', label: '2:3', width: 1024, height: 1536 },
  { id: 'screen', label: '16:9', width: 1920, height: 1080 },
]

/** 试生成条上的小下拉（尺寸、张数）：按钮上写当前值，点开单选 */
function TryPick({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { id: string; label: string }[]
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="h-[30px] shrink-0 cursor-pointer rounded-lg bg-card px-2.5 text-[0.75rem] shadow-[0_0_0_1px_var(--line-strong)] transition-colors hover:bg-sel/50"
        >
          {options.find((o) => o.id === value)?.label ?? value}
        </button>
      </MenuTrigger>
      <MenuContent className="min-w-[120px]">
        <MenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((o) => (
            <MenuRadioItem key={o.id} value={o.id}>
              <span className="flex-1">{o.label}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  )
}

/** 「AI 优化」常用的几种要求：右栏和 AI 优化弹窗里共用 */
const OPTIMIZE_TIPS = () => [
  t('出图更清晰、边缘更干净'),
  t('加一步放大再缩小，提高细节'),
  t('换成更快的设置，适合批量'),
]

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[0.6875rem] font-semibold tracking-[0.06em] text-subtle">{children}</span>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  )
}

function Count({ n }: { n: number }) {
  return (
    <span className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-sel px-1.5 text-[0.6875rem] font-normal">
      {n}
    </span>
  )
}

function Sep() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
}

/** 画布工具条上的按钮：画布够宽时图标 + 文字，窄了只留图标（文字进读屏名和悬停提示） */
function Tool({
  icon: Icon,
  label,
  title,
  onClick,
  disabled,
  spin,
  tone,
  dot,
  wide,
}: {
  icon: LucideIcon
  label: string
  /** 次要的按钮：画布更宽（≥ 1000px）才写字，免得工具条把标题挤没 */
  wide?: boolean
  title?: string
  onClick: () => void
  disabled?: boolean
  spin?: boolean
  tone?: 'peer'
  /** 文字后面的状态点（ComfyUI 有没有在跑） */
  dot?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[9px] px-2 text-[0.78125rem] whitespace-nowrap transition-colors hover:bg-sel disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent @[740px]:px-2.5',
        tone === 'peer' ? 'text-peer' : 'text-muted hover:text-fg',
      )}
    >
      <Icon className={cn('h-[15px] w-[15px]', spin && 'animate-spin')} strokeWidth={1.9} />
      <span className={cn('hidden', wide ? '@[1000px]:inline' : '@[740px]:inline')}>{label}</span>
      {dot && <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dot)} />}
    </button>
  )
}

function ListGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h2 className="px-1.5 pt-2.5 pb-1 text-[0.6875rem] font-semibold tracking-[0.06em] text-subtle">{title}</h2>
      {children}
    </section>
  )
}

/** 列表里的一个工作流：缩略块（按用途上色）+ 名字 + 用途和模型 + 来源标签；缩略块角上的点是模型下载了没有 */
function WorkflowRow({ w, on, ready, onPick }: { w: ComfyWorkflow; on: boolean; ready: boolean; onPick: () => void }) {
  const look = USE_LOOK[w.use] ?? USE_LOOK.any
  const Icon = look.icon
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={on}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-[11px] px-2 py-[7px] text-left transition-colors',
        on ? 'bg-card shadow-[0_0_0_1px_var(--line-strong)]' : 'hover:bg-sel/60',
      )}
    >
      <span
        className="relative grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] text-white"
        style={{ background: look.color }}
      >
        <Icon className="h-4 w-4 opacity-90" strokeWidth={1.8} />
        <span
          title={ready ? t('模型已下载，可以用') : t('模型还没下载')}
          className={cn(
            'absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg)]',
            ready ? 'bg-success' : 'bg-line-strong',
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[0.8125rem] font-semibold">{w.name}</span>
        <span className="truncate text-[0.6875rem] text-subtle">
          {WORKFLOW_USE_LABEL[w.use]}
          {w.model ? ` · ${localModel(w.model)?.name ?? w.model}` : ''}
        </span>
      </span>
      <span className={cn('shrink-0 text-[0.65625rem]', w.builtin ? 'text-subtle' : 'text-peer')}>
        {w.builtin ? t('内置') : importedWorkflow(w) ? t('导入的') : t('我的')}
      </span>
    </button>
  )
}

/** 一次试生成的卡片：跑着时转圈 + 占位格，出图后四格缩略图，失败写原因 */
function TryCard({ run }: { run: TryRun }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-card px-3 py-2.5 shadow-[0_0_0_1px_var(--line),0_2px_6px_-4px_rgb(0_0_0/0.15)]">
      <div className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
        {run.status === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : run.status === 'done' ? (
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-success/15 text-[0.625rem] font-bold text-success">
            ✓
          </span>
        ) : (
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-danger/15 text-[0.625rem] font-bold text-danger">
            !
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={run.prompt}>
          {run.prompt || run.workflow}
        </span>
        <span className="shrink-0 text-[0.6875rem] text-subtle">
          {run.status === 'running' ? t('生成中') : t('{s} 秒', { s: Math.max(1, Math.round((run.ms ?? 0) / 1000)) })}
        </span>
      </div>
      {run.status === 'running' && <Progress label={t('试生成进度')} value={0} indeterminate />}
      {run.status === 'failed' && <p className="text-[0.75rem] leading-relaxed text-danger">{run.error}</p>}
      {run.images.length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {run.images.map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noreferrer" className="block">
              <img
                src={src}
                alt=""
                className="aspect-square w-full rounded-md object-cover shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/** 「模型」页签：这个工作流用到的内置模型有哪些文件、下载了没有，缺的可以直接下载 */
function ModelsTab({
  draft,
  st,
  onStatus,
}: {
  draft: ComfyWorkflow
  st: ReturnType<typeof useLocalImage>[0]
  onStatus: ReturnType<typeof useLocalImage>[1]
}) {
  const model = draft.model ? localModel(draft.model) : undefined
  const job = st?.job?.status === 'running' && st.job.kind === 'download' ? st.job : undefined
  if (st?.external)
    return (
      <p className="py-6 text-center text-[0.8125rem] leading-relaxed text-subtle">
        {t('用的是已有的 ComfyUI，模型由它自己管，这里不检查下载。')}
      </p>
    )
  if (!model)
    return draft.assets.length ? (
      <div className="flex flex-col gap-2">
        <Label>{t('依赖的模型文件')}</Label>
        {draft.assets.map((a) => (
          <span key={a} className="truncate rounded-lg bg-field px-2.5 py-1.5 font-mono text-[0.75rem]" title={a}>
            {a}
          </span>
        ))}
      </div>
    ) : (
      <p className="py-6 text-center text-[0.8125rem] leading-relaxed text-subtle">
        {t('这个工作流用自己的模型，不检查下载。')}
      </p>
    )
  const files = model.files.map((id) => ({ id, f: localFile(id), have: !!st?.files.includes(id) }))
  const missing = files.filter((x) => !x.have)
  const missingGb = missing.reduce((n, x) => n + (x.f?.gb ?? 0), 0)
  const download = () =>
    api
      .localModel(model.id, 'download')
      .then(onStatus)
      .catch((e) => toast.error((e as Error).message))
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[0.875rem] font-semibold">{model.name}</span>
        <span className="shrink-0 text-[0.6875rem] text-subtle">{t('建议显存 {n} GB', { n: model.vram })}</span>
      </div>
      {files.map(({ id, f, have }) => (
        <div
          key={id}
          className="flex flex-col gap-2 rounded-xl bg-card px-3 py-2.5 shadow-[0_0_0_1px_var(--line),0_2px_6px_-4px_rgb(0_0_0/0.15)]"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]" title={f?.file ?? id}>
              {f?.file ?? id}
            </span>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-px text-[0.65625rem] font-semibold whitespace-nowrap',
                have
                  ? 'bg-success/10 text-success'
                  : job
                    ? 'bg-accent-soft text-accent-text'
                    : 'bg-warning/10 text-warning',
              )}
            >
              {have ? t('已下载') : job ? t('下载中') : t('还没下载')}
            </span>
          </div>
          {f && <span className="text-[0.6875rem] text-subtle">{t('约 {n} GB', { n: f.gb })}</span>}
          {!have && job?.progress && (
            <Progress label={t('下载进度')} value={job.progress.done} max={job.progress.total} />
          )}
        </div>
      ))}
      {missing.length > 0 && !job && (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => void download()}>
          <Download className="h-3.5 w-3.5" />
          {t('下载 · 约 {n} GB', { n: Math.round(missingGb * 10) / 10 })}
        </Button>
      )}
      {job && <span className="text-[0.75rem] text-subtle">{job.step}</span>}
    </div>
  )
}

/** AI 生成新的工作流，或者按要求优化当前的 */
function AssistModal({
  mode,
  initial = '',
  kind: kind0,
  base,
  onClose,
  onResult,
}: {
  mode: 'create' | 'optimize'
  /** 右栏「AI 优化」里点的那条要求，预先填好 */
  initial?: string
  kind: Kind
  base?: ComfyWorkflow
  onClose: () => void
  onResult: (w: ComfyWorkflow, note: string) => void
}) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  // 列表不再按游戏 / 网页分页：新生成的工作流归哪类在弹窗里选，默认跟当前工作流
  const [kind, setKind] = useState<Kind>(kind0)
  const examples =
    mode === 'create'
      ? kind === 'game'
        ? [
            t('二次元手游的技能图标，描边粗、颜色饱和'),
            t('写实风格的武器图标，金属质感'),
            t('卡牌游戏的卡框，九宫格拉伸'),
          ]
        : [t('SaaS 官网的扁平插画，蓝紫配色'), t('电商活动横幅，留出放标题的位置')]
      : OPTIMIZE_TIPS()
  const run = async () => {
    setBusy(true)
    try {
      const r = await api.assistComfyWorkflow({ kind, instruction: text, base })
      // AI 新生成的记一下来源；优化沿用原来的（导入的工作流优化后还算导入的）
      onResult(mode === 'create' ? { ...r.workflow, origin: 'ai' } : r.workflow, r.note)
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
      {mode === 'create' && <KindPick value={kind} onChange={setKind} />}
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
            className="chip-idle cursor-pointer rounded-full px-2.5 py-1 text-[0.75rem] text-muted transition-colors hover:text-accent-text"
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
  kind: kind0,
  onClose,
  onResult,
}: {
  kind: Kind
  onClose: () => void
  onResult: (w: ComfyWorkflow) => void
}) {
  const [kind, setKind] = useState<Kind>(kind0)
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
        assets: [],
        extra: '',
        graph,
        origin: 'import',
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
      <p className="text-[0.75rem] leading-relaxed text-subtle">
        {t(
          '在 ComfyUI 里打开工作流，菜单「工作流 → 导出（API）」，把得到的 JSON 贴在下面。描述、尺寸、种子会自动换成占位符。',
        )}
      </p>
      <KindPick value={kind} onChange={setKind} />
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

/** 新工作流归游戏还是网页：决定 UI 设计里哪类项目会用到它 */
function KindPick({ value, onChange }: { value: Kind; onChange: (k: Kind) => void }) {
  return (
    <Segmented
      label={t('工作流分类')}
      size="sm"
      className="self-start"
      value={value}
      onChange={onChange}
      options={[
        { id: 'game', label: t('游戏 UI') },
        { id: 'web', label: t('网页 UI') },
      ]}
    />
  )
}
