import { useEffect, useMemo, useRef, useState } from 'react'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { toast } from '@/lib/toast'
import {
  Check,
  ChevronDown,
  Clapperboard,
  Database,
  LayoutTemplate,
  Settings2,
  Workflow,
  Download,
  Layers,
  FileJson,
  FileArchive,
  FileCode2,
  FolderDown,
  Gamepad2,
  Globe,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Palette as PaletteIcon,
  Plus,
  Puzzle,
  Loader2,
  Monitor,
  Redo2,
  Smartphone,
  Tablet,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { Attachment } from '@shared/schema'
import {
  emptyConcept,
  hasMask,
  imageRevisionText,
  type Annotation,
  type ConceptImage,
  type DesignVersion,
  type DesignDoc,
  type DesignImage,
  type ImageSource,
  type DesignKind,
  type WidgetCitation,
} from '@shared/design'
import {
  IMAGE_SLOT,
  WIDGETS,
  allNames,
  applyVisibility,
  assignImage,
  canAddChild,
  cloneWidget,
  defaultSlot,
  exportDesign,
  findParent,
  findWidget,
  imageUsers,
  insertWidget,
  mapWidget,
  moveWidget,
  newWidget,
  pathTo,
  removeWidget,
  replaceWidget,
  resizeCanvasSlot,
  toggledVisibility,
  uniqueName,
  wrapWidget,
  usedImages,
  walk,
  type Widget,
  type WidgetType,
} from '@shared/umg'
import { api, designExportUrl, designFileUrl } from '@/lib/api'
import { useScopedSetting } from '@/lib/useScopedSetting'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { ChipGroup } from '@/components/ui/chip-group'
import { ConfirmDialog } from '@/components/ui/dialog'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/menu'
import { SaveIndicator } from '@/components/layout/Detail'
import { AnimationPanel, type AnimCommand } from '@/components/design/AnimationPanel'
import { renameInAnimations, setKeyAt, type AnimProp, type AnimValue } from '@shared/anim'
import { Viewport } from '@/components/design/Viewport'
import { DataPanel } from '@/components/design/DataPanel'
import { bindDataSet, emptyData } from '@shared/design-data'
import { Hierarchy, Palette } from '@/components/design/Hierarchy'
import type { WidgetLayer, WidgetMenuActions } from '@/components/design/WidgetMenu'
import { Details } from '@/components/design/Details'
import { ImageDetails, ImagePreview, ImagesPanel, readFile, type WidgetRef } from '@/components/design/ImagesPanel'
import { ComponentsPanel } from '@/components/design/ComponentsPanel'
import { VersionCompare, VersionsButton } from '@/components/design/Versions'
import { DEVICE_WIDTH, webExport, webReactExport, type Device } from '@shared/web'
import { DesignChat, parseSource, sourceKey } from '@/components/design/DesignChat'
import { ConceptBoard } from '@/components/design/ConceptBoard'
import { CanvasCapture } from '@/components/design/CanvasCapture'
import { ComfyWebDialog } from '@/components/design/ComfyWeb'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import type { ChatRun } from '@/components/tasks/ChatModelPicker'
import { DesignProjectDialog } from '@/components/design/DesignProjectDialog'
import { DesignProjectHome } from '@/components/design/DesignProjectHome'
import { DESIGN_HOME } from '@/lib/design-projects'
import { setTree, treeOf, useDesignEditor } from '@/components/design/useDesignEditor'
import type { RenderImage } from '@/components/design/umg-render'
import { SaveStyleButton, StyleLibraryList } from '@/components/design/StyleLibrary'
import { t } from '@shared/i18n'

const ANIM_KEY = 'agent-panel:design-anim'

export function DesignPage() {
  const { route } = useNav()
  // 'home' 是 UI 项目主页（项目 id 在 sub），'new' 和没给 id 是新建设计，其余 id 是设计器
  if (route.id === DESIGN_HOME) return <DesignProjectHome key={route.sub} projectId={route.sub ?? ''} />
  return route.id && route.id !== 'new' ? (
    <Designer key={route.id} id={route.id} />
  ) : (
    <NewDesign projectId={route.sub} />
  )
}

// ---- 新建设计 ----

const SIZES = [
  { v: '1920x1080', label: '1920 × 1080（16:9）' },
  { v: '2560x1440', label: '2560 × 1440（16:9）' },
  { v: '1280x720', label: '1280 × 720（16:9）' },
  { v: '2340x1080', label: '2340 × 1080（手机横屏）' },
  { v: '1080x1920', label: '1080 × 1920（竖屏）' },
]
/** 网页的常用尺寸：桌面、笔记本、平板、手机 */
const WEB_SIZES = [
  { v: '1440x900', label: '1440 × 900（桌面）' },
  { v: '1280x800', label: '1280 × 800（笔记本）' },
  { v: '1920x1080', label: '1920 × 1080（大屏）' },
  { v: '768x1024', label: '768 × 1024（平板）' },
  { v: '390x844', label: '390 × 844（手机）' },
]

function NewDesign({ projectId }: { projectId?: string }) {
  const { designProjects: projects, setDesigns } = useData()
  const { go } = useNav()
  const [creatingProject, setCreatingProject] = useState(false)
  const [pid, setPid] = useState(projectId || projects[0]?.id || '')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<'game' | 'web'>('game')
  const [size, setSize] = useState('1920x1080')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!pid && projects[0]) setPid(projects[0].id)
  }, [pid, projects])
  useEffect(() => {
    if (projectId) setPid(projectId)
  }, [projectId])

  const create = async () => {
    const [X, Y] = size.split('x').map(Number)
    setBusy(true)
    try {
      const d = await api.createDesign({
        projectId: pid,
        kind,
        title: title.trim() || t('未命名界面'),
        designSize: { X, Y },
      })
      setDesigns((list) => [
        ...list,
        {
          id: d.id,
          projectId: d.projectId,
          kind: d.kind,
          title: d.title,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        },
      ])
      go({ page: 'design', id: d.id })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-12 md:py-20">
      <div className="w-full max-w-[560px]">
        <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent-text">
          <PaletteIcon className="h-5 w-5" />
        </span>
        <h1 className="font-serif text-[1.625rem] font-semibold tracking-tight">{t('UI 设计')}</h1>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
          {kind === 'web'
            ? t(
                '用对话设计网页界面：AI 用自动布局搭好页面、生成插图和图标，最后导出成 HTML / CSS 和图片，直接用浏览器打开。',
              )
            : t(
                '用对话设计游戏界面：AI 搭好 UMG 控件树、生成每一张图片，最后导出成 WidgetTree 的 JSON 和贴图，导入 UE 生成 Widget Blueprint。',
              )}
        </p>
        <DesignProjectDialog open={creatingProject} onOpenChange={setCreatingProject} onSaved={(p) => setPid(p.id)} />
        {!projects.length ? (
          <div className="mt-8 rounded-xl bg-panel p-5 text-[0.8125rem] text-muted">
            {t('设计放在 UI 项目里（和 Agent 的项目分开）。先建一个项目吧，一般一个游戏一个项目。')}
            <Button className="mt-3" onClick={() => setCreatingProject(true)}>
              <Plus className="h-4 w-4" />
              {t('新建 UI 项目')}
            </Button>
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-5 rounded-2xl bg-card p-6 shadow-card">
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] font-medium">{t('名称')}</span>
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && pid && void create()}
                placeholder={kind === 'web' ? t('例如：首页、登录页、商品详情') : t('例如：主菜单、背包、战斗 HUD')}
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] font-medium">{t('类型')}</span>
              <Segmented
                label={t('类型')}
                value={kind}
                onChange={(k) => {
                  setKind(k)
                  setSize(k === 'web' ? WEB_SIZES[0].v : SIZES[0].v)
                }}
                options={[
                  { id: 'game', label: t('游戏 UI（UE5 UMG）') },
                  { id: 'web', label: t('网页 UI（HTML / CSS）') },
                ]}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-[0.8125rem] font-medium">{t('项目')}</span>
                <Select
                  aria-label={t('项目')}
                  value={pid}
                  onChange={(e) => (e.target.value === '+new' ? setCreatingProject(true) : setPid(e.target.value))}
                  options={[
                    ...projects.map((p) => ({ value: p.id, label: p.name })),
                    { value: '+new', label: t('新建 UI 项目…') },
                  ]}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[0.8125rem] font-medium">{t('设计尺寸')}</span>
                <Select
                  aria-label={t('设计尺寸')}
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  options={(kind === 'web' ? WEB_SIZES : SIZES).map((s) => ({ value: s.v, label: s.label }))}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void create()} disabled={busy || !pid}>
                {kind === 'web' ? <Globe className="h-4 w-4" /> : <Gamepad2 className="h-4 w-4" />}
                {t('开始设计')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---- 设计器 ----

/** 新放进 CanvasPanel 的控件的默认大小 */
const NEW_SIZE: Partial<Record<WidgetType, [number, number]>> = {
  Image: [128, 128],
  Button: [240, 64],
  ProgressBar: [320, 24],
  Slider: [240, 24],
  EditableTextBox: [280, 44],
  CheckBox: [160, 32],
  Border: [400, 300],
  CanvasPanel: [400, 300],
  Overlay: [300, 200],
  HorizontalBox: [400, 80],
  VerticalBox: [240, 320],
  UniformGridPanel: [400, 400],
  WrapBox: [400, 200],
  ScrollBox: [300, 400],
  SizeBox: [200, 100],
  ScaleBox: [200, 100],
  WidgetSwitcher: [300, 200],
  ListView: [400, 500],
  TileView: [560, 420],
  DynamicEntryBox: [300, 64],
  Spacer: [32, 32],
  UserWidget: [128, 128],
}

const SOURCE_KEY = 'design-image-source'
const COUNT_KEY = 'design-image-count'

// 复制的控件：放在模块里，切换到别的设计也能粘贴
let clipboard: Widget | null = null

function Designer({ id }: { id: string }) {
  const ed = useDesignEditor(id)
  const { designProjects: projects, setDesigns } = useData()
  const { go, openSettings } = useNav()
  const { doc, server } = ed
  const [target, setTarget] = useState('')
  const [selected, setSelected] = useState('')
  /** 效果图上按住 Shift / Ctrl 多选的其他控件，用来对齐、等间距；换树或普通点选时清掉 */
  const [extra, setExtra] = useState<string[]>([])
  /** 网页 UI 按哪个宽度预览；平板、手机时属性面板改的是这个宽度的断点 */
  const [device, setDevice] = useState<Device>('desktop')
  useEffect(() => setExtra([]), [target])
  const [hasClip, setHasClip] = useState(!!clipboard)
  /** 引用到 AI 对话的控件快照；发送后清掉 */
  const [cites, setCites] = useState<WidgetCitation[]>([])
  /** 画布右键「重命名」：让控件树里那一行进入改名状态 */
  const [renameRequest, setRenameRequest] = useState<{ id: string; at: number }>()
  const [tab, setTab] = useState<'tree' | 'images' | 'widgets'>('tree')
  const [imageSel, setImageSel] = useState('')
  /** 双击图片后在画布区域放大预览的图片 */
  const [preview, setPreview] = useState('')
  /** 正在和现在对比的版本 */
  const [compare, setCompare] = useState<DesignVersion>()
  /** 图上的修改标记和效果图的标注放在一起（target 是 img:<图片 id>），在右边对话框上面列出来，发送时一起发 */
  const imgTarget = (imgId: string) => `img:${imgId}`
  const [chatOpen, setChatOpen] = useState(true)
  const [deleting, setDeleting] = useState(false)
  // 生成图片的方式和每张几版：每个设计各自记住，在这个设计里改不影响别的设计
  const [source, setSource] = useScopedSetting<ImageSource>(SOURCE_KEY, id, (v) => parseSource(v ?? 'cli'), sourceKey)
  const [count, setCount] = useScopedSetting(COUNT_KEY, id, (v) => Math.max(1, Math.min(4, Number(v) || 1)), String)
  const [promptsOpen, setPromptsOpen] = useState(false)
  /** 左边显示原画还是界面；对照模板：把确认的原画半透明盖在界面上 */
  const [view, setView] = useState<'ui' | 'concept'>('ui')
  /** 主区域显示画板还是数据面板：数据面板改的是画板用的运行时假数据 */
  const [board, setBoard] = useState<'canvas' | 'data'>('canvas')
  const [overlay, setOverlay] = useState(false)
  /**
   * 左上角「画板 / 数据」切换（和「对照模板」）浮在画布上：量出它的宽度，写成 --board-switch-w 给画布、原画、
   * 对比、大图这几层的顶栏让位，免得画布窄时把标注工具栏左边几个工具、原画标题盖住
   */
  // 用回调 ref：设计还在加载时这块没画出来，挂上之后才开始量
  const [boardSwitch, setBoardSwitch] = useState<HTMLDivElement | null>(null)
  const [switchW, setSwitchW] = useState(0)
  useEffect(() => {
    if (!boardSwitch) return
    const ro = new ResizeObserver(() => setSwitchW(boardSwitch.offsetWidth))
    ro.observe(boardSwitch)
    return () => ro.disconnect()
  }, [boardSwitch])
  /** 只重绘原画上蒙版涂过的区域（对话侧勾选）：原画面板的发送按钮也要按它换文案 */
  const [inpaint, setInpaint] = useState(false)
  /** 替用户发的一条：id 变了就发一次。带 text 是固定发这句话（确认模板后开始搭界面）；`kind: 'send'` 是「发送标注给 AI」，按输入框发送 */
  const [request, setRequest] = useState<{ id: string; text?: string; kind?: 'send' }>()
  /** 动画面板（时间轴）开着没有，以及它让画布停在哪一刻 */
  const [animOpen, setAnimOpenState] = useState(() => {
    try {
      return localStorage.getItem(ANIM_KEY) !== '0'
    } catch {
      return true
    }
  })
  // 默认打开；关掉后记住，下次也不打开
  const setAnimOpen = (v: boolean) => {
    setAnimOpenState(v)
    try {
      localStorage.setItem(ANIM_KEY, v ? '1' : '0')
    } catch {
      // 存不了就只在这次有效
    }
  }
  // 正在从图片列表往画布上拖的图：画布高亮能放这张图的控件
  const [dragImage, setDragImage] = useState<DesignImage | null>(null)
  const [comfyWeb, setComfyWeb] = useState(false)
  const [animCommand, setAnimCommand] = useState<AnimCommand | null>(null)
  // 当前动画和播放头时间放在页面层：动画面板和属性面板的菱形按钮用同一份
  const [animName, setAnimName] = useState('')
  const [animTime, setAnimTime] = useState(0)
  // 换树（主界面 / 子控件）后从这棵树的第一条动画、第 0 秒开始
  useEffect(() => {
    setAnimName('')
    setAnimTime(0)
  }, [id, target])
  /** 已经交回的截图请求，不重复画 */
  const captured = useRef(new Set<string>())
  const [, setCaptureTick] = useState(0)
  // 控件树和对话栏可以拖动调整宽度，效果区占剩下的
  // 检查器默认 280：左边多了一条图标栏，比设计稿（300）收一点，把宽度留给夹在中间的画板
  const treePane = usePaneWidth('design-tree', 280, 220, 560)
  // 对话栏在画板左边，默认 320（照设计稿）；画板夹在两栏中间，对话栏太宽会把画板挤得很窄
  const chatPane = usePaneWidth('design-chat', 320, 280, 720)

  // AI 一步步改的时候，效果图和控件树显示已经收到的改动（还没存下，改完整体检查通过才存）
  const live = server?.job?.status === 'running' && server.job.phase === 'design' ? server.job.preview : undefined
  // 这一段显示的是这一轮的预览，不是本地保存的树：眼睛按钮先改在预览上（见 toggleVisible），
  // 这一轮结束后再落到保存的设计里，否则点了看起来没反应，结束时还会被 AI 的结果覆盖
  const [liveVis, setLiveVis] = useState<Record<string, string>>({})
  const pendingVis = useRef<Record<string, string>>({})
  const shownDoc =
    doc && live
      ? {
          ...doc,
          root: applyVisibility(live.root, liveVis),
          components: Object.keys(liveVis).length
            ? live.components.map((c) => ({ ...c, Root: applyVisibility(c.Root, liveVis) }))
            : live.components,
          data: live.data ?? doc.data,
        }
      : doc
  const tree = doc ? treeOf(doc, target) : undefined
  const shownTree = shownDoc ? (treeOf(shownDoc, target) ?? tree) : undefined
  // 子控件被删掉或改名了：回到主界面
  useEffect(() => {
    if (doc && target && !doc.components.some((c) => c.Name === target)) setTarget('')
  }, [doc, target])

  const fileUrl = (file: string) => designFileUrl(id, file)
  const imageUrl = (i: DesignImage) => {
    const v = i.variants[i.selected] ?? i.variants.at(-1)
    return v ? fileUrl(v.file) : undefined
  }
  const renderImages = useMemo(() => {
    const m = new Map<string, RenderImage>()
    for (const i of doc?.images ?? []) {
      const v = i.variants[i.selected] ?? i.variants.at(-1)
      if (v) m.set(i.id, { url: designFileUrl(id, v.file), width: v.width || i.width, height: v.height || i.height })
    }
    return m
  }, [doc?.images, id])
  const used = useMemo(
    () => (doc ? usedImages([doc.root, ...doc.components.map((c) => c.Root)]) : new Set<string>()),
    [doc],
  )

  // 出了新的原画、正在出原画时切到原画；确认了模板切回界面
  const concept = server?.concept ?? emptyConcept()
  const conceptCount = concept.images.length
  const conceptsRunning = server?.job?.status === 'running' && server.job.phase === 'concepts'
  useEffect(() => {
    if (conceptsRunning || (conceptCount && !concept.approved)) setView('concept')
    // 只在数量、阶段变化时自动切换，用户自己切了不打扰
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptCount, conceptsRunning])
  useEffect(() => {
    if (concept.approved) setView('ui')
  }, [concept.approved])
  // 原画上的蒙版被清掉了（发出去了、涂完了又撤销）：「只重绘蒙版」就失效，不能留着
  const conceptMaskReady = !!doc?.annotations.some((a) => hasMask(a) && a.target.startsWith('concept:'))
  useEffect(() => {
    if (!conceptMaskReady) setInpaint(false)
  }, [conceptMaskReady])

  const editTree = (fn: (root: Widget) => Widget, key = '') =>
    ed.change((d) => {
      const r = treeOf(d, target)
      if (!r) return d
      const n = fn(r)
      return n === r ? d : setTree(d, target, n)
    }, key)

  // AI 这一轮改完，页面换成服务端存下的树：把修改期间点的显示 / 隐藏补上去
  useEffect(() => {
    if (live || !Object.keys(pendingVis.current).length) return
    const vis = pendingVis.current
    pendingVis.current = {}
    setLiveVis({})
    // 预览期间可能切过子控件，点过的控件不都在当前这棵树上：按整份设计补
    ed.change((d) => {
      const root = applyVisibility(d.root, vis)
      const components = d.components.map((c) => {
        const r = applyVisibility(c.Root, vis)
        return r === c.Root ? c : { ...c, Root: r }
      })
      if (root === d.root && components.every((c, i) => c === d.components[i])) return d
      return { ...d, root, components }
    }, 'vis:ai')
    // 只在这一轮 AI 修改结束时补一次；ed.change 每次渲染都是新的对象，写进依赖会一直触发
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  const addWidget = (type: WidgetType, cls?: string, into?: string) => {
    if (!tree || !doc) return
    const sel = (into ?? selected) ? findWidget(tree, into ?? selected) : undefined
    let parent =
      sel && WIDGETS[sel.Type].children !== 'none' && (WIDGETS[sel.Type].children === 'many' || !sel.Children?.length)
        ? sel
        : undefined
    let index: number | undefined
    if (!parent && sel) {
      const p = findParent(tree, sel.id)
      if (p && (WIDGETS[p.Type].children === 'many' || !p.Children?.length)) {
        parent = p
        index = p.Children!.findIndex((c) => c.id === sel.id) + 1
      }
    }
    parent ??= tree
    if (
      WIDGETS[parent.Type].children === 'none' ||
      (WIDGETS[parent.Type].children === 'one' && parent.Children?.length)
    )
      return toast.error(t('{name} 里不能再放控件了', { name: parent.Name }))
    const names = allNames(tree)
    const name = uniqueName(type === 'UserWidget' && cls ? cls.replace(/^WBP_/, '') : type, names)
    const n = parent.Children?.length ?? 0
    const [w, h] = NEW_SIZE[type] ?? [200, 50]
    const slotType = WIDGETS[parent.Type].slot
    const slot = defaultSlot(slotType, 40 + (n % 10) * 16, 40 + (n % 10) * 16, w, h)
    // 文字默认按控件宽度换行（WIDGETS.TextBlock 的默认值），也不再自动撑开：
    // 以前这里给 TextBlock 设 bAutoSize=true，宽高由文字撑开，会顶出父控件、压到背景的装饰上
    const wd = newWidget(type, name, slot)
    if (type === 'UserWidget') wd.Class = cls
    editTree((r) => insertWidget(r, parent!.id, wd, index))
    setSelected(wd.id)
    setTab('tree')
  }

  /** 按住 Shift / Ctrl 点（效果图或控件树）：加进多选；再点一次已选的就取消它 */
  const pick = (wid: string) => {
    if (wid === selected) {
      setSelected(extra.at(-1) ?? '')
      setExtra(extra.slice(0, -1))
    } else if (extra.includes(wid)) setExtra(extra.filter((x) => x !== wid))
    else {
      if (selected) setExtra([...extra.filter((x) => x !== selected), selected])
      setSelected(wid)
    }
    setTab('tree')
  }

  /** 把控件当时的样子引用到 AI 对话：名字、路径、尺寸、用到的图和文字都存成快照 */
  const citeWidget = (wid: string) => {
    if (!tree || !doc) return
    const w = findWidget(tree, wid)
    if (!w) return
    const el = document.querySelector<HTMLElement>(`[data-wid="${CSS.escape(wid)}"]`)
    const off = w.Slot?.LayoutData?.Offsets
    const textOf = (x: Widget): string => {
      const own = x.Properties?.Text ?? x.Properties?.HintText ?? x.Properties?.Placeholder
      if (typeof own === 'string' && own.trim()) return own.trim()
      for (const c of x.Children ?? []) {
        const v = textOf(c)
        if (v) return v
      }
      return ''
    }
    const imgs = [...usedImages([w])].map((imgId) => {
      const im = doc.images.find((i) => i.id === imgId)
      return im ? `${im.name}（img:${imgId}）` : `img:${imgId}`
    })
    const next: WidgetCitation = {
      id: crypto.randomUUID(),
      widgetId: wid,
      name: w.Name,
      type: w.Type,
      target,
      path: pathTo(tree, wid)
        .map((x) => x.Name)
        .join(' / '),
      width: Math.round(el?.offsetWidth || Number(off?.Right) || 0),
      height: Math.round(el?.offsetHeight || Number(off?.Bottom) || 0),
      image: imgs.length ? imgs.join('、') : '',
      text: textOf(w),
    }
    // 同一个控件再引用一次就换成最新的快照
    setCites((list) => [...list.filter((x) => !(x.widgetId === wid && x.target === target)), next])
    setChatOpen(true)
  }

  const actions: WidgetMenuActions = {
    select: (wid) => {
      setSelected(wid)
      setExtra([])
    },
    rename: (wid, name) =>
      ed.change((d) => {
        const r = treeOf(d, target)
        const old = r && findWidget(r, wid)?.Name
        if (!r || !old) return d
        const names = allNames(r)
        names.delete(old)
        const next = uniqueName(name, names)
        // 动画里引用这个控件的轨道跟着改名
        return {
          ...setTree(
            d,
            target,
            mapWidget(r, wid, (w) => ({ ...w, Name: next })),
          ),
          animations: renameInAnimations(d.animations ?? [], target, old, next),
        }
      }),
    move: (wid, pid, index) => editTree((r) => moveWidget(r, wid, pid, index)),
    remove: (wid) => {
      editTree((r) => removeWidget(r, wid))
      if (wid === selected) setSelected('')
    },
    duplicate: (wid) => {
      if (!tree) return
      const w = findWidget(tree, wid)
      const p = findParent(tree, wid)
      if (!w || !p) return
      if (WIDGETS[p.Type].children !== 'many') return toast.error(t('{name} 只能放一个子控件', { name: p.Name }))
      const c = cloneWidget(w, allNames(tree))
      // 在画布里错开一点，免得完全叠在一起
      if (c.Slot?.LayoutData)
        c.Slot = {
          ...c.Slot,
          LayoutData: {
            ...c.Slot.LayoutData,
            Offsets: {
              ...c.Slot.LayoutData.Offsets,
              Left: c.Slot.LayoutData.Offsets.Left + 16,
              Top: c.Slot.LayoutData.Offsets.Top + 16,
            },
          },
        }
      editTree((r) => insertWidget(r, p.id, c, p.Children!.findIndex((x) => x.id === wid) + 1))
      setSelected(c.id)
    },
    toggleVisible: (wid) => {
      const shown = shownTree ?? tree
      const w = shown && findWidget(shown, wid)
      if (!w) return
      const next = toggledVisibility(w.Properties?.Visibility)
      // AI 修改期间画板和控件树显示的是预览：先记在预览上，这一轮结束后再落进保存的设计
      if (live) {
        pendingVis.current = { ...pendingVis.current, [wid]: next }
        setLiveVis(pendingVis.current)
        return
      }
      editTree((r) => mapWidget(r, wid, (x) => ({ ...x, Properties: { ...x.Properties, Visibility: next } })))
    },
    copy: (wid) => {
      const w = tree && findWidget(tree, wid)
      if (!w) return
      clipboard = structuredClone(w)
      setHasClip(true)
    },
    cut: (wid) => {
      actions.copy(wid)
      actions.remove(wid)
    },
    canPaste: hasClip,
    paste: (wid) => {
      if (!tree || !clipboard) return
      const target = findWidget(tree, wid)
      if (!target) return
      const into = canAddChild(target)
      const parent = into ? target : findParent(tree, wid)
      if (!parent || !canAddChild(parent))
        return toast.error(t('{name} 里不能再放控件了', { name: (parent ?? target).Name }))
      const c = cloneWidget(clipboard, allNames(tree))
      const index = into ? undefined : parent.Children!.findIndex((x) => x.id === wid) + 1
      editTree((r) => insertWidget(r, parent.id, c, index))
      setSelected(c.id)
    },
    addChild: (pid, type, cls) => addWidget(type, cls, pid),
    wrap: (wid, type) => {
      if (!tree) return
      const res = wrapWidget(tree, wid, type, allNames(tree))
      // 新面板的 id 是随机的，树没变时直接用算好的结果，才能选中它
      editTree((r) => (r === tree ? res.root : wrapWidget(r, wid, type, allNames(r)).root))
      setSelected(res.id)
    },
    replace: (wid, type) => editTree((r) => replaceWidget(r, wid, type)),
    components: doc?.components.filter((c) => c.Name !== target).map((c) => c.Name) ?? [],
    extract: (wid) => {
      if (!tree || !doc) return
      const w = findWidget(tree, wid)
      if (!w) return
      const el = document.querySelector<HTMLElement>(`[data-wid="${CSS.escape(wid)}"]`)
      const size = { X: Math.round(el?.offsetWidth || 128), Y: Math.round(el?.offsetHeight || 128) }
      const name = uniqueName(`WBP_${w.Name}`, new Set(doc.components.map((c) => c.Name)))
      const { Slot, ...rest } = w
      const inst: Widget = { ...newWidget('UserWidget', uniqueName(w.Name, new Set()), Slot), id: w.id, Class: name }
      ed.change((d) => {
        const r = treeOf(d, target)!
        const nr = mapWidget(r, wid, () => inst)
        return {
          ...setTree(d, target, nr),
          components: [...d.components, { Name: name, DesignSize: size, Root: rest }],
        }
      })
      toast.success(t('已提取成子控件 {name}', { name }))
    },
    lock: (wid) =>
      editTree((r) =>
        mapWidget(r, wid, (w) => ({ ...w, Properties: { ...w.Properties, Locked: !w.Properties.Locked } })),
      ),
    layer: (wid, how: WidgetLayer) =>
      editTree((r) => {
        const w = findWidget(r, wid)
        const p = findParent(r, wid)
        if (!w || !p) return r
        // 画布里的控件按 ZOrder 叠放；其他面板按子控件的先后顺序
        if (p.Type === 'CanvasPanel' && w.Slot) {
          const zs = p.Children!.map((c) => Number(c.Slot?.ZOrder) || 0)
          const z = Number(w.Slot.ZOrder) || 0
          const next =
            how === 'top' ? Math.max(...zs) + 1 : how === 'bottom' ? Math.min(...zs) - 1 : z + (how === 'up' ? 1 : -1)
          return mapWidget(r, wid, (x) => ({ ...x, Slot: { ...x.Slot, ZOrder: next } }))
        }
        const from = p.Children!.findIndex((c) => c.id === wid)
        const index =
          how === 'up' ? Math.max(0, from - 1) : how === 'down' ? from + 2 : how === 'top' ? 0 : p.Children!.length
        return moveWidget(r, wid, p.id, index)
      }),
    cite: citeWidget,
  }

  const onMove = (wid: string, d: { dx: number; dy: number; mode: 'move' | 'resize' }, key: string) =>
    editTree(
      (r) =>
        mapWidget(r, wid, (w) => {
          if (w.Properties?.Locked) return w
          const L = w.Slot?.LayoutData
          if (!L) return w
          const o = { ...L.Offsets }
          const sx = L.Anchors.Minimum.X !== L.Anchors.Maximum.X
          const sy = L.Anchors.Minimum.Y !== L.Anchors.Maximum.Y
          if (d.mode === 'move') {
            o.Left += d.dx
            o.Top += d.dy
            if (sx) o.Right -= d.dx
            if (sy) o.Bottom -= d.dy
          } else {
            // 拉伸的方向改右 / 下边距，不拉伸的改宽高（对齐点不是左上时位置跟着补偿）；
            // 缩到 MIN_WIDGET_SIZE 就停住，不出现负尺寸或翻转
            return { ...w, Slot: resizeCanvasSlot(w.Slot!, d.dx, d.dy) }
          }
          return { ...w, Slot: { ...w.Slot, LayoutData: { ...L, Offsets: o } } }
        }),
      key,
    )

  // 键盘：删除、撤销 / 重做、复制
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) ed.redo()
        else ed.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        ed.redo()
      } else if (mod && e.key.toLowerCase() === 'd' && selected) {
        e.preventDefault()
        actions.duplicate(selected)
      } else if (mod && e.key.toLowerCase() === 'c' && selected && !window.getSelection()?.toString()) {
        e.preventDefault()
        actions.copy(selected)
      } else if (mod && e.key.toLowerCase() === 'x' && selected && tree && selected !== tree.id) {
        e.preventDefault()
        actions.cut(selected)
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard && tree) {
        e.preventDefault()
        actions.paste(selected || tree.id)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && tree && selected !== tree.id) {
        e.preventDefault()
        // 多选时一起删（一次撤销全部退回）
        const ids = [selected, ...extra].filter((x) => x !== tree.id)
        if (ids.length > 1) {
          editTree((r) => ids.reduce((acc, x) => removeWidget(acc, x), r), `rm:${ids.join(',')}`)
          setSelected('')
          setExtra([])
        } else actions.remove(selected)
      } else if (e.key.startsWith('Arrow') && selected && !mod) {
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        if (tree && findWidget(tree, selected)?.Slot?.LayoutData) {
          e.preventDefault()
          onMove(selected, { dx, dy, mode: 'move' }, `key:${selected}`)
        }
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  if (ed.error)
    return (
      // 打开的设计是 splitPage，外面没有面板：出错和加载中的占位自己是一块面板
      <div className="panel grid flex-1 place-items-center p-8 text-center text-[0.8125rem] text-muted">
        <div>
          <p>{ed.error}</p>
          <Button variant="ghost" className="mt-3" onClick={() => go({ page: 'design' })}>
            {t('返回')}
          </Button>
        </div>
      </div>
    )
  if (!doc || !server || !tree) return <div className="panel flex-1" />

  const selWidget = selected ? findWidget(tree, selected) : undefined
  const selParent = selWidget ? findParent(tree, selWidget.id) : undefined
  // 当前这条树上的动画（页面保存的选中名，找不到就用第一条），属性面板按它的播放头打关键帧
  const treeAnims = (doc.animations ?? []).filter((a) => a.in === target)
  const curAnim = treeAnims.find((a) => a.name === animName) ?? treeAnims[0]
  const pinKey = (prop: AnimProp, v: AnimValue) => {
    if (!selWidget || !curAnim) return
    ed.change(
      (d) => ({
        ...d,
        animations: (d.animations ?? []).map((a) =>
          a.in === curAnim.in && a.name === curAnim.name ? setKeyAt(a, selWidget.Name, prop, animTime, v) : a,
        ),
      }),
      `anim:${curAnim.in}:${curAnim.name}:${selWidget.Name}:${prop}:${animTime}`,
    )
  }
  const selImage = doc.images.find((i) => i.id === imageSel)
  // 主界面和每个子控件各是一棵树：找图用在哪、能用到哪些控件上
  const trees = [{ target: '', root: doc.root }, ...doc.components.map((c) => ({ target: c.Name, root: c.Root }))]
  const imageSlots: WidgetRef[] = []
  for (const tr of trees)
    walk(tr.root, (w) => {
      if (IMAGE_SLOT[w.Type]) imageSlots.push({ target: tr.target, id: w.id, name: w.Name, type: w.Type })
    })
  const jumpTo = (w: WidgetRef) => {
    setTarget(w.target)
    setSelected(w.id)
    setTab('tree')
  }
  const project = projects.find((p) => p.id === server.projectId)
  const designSize = target
    ? (doc.components.find((c) => c.Name === target)?.DesignSize ?? doc.designSize)
    : doc.designSize
  // 网页的主界面按选的宽度预览（高度用常见设备的高度）；子控件照旧按自己的尺寸
  const viewSize =
    server.kind === 'web' && !target && device !== 'desktop'
      ? { X: DEVICE_WIDTH[device], Y: device === 'tablet' ? 1024 : 844 }
      : designSize

  const setImage = (img: DesignImage, key: string) =>
    ed.change((d) => ({ ...d, images: d.images.map((i) => (i.id === img.id ? img : i)) }), key)

  const upload = async (files: File[], imageId?: string) => {
    for (const f of files) {
      try {
        const res = await api.uploadDesignImage(id, { data: await readFile(f), name: f.name, imageId })
        ed.absorb(res)
        if (!imageId) {
          const added = res.images.at(-1)
          if (added) {
            setImageSel(added.id)
            setTab('images')
          }
        }
      } catch (e) {
        toast.error((e as Error).message)
      }
    }
  }

  const generate = async (img: DesignImage) => {
    if (source.kind === 'none') return toast.error(t('先在对话框下面选生成图片的方式'))
    const marks = doc.annotations.filter((a) => a.target === imgTarget(img.id))
    const ok = await regenerate(img, '', marks, {
      ...doc,
      annotations: doc.annotations.filter((a) => !marks.includes(a)),
    })
    if (ok && marks.length)
      ed.change((d) => ({ ...d, annotations: d.annotations.filter((a) => !marks.includes(a)) }), 'ann:sent')
  }

  /** 按修改意见（对话框里写的）和图上的标记重新生成一张图；next 是先保存上去的设计 */
  const regenerate = async (img: DesignImage, feedback: string, marks: Annotation[], next = doc) => {
    const v = img.variants[img.selected] ?? img.variants.at(-1)
    const revision = imageRevisionText(feedback, marks, { X: v?.width || img.width, Y: v?.height || img.height })
    try {
      // 先保存当前的描述和尺寸，服务端按保存的生成
      ed.absorb(await api.saveDesign(id, next))
      ed.absorb(await api.generateDesignImage(id, img.id, { source, count, revision: revision || undefined }))
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    }
  }

  const send = async (
    text: string,
    run: ChatRun,
    attachments: Attachment[],
    extra: {
      askUser: boolean
      style?: string
      styleName?: string
      answers?: { question: string; answer: string }[]
      concept: boolean
      inpaint?: boolean
      /** 「先出原画」时一次出几张，和每张图生成几版分开 */
      conceptCount?: number
      refs?: WidgetCitation[]
    },
  ) => {
    // 这一轮还在跑：走补充的通道，能插话就交给这一轮，收不下就在这一轮结束后自动接着处理
    const running = server?.job?.status === 'running'
    // 只重绘蒙版：本机 ComfyUI 按蒙版做真正的局部重绘；别的生图方式只能整张重画，先告诉用户再照常发送
    if (extra.inpaint && !running) {
      const mark = doc.annotations.find((a) => a.shape === 'mask' && a.target.startsWith('concept:') && hasMask(a))
      if (mark) {
        if (source.kind !== 'local') {
          toast(t('当前生成方式不支持局部重绘，已改成整张重画'))
        } else {
          const cid = mark.target.slice('concept:'.length)
          try {
            ed.absorb(await api.saveDesign(id, doc))
            ed.absorb(
              await api.inpaintConcept(id, {
                id: cid,
                mask: mark,
                text: text.trim(),
                source,
              }),
            )
            ed.change((d) => ({ ...d, annotations: d.annotations.filter((a) => a.id !== mark.id) }), 'ann:sent')
            toast.success(t('已按蒙版局部重绘，新的一张在原画里'))
            return true
          } catch (e) {
            toast.error((e as Error).message)
            return false
          }
        }
      }
    }
    // 图上的标记：这条消息就是这些图的修改意见，按它重新生成，不用让 AI 改设计。
    // 这一轮正在跑时生成不了，标记随消息一起交给这一轮
    const imgMarks = doc.annotations.filter((a) => a.target.startsWith('img:'))
    const annotations = running ? doc.annotations : doc.annotations.filter((a) => !a.target.startsWith('img:'))
    if (imgMarks.length && !running) {
      if (source.kind === 'none') {
        toast.error(t('先在对话框下面选生成图片的方式'))
        return false
      }
      const next = { ...doc, annotations }
      for (const imgId of new Set(imgMarks.map((a) => a.target.slice(4)))) {
        const img = doc.images.find((i) => i.id === imgId)
        if (!img) continue
        if (
          !(await regenerate(
            img,
            text,
            imgMarks.filter((a) => a.target === imgTarget(imgId)),
            next,
          ))
        )
          return false
      }
      ed.change((d) => ({ ...d, annotations: d.annotations.filter((a) => !a.target.startsWith('img:')) }), 'ann:sent')
      toast.success(t('已按标记重新生成图片'))
      // 没有效果图上的标注、也没有附件时，这条消息只是图片的修改意见
      if (!annotations.length && !attachments.length) return true
    }
    // 标注随这条消息一起发出，发出后从效果图上清掉
    const next = { ...doc, annotations: [] }
    try {
      // 这一轮还在跑时不再回写页面状态：AI 正在改，写回去可能盖掉它刚改的部分
      if (!running) ed.absorb(await api.saveDesign(id, next))
      const body = {
        text:
          text.trim() ||
          (annotations.length ? t('按标注修改') : attachments.length ? t('参考附件') : t('分析引用的控件')),
        source,
        count,
        annotations,
        attachments,
        refs: extra.refs ?? [],
        run,
        ...extra,
        // 原画张数没给时沿用「每张几版」，和以前一样；不能让它被 extra 里的 undefined 覆盖
        conceptCount: extra.conceptCount ?? count,
      }
      const sent = running ? await api.steerDesign(id, body) : undefined
      ed.absorb(sent ?? (await api.designChat(id, body)))
      if (annotations.length) ed.change((d) => ({ ...d, annotations: [] }), 'ann:sent')
      // 运行中发的消息要告诉用户去了哪里：插进了这一轮，还是等这一轮结束自动接着处理
      if (sent) {
        if (sent.steered) toast.success(t('已补充给正在进行的这一轮'))
        else toast.success(t('这一轮收不下，结束后自动接着处理'))
      }
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    }
  }

  /** 点「AI 分析」：先保存当前改动，再走同一条对话通道做只读检查，不改设计、不生成图片 */
  const analyze = async (run: ChatRun) => {
    try {
      ed.absorb(await api.saveDesign(id, doc))
      ed.absorb(
        await api.designChat(id, {
          text: t('分析当前设计'),
          source: { kind: 'none' },
          count,
          conceptCount: count,
          annotations: [],
          attachments: [],
          refs: [],
          run,
          askUser: false,
          concept: false,
          mode: 'analyze',
        }),
      )
      return true
    } catch (e) {
      // 分析失败也要让用户看到原因；服务端还会在对话里补一条错误消息
      toast.error((e as Error).message)
      return false
    }
  }

  // ---- 原画 ----
  const conceptUrl = (c: ConceptImage) => designFileUrl(id, c.file)
  const approvedConcept = concept.images.find((i) => i.id === concept.approved)
  const conceptAction = async (action: 'select' | 'approve' | 'remove', cid: string) => {
    try {
      ed.absorb(await api.designConcept(id, action, cid))
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    }
  }
  const approve = async (cid: string) => {
    if (!(await conceptAction('approve', cid)) || !cid) return
    // 原画上的标注用不上了；确认后马上让 AI 照着模板搭界面
    ed.change((d) => ({ ...d, annotations: d.annotations.filter((a) => !a.target.startsWith('concept:')) }), 'ann:sent')
    setView('ui')
    setOverlay(false)
    setRequest({ id: crypto.randomUUID(), text: t('按确认的原画模板搭界面，并生成切图') })
  }

  const exportFile = async (format: 'zip' | 'json' | 'react') => {
    try {
      ed.absorb(await api.saveDesign(id, doc))
    } catch (e) {
      return toast.error((e as Error).message)
    }
    if (import.meta.env.VITE_DEMO)
      return server.kind === 'web' ? demoWebExport(doc, format === 'react') : demoExport(doc)
    const a = document.createElement('a')
    a.href = designExportUrl(id, format)
    a.click()
  }

  const sourceLabel =
    source.kind === 'cli' ? t('用设置里的图片模型生成') : source.kind === 'browser' ? t('用选中的浏览器标签页生成') : ''

  const removeDesign = async () => {
    try {
      await api.deleteDesign(id)
      setDesigns((l) => l.filter((x) => x.id !== id))
      go({ page: 'design' })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // 设计名和保存状态：对话栏开着时放在对话栏的标题行（照设计稿，对话的标题就是这个设计），收起时回到画板标题行
  const titleField = (
    <>
      <input
        aria-label={t('设计名称')}
        value={doc.title}
        onChange={(e) => ed.change((d) => ({ ...d, title: e.target.value }), 'title')}
        className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[0.8125rem] font-semibold outline-none hover:bg-sel/60 focus:bg-field focus:ring-1 focus:ring-focus"
      />
      <SaveIndicator status={ed.save.status} error={ed.save.error} />
    </>
  )

  return (
    // 对话 / 画板 / 检查器三块圆角面板并排，中间露出 8px 底色（照设计稿 Design.dc.html）；
    // App 里把打开的设计算作 splitPage，外面不再套一整块面板
    <div className="flex min-h-0 min-w-0 flex-1">
      {chatOpen && (
        <aside
          aria-label={t('AI 对话')}
          style={{ width: chatPane.width }}
          className="panel relative flex shrink-0 flex-col"
        >
          <ResizeHandle pane={chatPane} side="right" label={t('拖动调整 AI 对话的宽度')} />
          <div className="flex h-[46px] shrink-0 items-center gap-1.5 border-b pr-2 pl-2">
            {titleField}
            <span className="shrink-0 text-[0.6875rem] text-subtle">{t('AI 对话')}</span>
            {/* 收起按钮放在对话栏自己的标题行：画板标题行夹在两栏中间，位置要留给阶段条和导出 */}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('收起 AI 对话')}
              title={t('收起 AI 对话')}
              onClick={() => setChatOpen(false)}
              className="shrink-0"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          <DesignChat
            messages={server.messages}
            job={server.job}
            source={source}
            onSource={setSource}
            count={count}
            onCount={setCount}
            onSend={send}
            onAnalyze={analyze}
            onStop={() => void api.stopDesign(id).then(() => ed.reload())}
            kind={server.kind}
            designId={id}
            dir={project?.path}
            onRetry={async (imageId) => {
              try {
                ed.absorb(await api.retryDesignImage(id, imageId, { source, count }))
              } catch (e) {
                toast.error((e as Error).message)
              }
            }}
            annotations={doc.annotations}
            onRemoveAnnotation={(aid) =>
              ed.change((d) => ({ ...d, annotations: d.annotations.filter((a) => a.id !== aid) }), `ann:rm:${aid}`)
            }
            cites={cites}
            onRemoveCite={(cid) => setCites((list) => list.filter((c) => c.id !== cid))}
            onClearCites={() => setCites([])}
            hasTemplate={!!concept.approved}
            request={request}
            inpaint={inpaint}
            onInpaint={setInpaint}
            conceptDefault={server.kind === 'game' && !doc.root.Children?.length && !server.messages.length}
          />
        </aside>
      )}

      <main className="panel flex min-w-0 flex-1 flex-col">
        {/* 画板标题行：@container 让它窄的时候（两边面板都开着）把次要按钮上的字收起来只留图标；
            实在放不下时横向滚动兜底，不把按钮挤成两行 */}
        <header className="@container flex h-[46px] shrink-0 items-center gap-1 overflow-x-auto border-b px-2 [scrollbar-width:none]">
          {!chatOpen && (
            <div className="flex min-w-[160px] flex-1 items-center gap-1.5">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('打开 AI 对话')}
                title={t('打开 AI 对话')}
                onClick={() => setChatOpen(true)}
                className="shrink-0"
              >
                <MessageSquare className="h-4 w-4" />
              </Button>
              {project && <span className="shrink-0 truncate text-[0.75rem] text-subtle">{project.name} /</span>}
              {titleField}
            </div>
          )}
          {(conceptCount > 0 || conceptsRunning) && (
            <StageSteps value={view} onChange={setView} conceptDone={!!approvedConcept} />
          )}
          {chatOpen && <span className="flex-1" />}
          <SizeButton doc={doc} onChange={(designSize) => ed.change((d) => ({ ...d, designSize }), 'size')} />
          <StyleButton
            value={doc.style}
            onChange={(style) => ed.change((d) => ({ ...d, style }), 'style')}
            prompts={project?.prompts.filter((p) => p.enabled).length ?? 0}
            onPrompts={() => setPromptsOpen(true)}
            designId={id}
            kind={server.kind}
            beforeExtract={ed.flush}
          />
          {project && (
            <DesignProjectDialog open={promptsOpen} onOpenChange={setPromptsOpen} project={project} section="prompts" />
          )}
          <VersionsButton
            designId={id}
            beforeSave={async () => {
              ed.absorb(await api.saveDesign(id, doc))
            }}
            onRestored={(d) => {
              ed.absorb(d)
              setCompare(undefined)
            }}
            onCompare={setCompare}
          />
          <div className="flex shrink-0 items-center">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('撤销')}
              title={t('撤销（Ctrl+Z）')}
              disabled={!ed.canUndo}
              onClick={ed.undo}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('重做')}
              title={t('重做（Ctrl+Shift+Z）')}
              disabled={!ed.canRedo}
              onClick={ed.redo}
            >
              <Redo2 className="h-4 w-4" />
            </Button>
          </div>
          {/* 动画和本机 ComfyUI 收进一个「更多」菜单：画板夹在对话栏和检查器中间，标题行放不下一排文字按钮
              （照设计稿，这一行只留阶段、尺寸和主操作）。动画面板自己也有关闭按钮 */}
          <Menu>
            <MenuTrigger asChild>
              <Button
                size="icon-sm"
                variant={animOpen ? 'secondary' : 'ghost'}
                aria-label={t('更多操作')}
                title={t('动画、本机 ComfyUI')}
                className="shrink-0"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => setAnimOpen(!animOpen)}>
                <Clapperboard className="h-4 w-4" />
                <span className="flex-1">{animOpen ? t('收起动画面板') : t('动画')}</span>
                {(doc.animations?.length ?? 0) > 0 && (
                  <span className="text-[0.6875rem] text-subtle tabular-nums">{doc.animations!.length}</span>
                )}
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => go({ page: 'comfy', id: server.kind === 'web' ? 'web' : 'game' })}>
                <Workflow className="h-4 w-4" />
                {server.kind === 'web' ? t('网页工作流管理') : t('游戏工作流管理')}
              </MenuItem>
              <MenuItem onSelect={() => setComfyWeb(true)}>
                <Globe className="h-4 w-4" />
                {t('打开 ComfyUI 网页')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => openSettings('local-image')}>
                <Settings2 className="h-4 w-4" />
                {t('本机生图设置')}
              </MenuItem>
            </MenuContent>
          </Menu>
          <ComfyWebDialog open={comfyWeb} onOpenChange={setComfyWeb} />
          <Menu>
            <MenuTrigger asChild>
              {/* 导出是这一页的主操作：照设计稿用前景色实底按钮，颜色取 token，深色主题下自动反过来 */}
              <Button size="sm" className="ml-1 h-[30px] gap-1 bg-fg px-3 font-semibold text-bg">
                <Download className="h-3.5 w-3.5" />
                {t('导出')}
                <ChevronDown className="h-3 w-3 opacity-70" />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void exportFile('zip')}>
                <FileArchive className="h-4 w-4" />
                {server.kind === 'web' ? t('ZIP（HTML + 图片文件）') : t('ZIP（JSON + 贴图文件）')}
              </MenuItem>
              <MenuItem onSelect={() => void exportFile('json')}>
                <FileJson className="h-4 w-4" />
                {server.kind === 'web' ? t('单个 HTML（图片内嵌）') : t('单个 JSON（贴图内嵌）')}
              </MenuItem>
              {server.kind === 'web' && (
                <MenuItem onSelect={() => void exportFile('react')}>
                  <FileCode2 className="h-4 w-4" />
                  {t('React + Tailwind 组件（ZIP）')}
                </MenuItem>
              )}
              {!import.meta.env.VITE_DEMO && (
                <MenuItem
                  disabled={!project?.path}
                  onSelect={async () => {
                    try {
                      ed.absorb(await api.saveDesign(id, doc))
                      const r = await api.exportDesignToProject(id)
                      toast.success(t('已导出到 {dir}', { dir: r.dir }))
                    } catch (e) {
                      toast.error((e as Error).message)
                    }
                  }}
                >
                  <FolderDown className="h-4 w-4" />
                  {t('导出到项目目录')}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem danger onSelect={() => setDeleting(true)}>
                <Trash2 className="h-4 w-4" />
                {t('删除这个设计')}
              </MenuItem>
            </MenuContent>
          </Menu>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className="relative flex min-h-0 min-w-0 flex-1"
            // 12px 是切换按钮离左边的距离（left-3），再留 8px 空隙
            style={{ '--board-switch-w': switchW ? `${switchW + 20}px` : '0px' } as React.CSSProperties}
          >
            <Viewport
              actions={actions}
              onRename={(wid) => {
                setSelected(wid)
                setTab('tree')
                setRenameRequest({ id: wid, at: Date.now() })
              }}
              animations={shownDoc?.animations ?? doc.animations}
              animCommand={animOpen ? animCommand : null}
              dragImage={live ? null : dragImage}
              onDropImage={(wid, imgId) => {
                const img = doc.images.find((i) => i.id === imgId)
                if (!img) return
                editTree((r) => mapWidget(r, wid, (x) => assignImage(x, img)), `assign:${imgId}:${wid}`)
                setDragImage(null)
                setSelected(wid)
                setExtra([])
              }}
              root={shownTree ?? tree}
              size={viewSize}
              device={server.kind === 'web' ? device : undefined}
              onReorder={(wid, parentId, index) =>
                editTree((r) => moveWidget(r, wid, parentId, index), `reorder:${wid}:${Date.now()}`)
              }
              onNudge={(wid, dx, dy, key) =>
                editTree(
                  (r) =>
                    mapWidget(r, wid, (w) => {
                      // 贴在右边、下边时偏移是离右边、下边的距离：往右拖要变小
                      const pin = String(w.Slot?.Pin ?? 'top-left')
                      const sx = pin.endsWith('right') ? -1 : 1
                      const sy = pin.startsWith('bottom') ? -1 : 1
                      return {
                        ...w,
                        Slot: { ...w.Slot, X: (w.Slot?.X ?? 0) + sx * dx, Y: (w.Slot?.Y ?? 0) + sy * dy },
                      }
                    }),
                  key,
                )
              }
              images={renderImages}
              data={(shownDoc ?? doc).data ?? emptyData()}
              overlay={overlay && approvedConcept && !target ? conceptUrl(approvedConcept) : undefined}
              components={shownDoc?.components ?? doc.components}
              selected={selected}
              onSelect={(wid) => {
                setSelected(wid)
                setExtra([])
                if (wid) setTab('tree')
              }}
              extra={extra.filter((x) => x !== selected)}
              onPick={pick}
              onMove={onMove}
              annotations={doc.annotations}
              onAnnotations={(annotations, key) => ed.change((d) => ({ ...d, annotations }), key)}
              target={target}
              onOpen={(wid) => {
                const w = findWidget(tree, wid)
                if (!w) return
                // 子控件：进去编辑它；用了图片的：打开那张图
                if (w.Type === 'UserWidget' && w.Class && doc.components.some((c) => c.Name === w.Class)) {
                  setTarget(w.Class)
                  setSelected('')
                  return
                }
                const img = [...usedImages([{ ...w, Children: [] }])][0]
                if (img && doc.images.some((i) => i.id === img)) {
                  setImageSel(img)
                  setTab('images')
                }
              }}
            />
            {view === 'concept' && (conceptCount > 0 || conceptsRunning) && (
              <ConceptBoard
                concept={concept}
                url={conceptUrl}
                marks={doc.annotations.filter((a) => a.target.startsWith('concept:'))}
                onMarks={(cid, list) =>
                  ed.change(
                    (d) => ({
                      ...d,
                      annotations: [...d.annotations.filter((a) => a.target !== `concept:${cid}`), ...list],
                    }),
                    `ann:concept:${cid}`,
                  )
                }
                onSelect={(cid) => void conceptAction('select', cid)}
                onSendMarks={() => {
                  // 对话栏收起时 DesignChat 没挂载，request 没人消费：先打开对话栏再发，
                  // 不然点了看着像没反应（标注不消失、不出新原画）
                  setChatOpen(true)
                  setRequest({ id: crypto.randomUUID(), kind: 'send' })
                }}
                inpaint={inpaint}
                // 只有本机 ComfyUI 能真做局部重绘；别的生图方式勾了也是整张重画、全部标注都发
                inpaintSupported={source.kind === 'local'}
                onApprove={(cid) => void approve(cid)}
                onRemove={(cid) => void conceptAction('remove', cid)}
                onUpload={async (data) => {
                  try {
                    ed.absorb(await api.uploadConcept(id, data))
                  } catch (e) {
                    toast.error((e as Error).message)
                  }
                }}
                progress={conceptsRunning ? server.job?.concepts : undefined}
                busy={ed.running}
              />
            )}
            <div ref={setBoardSwitch} className="absolute top-3 left-3 z-50 flex items-center gap-2">
              <Segmented
                // 切到「数据」时下面是普通页面，跟着主题走；画板上才用深色画布的样子
                tone={board === 'canvas' ? 'canvas' : 'default'}
                size="sm"
                label={t('主区域显示')}
                value={board}
                onChange={setBoard}
                options={[
                  { id: 'canvas', label: t('画板'), icon: LayoutTemplate },
                  { id: 'data', label: t('数据'), icon: Database },
                ]}
                // 段内留白收窄一点：画布窄时它和居中的标注工具栏挨得很近
                className={cn('[&>button]:px-2', board === 'canvas' && 'shadow-pop')}
              />
              {board === 'canvas' && view === 'ui' && approvedConcept && !target && (
                <Button
                  variant="on-canvas"
                  size="sm"
                  onClick={() => setOverlay(!overlay)}
                  aria-pressed={overlay}
                  title={t('把确认的原画模板半透明盖在界面上，对照着调')}
                  className={cn('bg-canvas-bar shadow-pop', overlay && 'text-accent-text hover:text-accent-text')}
                >
                  <Layers className="h-3.5 w-3.5" />
                  {t('对照模板')}
                </Button>
              )}
            </div>
            {server.job?.status === 'running' && server.job.capture && !captured.current.has(server.job.capture.id) && (
              <CanvasCapture
                key={server.job.capture.id}
                designId={id}
                req={server.job.capture}
                images={renderImages}
                data={doc.data ?? emptyData()}
                web={server.kind === 'web'}
                onDone={(cid) => {
                  captured.current.add(cid)
                  setCaptureTick((n) => n + 1)
                }}
              />
            )}
            {board === 'data' && (
              // 顶部留出「画板 / 数据」切换按钮的位置，面板自己的工具栏从下面一行开始
              <div className="absolute inset-0 z-40 flex overflow-hidden bg-bg pt-12">
                <DataPanel
                  data={(shownDoc ?? doc).data ?? emptyData()}
                  root={shownDoc?.root ?? doc.root}
                  components={shownDoc?.components ?? doc.components}
                  images={doc.images}
                  imageUrl={imageUrl}
                  scope={id}
                  onChange={(next, key) => ed.change((d) => ({ ...d, data: next }), key)}
                  onBind={(where, key) =>
                    ed.change(
                      (d) => ({ ...d, ...bindDataSet(d.root, d.components, where, key) }),
                      `data:bind:${where.id}`,
                    )
                  }
                />
              </div>
            )}
            {compare && (
              <VersionCompare
                version={compare}
                current={{ root: doc.root, components: doc.components, designSize: doc.designSize }}
                images={
                  // 版本里用到、现在已经删掉的图片也要画出来
                  new Map([
                    ...compare.snapshot.images.flatMap((i) => {
                      const v = i.variants[i.selected] ?? i.variants.at(-1)
                      return v
                        ? [
                            [
                              i.id,
                              {
                                url: designFileUrl(id, v.file),
                                width: v.width || i.width,
                                height: v.height || i.height,
                              },
                            ] as const,
                          ]
                        : []
                    }),
                    ...renderImages,
                  ])
                }
                device={server.kind === 'web' ? device : undefined}
                onRestore={async () => {
                  try {
                    ed.absorb(await api.saveDesign(id, doc))
                    ed.absorb(await api.restoreDesignVersion(id, compare.id))
                    toast.success(t('已恢复到「{name}」，恢复前的样子也存成了一个版本', { name: compare.name }))
                    setCompare(undefined)
                  } catch (e) {
                    toast.error((e as Error).message)
                  }
                }}
                onClose={() => setCompare(undefined)}
              />
            )}
            {server.kind === 'web' && (
              <Segmented
                tone="canvas"
                size="sm"
                iconOnly
                label={t('预览宽度')}
                value={device}
                onChange={setDevice}
                options={[
                  { id: 'desktop', label: t('桌面（{w}）', { w: designSize.X }), icon: Monitor },
                  { id: 'tablet', label: t('平板（{w}）', { w: DEVICE_WIDTH.tablet }), icon: Tablet },
                  { id: 'mobile', label: t('手机（{w}）', { w: DEVICE_WIDTH.mobile }), icon: Smartphone },
                ]}
                className="absolute bottom-3 left-3 z-20 shadow-pop"
              />
            )}
            {(() => {
              const img = preview ? doc.images.find((i) => i.id === preview) : undefined
              const src = img && imageUrl(img)
              return img && src ? (
                <ImagePreview
                  image={img}
                  src={src}
                  marks={doc.annotations.filter((a) => a.target === imgTarget(img.id))}
                  onMarks={(marks) =>
                    ed.change(
                      (d) => ({
                        ...d,
                        annotations: [
                          ...d.annotations.filter((a) => a.target !== imgTarget(img.id)),
                          // 对话框上面的小标签里显示是哪张图
                          ...marks.map((m) => ({ ...m, target: imgTarget(img.id), widgets: [img.name] })),
                        ],
                      }),
                      `ann:img:${img.id}`,
                    )
                  }
                  onClose={() => setPreview('')}
                />
              ) : null
            })()}
          </div>
          {animOpen && (
            <AnimationPanel
              key={`${id}:${target}`}
              animations={doc.animations ?? []}
              tree={target}
              root={tree}
              current={curAnim?.name ?? ''}
              time={animTime}
              onCurrent={setAnimName}
              onTime={setAnimTime}
              web={server.kind === 'web'}
              selectedNames={[...extra, selected]
                .filter((x, i, a) => x && a.indexOf(x) === i)
                .map((x) => findWidget(tree, x)?.Name ?? '')
                .filter(Boolean)}
              onChange={(animations, key) => ed.change((d) => ({ ...d, animations }), key)}
              onCommand={setAnimCommand}
              onSelectWidget={(name) => {
                let hit = ''
                walk(tree, (w) => {
                  if (w.Name === name) hit = w.id
                })
                if (hit) {
                  setSelected(hit)
                  setExtra([])
                  setTab('tree')
                }
              }}
              onClose={() => setAnimOpen(false)}
            />
          )}
        </div>
      </main>

      <aside
        aria-label={t('检查器')}
        style={{ width: treePane.width }}
        className="panel relative flex shrink-0 flex-col bg-card"
      >
        <ResizeHandle pane={treePane} label={t('拖动调整控件树的宽度')} />
        {/* 和对话页、右栏同一套页签条（照 Proma）：选中只画底部指示条 */}
        <TabBar
          label={t('检查器')}
          className="bg-card"
          trailing={
            tab === 'tree' && (
              <Palette kind={server.kind} components={doc.components.map((c) => c.Name)} onAdd={addWidget} />
            )
          }
        >
          {(['tree', 'images', 'widgets'] as const).map((k) => (
            <TabItem key={k} fill active={tab === k} onSelect={() => setTab(k)}>
              {k === 'tree' ? t('控件树') : k === 'images' ? t('图片 {n}', { n: doc.images.length }) : t('控件')}
            </TabItem>
          ))}
        </TabBar>
        {tab === 'tree' && (doc.components.length > 0 || target) && (
          <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
            <Puzzle className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <Select
              aria-label={t('正在编辑')}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value)
                setSelected('')
              }}
              options={[
                { value: '', label: t('主界面') },
                ...doc.components.map((c) => ({ value: c.Name, label: c.Name, group: t('子控件') })),
              ]}
              className="h-7 rounded-md px-2 text-[0.75rem]"
            />
            {target && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('删除这个子控件')}
                title={t('删除这个子控件')}
                onClick={() => {
                  ed.change((d) => ({ ...d, components: d.components.filter((c) => c.Name !== target) }))
                  setTarget('')
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
        <div className="min-h-[120px] flex-1 overflow-y-auto">
          {tab === 'tree' ? (
            <>
              {live && (
                <p className="flex items-center gap-1.5 border-b bg-accent-soft/40 px-3 py-1.5 text-[0.6875rem] text-accent-text">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('AI 正在修改，已经改了 {n} 处', { n: live.applied })}
                </p>
              )}
              <Hierarchy
                root={shownTree ?? tree}
                selected={selected}
                actions={actions}
                extra={extra.filter((x) => x !== selected)}
                onPick={pick}
                renameRequest={renameRequest}
              />
            </>
          ) : tab === 'widgets' ? (
            <ComponentsPanel
              projectId={server.projectId}
              designId={id}
              kind={server.kind}
              own={doc.components.map((c) => c.Name)}
              onOpen={(name) => {
                setTarget(name)
                setSelected('')
                setTab('tree')
              }}
              onImport={async (from, name) => {
                try {
                  // 先保存本地的修改，服务端在保存的内容上加
                  ed.absorb(await api.saveDesign(id, doc))
                  ed.absorb(await api.importComponent(id, { from, name }))
                  toast.success(t('已把 {name} 加进这个设计', { name }))
                } catch (e) {
                  toast.error((e as Error).message)
                }
              }}
            />
          ) : (
            <ImagesPanel
              images={doc.images}
              url={imageUrl}
              selected={imageSel}
              onSelect={setImageSel}
              onUpload={(f) => void upload(f)}
              onPreview={setPreview}
              onDragImage={setDragImage}
              usedIds={used}
              canGenerate={source.kind !== 'none' && (!ed.running || server.job?.phase === 'images')}
              onGenerateAll={async (ids) => {
                try {
                  ed.absorb(await api.saveDesign(id, doc))
                  ed.absorb(await api.generateDesignImages(id, { ids, source, count }))
                } catch (e) {
                  toast.error((e as Error).message)
                }
              }}
            />
          )}
        </div>
        <div className={cn('min-h-[160px] flex-[1.3] overflow-y-auto border-t', tab === 'widgets' && 'hidden')}>
          {tab === 'tree' && selWidget ? (
            <Details
              key={selWidget.id}
              device={server.kind === 'web' ? device : 'desktop'}
              widget={selWidget}
              parent={selParent}
              slotType={selParent ? WIDGETS[selParent.Type].slot : undefined}
              parentSize={() => {
                const el = selParent && document.querySelector<HTMLElement>(`[data-wid="${CSS.escape(selParent.id)}"]`)
                return { w: el?.offsetWidth ?? designSize.X, h: el?.offsetHeight ?? designSize.Y }
              }}
              images={doc.images}
              url={imageUrl}
              components={doc.components.map((c) => c.Name)}
              anim={curAnim}
              animTime={animTime}
              onKey={pinKey}
              onChange={(w, key) => editTree((r) => mapWidget(r, w.id, () => w), key)}
            />
          ) : tab === 'images' && selImage ? (
            <ImageDetails
              key={selImage.id}
              image={selImage}
              url={fileUrl}
              onChange={setImage}
              onGenerate={() => void generate(selImage)}
              onUpload={(f) => void upload([f], selImage.id)}
              onDelete={() => {
                ed.change((d) => ({ ...d, images: d.images.filter((i) => i.id !== selImage.id) }))
                setImageSel('')
              }}
              // 正在生成别的图时也能点：排进这一轮的队列；AI 还在改设计时不行
              canGenerate={source.kind !== 'none' && (!ed.running || server.job?.phase === 'images')}
              sourceLabel={sourceLabel}
              marks={doc.annotations.filter((a) => a.target === imgTarget(selImage.id))}
              onPreview={() => setPreview(selImage.id)}
              users={imageUsers(trees, selImage.id)}
              candidates={imageSlots}
              onJump={jumpTo}
              onAssign={(w) => {
                ed.change(
                  (d) =>
                    setTree(
                      d,
                      w.target,
                      mapWidget(treeOf(d, w.target)!, w.id, (x) => assignImage(x, selImage)),
                    ),
                  `assign:${selImage.id}`,
                )
                jumpTo(w)
              }}
            />
          ) : (
            <p className="px-4 py-6 text-center text-[0.75rem] leading-relaxed text-subtle">
              {tab === 'tree' ? t('选中一个控件查看和修改它的属性') : t('选中一张图片查看它的每一版和生成设置')}
            </p>
          )}
        </div>
      </aside>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除「{name}」？', { name: doc.title })}
        description={t('会删除这个设计的控件树、对话和生成的图片。')}
        onConfirm={() => void removeDesign()}
      />
    </div>
  )
}

