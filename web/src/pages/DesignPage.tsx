import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  Download,
  FileJson,
  FileArchive,
  FolderDown,
  Gamepad2,
  MessageSquare,
  Palette as PaletteIcon,
  Plus,
  Puzzle,
  Loader2,
  Redo2,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { Attachment } from '@shared/schema'
import { imageRevisionText, type Annotation, type DesignDoc, type DesignImage, type ImageSource } from '@shared/design'
import {
  IMAGE_SLOT,
  WIDGETS,
  allNames,
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
  removeWidget,
  replaceWidget,
  uniqueName,
  wrapWidget,
  usedImages,
  walk,
  type Widget,
  type WidgetType,
} from '@shared/umg'
import { api, designExportUrl, designFileUrl } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
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
import { Viewport } from '@/components/design/Viewport'
import { Hierarchy, Palette, type TreeActions } from '@/components/design/Hierarchy'
import { Details } from '@/components/design/Details'
import { ImageDetails, ImagePreview, ImagesPanel, readFile, type WidgetRef } from '@/components/design/ImagesPanel'
import { ComponentsPanel } from '@/components/design/ComponentsPanel'
import { DesignChat, parseSource, sourceKey } from '@/components/design/DesignChat'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import type { ChatRun } from '@/components/tasks/ChatModelPicker'
import { DesignProjectDialog } from '@/components/design/DesignProjectDialog'
import { setTree, treeOf, useDesignEditor } from '@/components/design/useDesignEditor'
import type { RenderImage } from '@/components/design/umg-render'
import { t } from '@shared/i18n'

export function DesignPage() {
  const { route } = useNav()
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
        <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent">
          <PaletteIcon className="h-5 w-5" />
        </span>
        <h1 className="font-serif text-[26px] font-semibold tracking-tight">{t('UI 设计')}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          {t(
            '用对话设计游戏界面：AI 搭好 UMG 控件树、生成每一张图片，最后导出成 WidgetTree 的 JSON 和贴图，导入 UE 生成 Widget Blueprint。',
          )}
        </p>
        <DesignProjectDialog open={creatingProject} onOpenChange={setCreatingProject} onSaved={(p) => setPid(p.id)} />
        {!projects.length ? (
          <div className="mt-8 rounded-xl border p-5 text-[13px] text-muted">
            {t('设计放在 UI 项目里（和 Agent 的项目分开）。先建一个项目吧，一般一个游戏一个项目。')}
            <Button className="mt-3" onClick={() => setCreatingProject(true)}>
              <Plus className="h-4 w-4" />
              {t('新建 UI 项目')}
            </Button>
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-5 rounded-2xl border bg-card p-6 shadow-card">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">{t('名称')}</span>
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && pid && void create()}
                placeholder={t('例如：主菜单、背包、战斗 HUD')}
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">{t('类型')}</span>
              <Segmented
                label={t('类型')}
                value={kind}
                onChange={setKind}
                options={[
                  { id: 'game', label: t('游戏 UI（UE5 UMG）') },
                  { id: 'web', label: t('网页 UI（即将支持）'), disabled: true },
                ]}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">{t('项目')}</span>
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
                <span className="text-[13px] font-medium">{t('设计尺寸')}</span>
                <Select
                  aria-label={t('设计尺寸')}
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  options={SIZES.map((s) => ({ value: s.v, label: s.label }))}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void create()} disabled={busy || !pid}>
                <Gamepad2 className="h-4 w-4" />
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

// 复制的控件：放在模块里，切换到别的设计也能粘贴
let clipboard: Widget | null = null

function Designer({ id }: { id: string }) {
  const ed = useDesignEditor(id)
  const { designProjects: projects, setDesigns } = useData()
  const { go } = useNav()
  const { doc, server } = ed
  const [target, setTarget] = useState('')
  const [selected, setSelected] = useState('')
  /** 效果图上按住 Shift / Ctrl 多选的其他控件，用来对齐、等间距；换树或普通点选时清掉 */
  const [extra, setExtra] = useState<string[]>([])
  useEffect(() => setExtra([]), [target])
  const [hasClip, setHasClip] = useState(!!clipboard)
  const [tab, setTab] = useState<'tree' | 'images' | 'widgets'>('tree')
  const [imageSel, setImageSel] = useState('')
  /** 双击图片后在画布区域放大预览的图片 */
  const [preview, setPreview] = useState('')
  /** 图上的修改标记和效果图的标注放在一起（target 是 img:<图片 id>），在右边对话框上面列出来，发送时一起发 */
  const imgTarget = (imgId: string) => `img:${imgId}`
  const [chatOpen, setChatOpen] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [source, setSourceState] = useState<ImageSource>(() => {
    try {
      return parseSource(localStorage.getItem(SOURCE_KEY) ?? 'cli')
    } catch {
      return { kind: 'cli' }
    }
  })
  const setSource = (s: ImageSource) => {
    setSourceState(s)
    try {
      localStorage.setItem(SOURCE_KEY, sourceKey(s))
    } catch {}
  }
  const [count, setCount] = useState(1)
  const [promptsOpen, setPromptsOpen] = useState(false)
  // 控件树和对话栏可以拖动调整宽度，效果区占剩下的
  const treePane = usePaneWidth('design-tree', 300, 220, 560)
  const chatPane = usePaneWidth('design-chat', 380, 300, 720)

  // AI 一步步改的时候，效果图和控件树显示已经收到的改动（还没存下，改完整体检查通过才存）
  const live = server?.job?.status === 'running' && server.job.phase === 'design' ? server.job.preview : undefined
  const shownDoc = doc && live ? { ...doc, root: live.root, components: live.components } : doc
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

  const editTree = (fn: (root: Widget) => Widget, key = '') =>
    ed.change((d) => {
      const r = treeOf(d, target)
      if (!r) return d
      const n = fn(r)
      return n === r ? d : setTree(d, target, n)
    }, key)

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
    if (slotType === 'CanvasPanelSlot' && type === 'TextBlock') slot!.bAutoSize = true
    const wd = newWidget(type, name, slot)
    if (type === 'UserWidget') wd.Class = cls
    editTree((r) => insertWidget(r, parent!.id, wd, index))
    setSelected(wd.id)
    setTab('tree')
  }

  const actions: TreeActions = {
    select: (wid) => setSelected(wid),
    rename: (wid, name) =>
      editTree((r) => {
        const names = allNames(r)
        names.delete(findWidget(r, wid)?.Name ?? '')
        return mapWidget(r, wid, (w) => ({ ...w, Name: uniqueName(name, names) }))
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
    toggleVisible: (wid) =>
      editTree((r) =>
        mapWidget(r, wid, (w) => ({
          ...w,
          Properties: {
            ...w.Properties,
            Visibility: w.Properties.Visibility === 'Collapsed' ? 'Visible' : 'Collapsed',
          },
        })),
      ),
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
    shift: (wid, delta) => {
      if (!tree) return
      const p = findParent(tree, wid)
      if (!p) return
      const from = p.Children!.findIndex((c) => c.id === wid)
      // moveWidget 往后挪时会先减一，所以下移要给 from + 2
      editTree((r) => moveWidget(r, wid, p.id, delta > 0 ? from + 2 : Math.max(0, from - 1)))
    },
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
  }

  const onMove = (wid: string, d: { dx: number; dy: number; mode: 'move' | 'resize' }, key: string) =>
    editTree(
      (r) =>
        mapWidget(r, wid, (w) => {
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
            // 拉伸的方向改右 / 下边距，不拉伸的改宽高（对齐点不是左上时位置跟着补偿）
            if (sx) o.Right -= d.dx
            else {
              o.Right = Math.max(1, o.Right + d.dx)
              o.Left += d.dx * L.Alignment.X
            }
            if (sy) o.Bottom -= d.dy
            else {
              o.Bottom = Math.max(1, o.Bottom + d.dy)
              o.Top += d.dy * L.Alignment.Y
            }
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
        actions.remove(selected)
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
      <div className="grid flex-1 place-items-center p-8 text-center text-[13px] text-muted">
        <div>
          <p>{ed.error}</p>
          <Button variant="ghost" className="mt-3" onClick={() => go({ page: 'design' })}>
            {t('返回')}
          </Button>
        </div>
      </div>
    )
  if (!doc || !server || !tree) return <div className="flex-1" />

  const selWidget = selected ? findWidget(tree, selected) : undefined
  const selParent = selWidget ? findParent(tree, selWidget.id) : undefined
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

  const send = async (text: string, run: ChatRun, attachments: Attachment[]) => {
    // 图上的标记：这条消息就是这些图的修改意见，按它重新生成，不用让 AI 改设计
    const imgMarks = doc.annotations.filter((a) => a.target.startsWith('img:'))
    const annotations = doc.annotations.filter((a) => !a.target.startsWith('img:'))
    if (imgMarks.length) {
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
      ed.absorb(await api.saveDesign(id, next))
      ed.absorb(
        await api.designChat(id, {
          text: text.trim() || (annotations.length ? t('按标注修改') : t('参考附件')),
          source,
          count,
          annotations,
          attachments,
          run,
        }),
      )
      if (annotations.length) ed.change((d) => ({ ...d, annotations: [] }), 'ann:sent')
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    }
  }

  const exportFile = async (format: 'zip' | 'json') => {
    try {
      ed.absorb(await api.saveDesign(id, doc))
    } catch (e) {
      return toast.error((e as Error).message)
    }
    if (import.meta.env.VITE_DEMO) return demoExport(doc)
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        {project && <span className="hidden truncate text-[12.5px] text-subtle sm:block">{project.name} /</span>}
        <input
          aria-label={t('设计名称')}
          value={doc.title}
          onChange={(e) => ed.change((d) => ({ ...d, title: e.target.value }), 'title')}
          className="h-8 w-[min(240px,30vw)] min-w-0 rounded-md bg-transparent px-1.5 text-[14px] font-medium outline-none hover:bg-sel/60 focus:bg-field focus:ring-1 focus:ring-accent"
        />
        <SaveIndicator status={ed.save.status} error={ed.save.error} />
        <span className="flex-1" />
        <StyleButton
          value={doc.style}
          onChange={(style) => ed.change((d) => ({ ...d, style }), 'style')}
          prompts={project?.prompts.filter((p) => p.enabled).length ?? 0}
          onPrompts={() => setPromptsOpen(true)}
        />
        {project && (
          <DesignProjectDialog open={promptsOpen} onOpenChange={setPromptsOpen} project={project} section="prompts" />
        )}
        <SizeButton doc={doc} onChange={(designSize) => ed.change((d) => ({ ...d, designSize }), 'size')} />
        <div className="flex items-center">
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
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="secondary">
              <Download className="h-3.5 w-3.5" />
              {t('导出')}
              <ChevronDown className="h-3 w-3 text-subtle" />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => void exportFile('zip')}>
              <FileArchive className="h-4 w-4" />
              {t('ZIP（JSON + 贴图文件）')}
            </MenuItem>
            <MenuItem onSelect={() => void exportFile('json')}>
              <FileJson className="h-4 w-4" />
              {t('单个 JSON（贴图内嵌）')}
            </MenuItem>
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
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={chatOpen ? t('收起 AI 对话') : t('打开 AI 对话')}
          title={chatOpen ? t('收起 AI 对话') : t('打开 AI 对话')}
          onClick={() => setChatOpen(!chatOpen)}
          className={cn(chatOpen && 'text-accent')}
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <Viewport
            root={shownTree ?? tree}
            size={designSize}
            images={renderImages}
            components={shownDoc?.components ?? doc.components}
            selected={selected}
            onSelect={(wid) => {
              setSelected(wid)
              setExtra([])
              if (wid) setTab('tree')
            }}
            extra={extra.filter((x) => x !== selected)}
            onPick={(wid) => {
              // 再点一次已选的就取消它
              if (wid === selected) {
                setSelected(extra.at(-1) ?? '')
                setExtra(extra.slice(0, -1))
              } else if (extra.includes(wid)) setExtra(extra.filter((x) => x !== wid))
              else {
                if (selected) setExtra([...extra.filter((x) => x !== selected), selected])
                setSelected(wid)
              }
              setTab('tree')
            }}
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

        <aside style={{ width: treePane.width }} className="relative flex shrink-0 flex-col border-l bg-card">
          <ResizeHandle pane={treePane} label={t('拖动调整控件树的宽度')} />
          <div role="tablist" className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
            {(['tree', 'images', 'widgets'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  'h-7 cursor-pointer rounded-md px-2.5 text-[12.5px]',
                  tab === k ? 'bg-sel font-medium text-fg' : 'text-subtle hover:text-fg',
                )}
              >
                {k === 'tree' ? t('控件树') : k === 'images' ? t('图片 {n}', { n: doc.images.length }) : t('控件')}
              </button>
            ))}
            <span className="flex-1" />
            {tab === 'tree' && <Palette components={doc.components.map((c) => c.Name)} onAdd={addWidget} />}
          </div>
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
                className="h-7 rounded-md px-2 text-[12px]"
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
                  <p className="flex items-center gap-1.5 border-b bg-accent-soft/40 px-3 py-1.5 text-[11.5px] text-accent">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('AI 正在修改，已经改了 {n} 处', { n: live.applied })}
                  </p>
                )}
                <Hierarchy root={shownTree ?? tree} selected={selected} actions={actions} />
              </>
            ) : tab === 'widgets' ? (
              <ComponentsPanel
                projectId={server.projectId}
                designId={id}
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
                widget={selWidget}
                slotType={selParent ? WIDGETS[selParent.Type].slot : undefined}
                parentSize={() => {
                  const el =
                    selParent && document.querySelector<HTMLElement>(`[data-wid="${CSS.escape(selParent.id)}"]`)
                  return { w: el?.offsetWidth ?? designSize.X, h: el?.offsetHeight ?? designSize.Y }
                }}
                images={doc.images}
                url={imageUrl}
                components={doc.components.map((c) => c.Name)}
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
              <p className="px-4 py-6 text-center text-[12px] leading-relaxed text-subtle">
                {tab === 'tree' ? t('选中一个控件查看和修改它的属性') : t('选中一张图片查看它的每一版和生成设置')}
              </p>
            )}
          </div>
        </aside>

        {chatOpen && (
          <aside style={{ width: chatPane.width }} className="relative flex shrink-0 flex-col border-l bg-bg">
            <ResizeHandle pane={chatPane} label={t('拖动调整 AI 对话的宽度')} />
            <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-[12.5px] font-medium text-muted">
              <span className="shrink-0">{t('AI 对话')}</span>
            </div>
            <DesignChat
              messages={server.messages}
              job={server.job}
              source={source}
              onSource={setSource}
              count={count}
              onCount={setCount}
              onSend={send}
              onStop={() => void api.stopDesign(id).then(() => ed.reload())}
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
            />
          </aside>
        )}
      </div>
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