/**
 * 画板标题行左边的阶段条（照设计稿）：原画 → 界面两步，带序号圆点和连线。
 * 只是「显示原画还是界面」的切换，步骤顺序不强制：任何时候都能点回原画；
 * 确认了模板、停在界面时原画那一步打勾
 */
function StageSteps({
  value,
  onChange,
  conceptDone,
}: {
  value: 'concept' | 'ui'
  onChange: (v: 'concept' | 'ui') => void
  conceptDone: boolean
}) {
  const steps = [
    { id: 'concept' as const, label: t('原画') },
    { id: 'ui' as const, label: t('界面') },
  ]
  const cur = steps.findIndex((s) => s.id === value)
  return (
    <nav aria-label={t('阶段')} className="flex shrink-0 items-center gap-0.5">
      {steps.map((s, i) => {
        const on = i === cur
        const done = i < cur && conceptDone
        return (
          <div key={s.id} className="flex items-center gap-0.5">
            {i > 0 && (
              <span
                aria-hidden
                className={cn('h-[1.5px] w-3.5', i <= cur && conceptDone ? 'bg-success' : 'bg-line-strong')}
              />
            )}
            <button
              type="button"
              aria-current={on ? 'step' : undefined}
              onClick={() => onChange(s.id)}
              className={cn(
                'flex h-8 cursor-pointer items-center gap-[7px] rounded-[9px] px-2.5 text-[0.8125rem] font-semibold whitespace-nowrap transition-colors',
                // 当前这一步：比面板低一档的底色 + 一点内阴影，像按下去的样子
                on
                  ? 'bg-panel text-fg shadow-[inset_0_1px_2px_rgb(0_0_0/0.08)]'
                  : cn('hover:bg-sel', done ? 'text-fg' : 'text-subtle'),
              )}
            >
              <span
                className={cn(
                  // 标题行窄的时候（@container）圆点先让位，只留步骤名
                  'hidden h-5 w-5 shrink-0 place-items-center rounded-full text-[0.6875rem] tabular-nums @min-[600px]:grid',
                  done
                    ? 'bg-success text-on-primary'
                    : on
                      ? 'bg-fg text-bg'
                      : 'text-subtle shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
                )}
              >
                {done ? <Check className="h-3 w-3" strokeWidth={2.6} /> : i + 1}
              </span>
              {s.label}
            </button>
          </div>
        )
      })}
    </nav>
  )
}