/** 设计稿尺寸 */
function SizeButton({ doc, onChange }: { doc: DesignDoc; onChange: (s: { X: number; Y: number }) => void }) {
  const [w, setW] = useState(String(doc.designSize.X))
  const [h, setH] = useState(String(doc.designSize.Y))
  return (
    <Popover onOpenChange={(o) => o && (setW(String(doc.designSize.X)), setH(String(doc.designSize.Y)))}>
      <PopoverTrigger asChild>
        <button
          className="h-7 cursor-pointer rounded-md px-2 font-mono text-[12px] text-muted hover:bg-sel hover:text-fg"
          title={t('设计尺寸')}
        >
          {doc.designSize.X}×{doc.designSize.Y}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[240px] p-3">
        <p className="mb-2 text-[12px] font-medium">{t('设计尺寸')}</p>
        <div className="flex items-center gap-2">
          <Input
            value={w}
            onChange={(e) => setW(e.target.value.replace(/\D/g, ''))}
            className="h-8 font-mono"
            aria-label={t('宽')}
          />
          <span className="text-subtle">×</span>
          <Input
            value={h}
            onChange={(e) => setH(e.target.value.replace(/\D/g, ''))}
            className="h-8 font-mono"
            aria-label={t('高')}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {SIZES.map((s) => (
            <button
              key={s.v}
              onClick={() => {
                const [x, y] = s.v.split('x')
                setW(x)
                setH(y)
              }}
              className="cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[11px] text-subtle hover:text-fg"
            >
              {s.v.replace('x', '×')}
            </button>
          ))}
        </div>
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
}: {
  value: string
  onChange: (s: string) => void
  /** 项目里启用的提示词条数 */
  prompts: number
  onPrompts: () => void
}) {
  const [text, setText] = useState(value)
  return (
    <Popover onOpenChange={(o) => (o ? setText(value) : text !== value && onChange(text))}>
      <PopoverTrigger asChild>
        <button
          className="flex h-7 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-sel hover:text-fg"
          title={value || t('美术风格')}
        >
          <PaletteIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {value || (prompts ? t('项目风格 · {n} 条', { n: prompts }) : t('美术风格'))}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-3">
        <div className="mb-3 flex items-start gap-2 rounded-lg border bg-panel/60 px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium">{t('项目美术提示词')}</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">
              {prompts
                ? t('{n} 条启用中，项目里所有界面共用', { n: prompts })
                : t('还没有设置。设置后项目里所有界面风格统一')}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={onPrompts}>
            {prompts ? t('管理') : t('设置')}
          </Button>
        </div>
        <p className="mb-1 text-[12px] font-medium">{t('这个界面的补充风格')}</p>
        <p className="mb-2 text-[11.5px] leading-relaxed text-subtle">
          {t('只对这个界面生效，加在项目提示词后面。AI 对话时也会帮你定。')}
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="dark fantasy, carved stone with gold trim, glowing runes"
          className="text-[12.5px]"
        />
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