/** 设计稿尺寸 */
function SizeButton({ doc, onChange }: { doc: DesignDoc; onChange: (s: { X: number; Y: number }) => void }) {
  const [w, setW] = useState(String(doc.designSize.X))
  const [h, setH] = useState(String(doc.designSize.Y))
  return (
    <Popover onOpenChange={(o) => o && (setW(String(doc.designSize.X)), setH(String(doc.designSize.Y)))}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="px-2 font-mono text-[0.75rem] font-normal" title={t('设计尺寸')}>
          {doc.designSize.X}×{doc.designSize.Y}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[240px] p-3">
        <p className="mb-2 text-[0.75rem] font-medium">{t('设计尺寸')}</p>
        <div className="flex items-center gap-2">
          <Input
            value={w}
            onChange={(e) => setW(e.target.value.replace(/\D/g, ''))}
            size="sm"
            className="font-mono"
            aria-label={t('宽')}
          />
          <span className="text-subtle">×</span>
          <Input
            value={h}
            onChange={(e) => setH(e.target.value.replace(/\D/g, ''))}
            size="sm"
            className="font-mono"
            aria-label={t('高')}
          />
        </div>
        <ChipGroup
          size="sm"
          label={t('常用尺寸')}
          className="mt-2 font-mono"
          options={SIZES.map((s) => ({ id: s.v, label: s.v.replace('x', '×') }))}
          value={`${w}x${h}`}
          onChange={(v) => {
            const [x, y] = v.split('x')
            setW(x)
            setH(y)
          }}
        />
        <Button
          size="sm"
          className="mt-3 w-full justify-center"
          disabled={!Number(w) || !Number(h)}
          onClick={() => onChange({ X: Math.min(8192, Number(w)), Y: Math.min(8192, Number(h)) })}
        >
          {t('应用')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

/** 美术风格：项目提示词（整个项目共用）和这个界面自己的补充，生成每张图时都会带上 */
function StyleButton({
  value,
  onChange,
  prompts,
  onPrompts,
  designId,
  kind,
  beforeExtract,
}: {
  value: string
  onChange: (s: string) => void
  /** 项目里启用的提示词条数 */
  prompts: number
  onPrompts: () => void
  designId: string
  kind: DesignKind
  /** 存到风格库前先把没存的改动存下 */
  beforeExtract: () => Promise<void>
}) {
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  return (
    <Popover
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setText(value)
        else if (text !== value) onChange(text)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('美术风格')}
          className="max-w-[220px] px-2 text-[0.75rem] font-normal"
          title={value || t('美术风格')}
        >
          <PaletteIcon className="h-3.5 w-3.5 shrink-0" />
          {/* 画板标题行窄的时候（@container，两边面板都开着）只留图标，风格内容在悬停提示里 */}
          <span className="hidden truncate @min-[640px]:inline">
            {value || (prompts ? t('项目风格 · {n} 条', { n: prompts }) : t('美术风格'))}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-3">
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-panel px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[0.75rem] font-medium">{t('项目美术提示词')}</p>
            <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-subtle">
              {prompts
                ? t('{n} 条启用中，项目里所有界面共用', { n: prompts })
                : t('还没有设置。设置后项目里所有界面风格统一')}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={onPrompts}>
            {prompts ? t('管理') : t('设置')}
          </Button>
        </div>
        <p className="mb-1 text-[0.75rem] font-medium">{t('这个界面的补充风格')}</p>
        <p className="mb-2 text-[0.6875rem] leading-relaxed text-subtle">
          {t('只对这个界面生效，加在项目提示词后面。AI 对话时也会帮你定。')}
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="dark fantasy, carved stone with gold trim, glowing runes"
          className="text-[0.75rem]"
        />
        <div className="mt-3 border-t pt-3">
          <p className="mb-1.5 text-[0.75rem] font-medium">{t('从风格库套用')}</p>
          <StyleLibraryList
            kind={kind}
            active={open}
            current={text}
            onPick={(s) => {
              setText(s.en)
              onChange(s.en)
            }}
          />
          <div className="mt-2">
            <SaveStyleButton designId={designId} kind={kind} beforeExtract={beforeExtract} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 在线演示没有后端：在页面里生成导出数据（单个 JSON，贴图内嵌） */
function demoExport(doc: DesignDoc) {
  const images = doc.images
    .filter((i) => i.variants.length)
    .map((i) => {
      const v = i.variants[i.selected] ?? i.variants[0]
      return {
        id: i.id,
        name: i.name,
        ext: 'png',
        width: v.width || i.width,
        height: v.height || i.height,
        nineSlice: i.nineSlice,
      }
    })
  const { json } = exportDesign({
    title: doc.title,
    designSize: doc.designSize,
    root: doc.root,
    components: doc.components,
    images,
    animations: doc.animations,
  })
  const data = {
    ...json,
    Textures: json.Textures.map((tx) => {
      const img = doc.images.find((i) => tx.Name.endsWith(i.name.replace(/[^A-Za-z0-9_]/g, '_')))
      const v = img && (img.variants[img.selected] ?? img.variants[0])
      return { ...tx, Data: v?.file.startsWith('data:') ? v.file.replace(/^data:[^,]*,/, '') : '' }
    }),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${json.Name}.umg.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

/** 在线演示导出网页：单个 HTML，图片本来就是 data URL */
function demoWebExport(doc: DesignDoc, react: boolean) {
  const src = new Map(
    doc.images.flatMap((i) => {
      const v = i.variants[i.selected] ?? i.variants[0]
      return v ? [[i.id, v.file] as const] : []
    }),
  )
  // React 组件只出 .tsx（演示里的图片在浏览器内存里，按 images/<图片名>.png 引用）
  const out = react
    ? webReactExport({
        ...doc,
        file: (id) => (src.has(id) ? `${doc.images.find((i) => i.id === id)!.name}.png` : undefined),
      })
    : webExport({ ...doc, file: (id) => src.get(id) })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([out], { type: react ? 'text/plain' : 'text/html' }))
  a.download = react ? 'Page.tsx' : 'index.html'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
