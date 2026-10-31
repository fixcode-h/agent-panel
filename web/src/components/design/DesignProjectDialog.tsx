import { useEffect, useRef, useState } from 'react'
import { BookMarked, Check, Loader2, Palette, Pencil, Plus, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import {
  PROMPT_CATEGORIES,
  type DesignProject,
  type ProjectPrompt,
  type PromptCategory,
  type SavedStyle,
} from '@shared/design'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Field, FormSection, Input, Textarea } from '@/components/ui/input'
import { ConfirmDialog, dialogScrollClass } from '@/components/ui/dialog'
import { Modal } from '@/components/ui/modal'
import { Checkbox } from '@/components/ui/checkbox'
import { IconButton } from '@/components/ui/icon-button'
import { DirPicker, useDirInfo } from '@/components/projects/DirPicker'
import { DialogCloseButton, NavItem } from '@/components/projects/ProjectSettingsDialog'
import { ScopeRequests } from '@/components/chat/AskToggle'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { t } from '@shared/i18n'

export type DesignProjectSection = 'general' | 'prompts'

const newId = () => Math.random().toString(36).slice(2, 10)
const catLabel = (c: PromptCategory) =>
  ({
    style: t('画风'),
    color: t('色彩'),
    material: t('材质'),
    light: t('光影'),
    layout: t('构图'),
    avoid: t('避免'),
  })[c]

/** 常用的提示词，点一下加进项目：中文给人看，英文发给生图 AI */
const PRESETS: Record<PromptCategory, { zh: string; en: string }[]> = {
  style: [
    { zh: '暗黑奇幻', en: 'dark fantasy' },
    { zh: '日式动漫', en: 'Japanese anime style' },
    { zh: '卡通 Q 版', en: 'cute chibi cartoon style' },
    { zh: '赛博朋克', en: 'cyberpunk' },
    { zh: '像素风', en: 'pixel art' },
    { zh: '中国风', en: 'traditional Chinese style' },
    { zh: '科幻硬朗', en: 'hard sci-fi' },
    { zh: '扁平简约', en: 'flat minimalist' },
    { zh: '手绘质感', en: 'hand-painted' },
  ],
  color: [
    { zh: '深色底配金色点缀', en: 'dark base with gold accents' },
    { zh: '冷色调蓝紫', en: 'cool blue and purple palette' },
    { zh: '高饱和明亮', en: 'bright saturated colors' },
    { zh: '低饱和莫兰迪色', en: 'muted desaturated palette' },
    { zh: '黑白灰为主', en: 'monochrome grayscale' },
  ],
  material: [
    { zh: '石材雕刻', en: 'carved stone' },
    { zh: '金属质感', en: 'metallic' },
    { zh: '木质', en: 'wooden' },
    { zh: '羊皮纸', en: 'parchment' },
    { zh: '半透明玻璃', en: 'translucent glass' },
    { zh: '发光符文', en: 'glowing runes' },
  ],
  light: [
    { zh: '柔和顶光', en: 'soft top lighting' },
    { zh: '边缘发光', en: 'rim glow' },
    { zh: '高对比', en: 'high contrast' },
    { zh: '霓虹光', en: 'neon glow' },
  ],
  layout: [
    { zh: '居中对称', en: 'centered and symmetrical' },
    { zh: '简洁不杂乱', en: 'clean and uncluttered' },
    { zh: '粗描边', en: 'bold outlines' },
  ],
  avoid: [
    { zh: '不要文字', en: 'no text' },
    { zh: '不要水印', en: 'no watermark' },
    { zh: '不要写实照片感', en: 'not photorealistic' },
    { zh: '不要 3D 渲染感', en: 'no 3D render look' },
  ],
}

/**
 * UI 项目设置：常规（名字、本机目录）和美术提示词。改完点「确认」才保存。
 * 没有 project 时是新建项目
 */
export function DesignProjectDialog({
  open,
  onOpenChange,
  project,
  onSaved,
  section = 'general',
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** 有值时是编辑 */
  project?: DesignProject
  onSaved?: (p: DesignProject) => void
  /** 打开时显示哪一页 */
  section?: DesignProjectSection
}) {
  return (
    // 标题栏、侧栏页签、底栏都在 Body 里自己画；Modal 默认点到外面不关，改到一半不会白填
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={project ? t('项目设置 · {name}', { name: project.name }) : t('新建 UI 项目')}
      bare
      size="xl"
      className="h-[min(760px,calc(100dvh-2rem))] max-w-[980px]"
    >
      {open && (
        <Body
          key={project?.id ?? 'new'}
          project={project}
          initial={section}
          onSaved={onSaved}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Modal>
  )
}

function Body({
  project,
  initial,
  onSaved,
  onClose,
}: {
  project?: DesignProject
  initial: DesignProjectSection
  onSaved?: (p: DesignProject) => void
  onClose: () => void
}) {
  const { setDesignProjects, setDesigns } = useData()
  const [section, setSection] = useState<DesignProjectSection>(initial)
  const [name, setName] = useState(project?.name ?? '')
  const [dir, setDir] = useState(project?.path ?? '')
  const [prompts, setPrompts] = useState<ProjectPrompt[]>(project?.prompts ?? [])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const info = useDirInfo(dir)
  // 正在翻译的提示词：确认时等它们翻译完再保存
  const [translating, setTranslating] = useState<Set<string>>(new Set())
  const pending = useRef(new Set<Promise<unknown>>())

  /** 用户自己写的中文：后台让 AI 翻成英文，翻好了填进去 */
  const translate = (items: ProjectPrompt[]) => {
    if (!items.length) return
    const ids = items.map((p) => p.id)
    setTranslating((s) => new Set([...s, ...ids]))
    const job = api
      .promptAi({ mode: 'translate', items: items.map((p) => ({ category: p.category, zh: p.zh })) })
      .then((r) =>
        setPrompts((list) =>
          list.map((p) => {
            const k = ids.indexOf(p.id)
            const got = k >= 0 ? r.prompts[k] : undefined
            return got ? { ...p, en: got.en, category: got.category } : p
          }),
        ),
      )
      .catch((e) => toast.error(t('翻译提示词失败：{error}', { error: (e as Error).message })))
      .finally(() => {
        pending.current.delete(job)
        setTranslating((s) => {
          const n = new Set(s)
          for (const id of ids) n.delete(id)
          return n
        })
      })
    pending.current.add(job)
  }

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await Promise.all(pending.current)
      // 等翻译时提示词可能又变了：用最新的
      const latest = await new Promise<ProjectPrompt[]>((r) => setPrompts((l) => (r(l), l)))
      const input = { name: name.trim(), path: dir.trim(), prompts: latest }
      const p = project ? await api.updateDesignProject(project.id, input) : await api.createDesignProject(input)
      setDesignProjects((l) => (project ? l.map((x) => (x.id === p.id ? p : x)) : [...l, p]))
      onSaved?.(p)
      if (project) toast.success(t('项目设置已保存'))
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!project) return
    try {
      await api.deleteDesignProject(project.id)
      setDesignProjects((l) => l.filter((x) => x.id !== project.id))
      setDesigns((l) => l.filter((d) => d.projectId !== project.id))
      setDeleting(false)
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
      setDeleting(false)
    }
  }

  const enabled = prompts.filter((p) => p.enabled).length
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b px-6 py-4">
        <h2 aria-hidden className="min-w-0 flex-1 truncate font-serif text-[1.125rem] font-semibold">
          {project ? t('项目设置 · {name}', { name: project.name }) : t('新建 UI 项目')}
        </h2>
        <DialogCloseButton />
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={t('项目设置分类')}
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[220px] md:flex-col md:border-r md:border-b-0 md:p-3"
        >
          <NavItem on={section === 'general'} onClick={() => setSection('general')}>
            <Settings2 className="h-4 w-4 shrink-0" strokeWidth={2.2} />
            {t('常规')}
          </NavItem>
          <NavItem
            on={section === 'prompts'}
            onClick={() => setSection('prompts')}
            hint={enabled ? String(enabled) : undefined}
          >
            <Palette className="h-4 w-4 shrink-0" strokeWidth={2.2} />
            {t('美术提示词')}
          </NavItem>
        </nav>
        <div className={dialogScrollClass}>
          {section === 'general' ? (
            <form
              className="flex flex-col gap-7"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <FormSection title={t('基本信息')}>
                <p className="-mt-2 text-[0.75rem] leading-relaxed text-muted">
                  {t('UI 设计的项目和 Agent 的项目分开管理。一个项目对应一个游戏，里面放它的各个界面。')}
                </p>
                <Field label={t('项目名称')} error={name.trim() ? undefined : t('名称不能为空')}>
                  <Input
                    autoFocus={!project}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('例如：暗夜远征')}
                  />
                </Field>
              </FormSection>
              <FormSection title={t('本地目录')}>
                <DirPicker
                  value={dir}
                  onChange={setDir}
                  info={info}
                  hint={t('可以不填。「导出到项目目录」会写到这个目录下的 UI 文件夹，一般选 UE 工程的目录。')}
                />
              </FormSection>
            </form>
          ) : (
            <PromptsPage prompts={prompts} onChange={setPrompts} translating={translating} onTranslate={translate} />
          )}
        </div>
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t bg-panel/60 px-6 py-3.5">
        {project && (
          <Button
            variant="ghost"
            className="text-danger hover:bg-danger/10 hover:text-danger"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t('删除项目')}
          </Button>
        )}
        <span className="ml-auto" />
        {translating.size > 0 && <span className="text-xs text-subtle">{t('正在翻译提示词…')}</span>}
        <Button variant="secondary" onClick={onClose}>
          {t('取消')}
        </Button>
        <Button onClick={() => void save()} disabled={!name.trim() || saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {project ? t('确认') : t('创建')}
        </Button>
      </footer>
      {project && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t('删除「{name}」？', { name: project.name })}
          description={t('会同时删除这个项目里的所有设计和生成的图片。')}
          onConfirm={() => void remove()}
        />
      )}
    </>
  )
}

/** 从风格库导入：把存过的风格的提示词加进这个项目 */
function ImportStyle({ onImport }: { onImport: (s: SavedStyle) => void }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<SavedStyle[] | null>(null)
  useEffect(() => {
    if (open && !list)
      api
        .styles()
        .then(setList)
        .catch(() => setList([]))
  }, [open, list])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary" className="self-start">
          <BookMarked className="h-3.5 w-3.5" />
          {t('从风格库导入')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-1.5">
        {!list ? (
          <Loader2 className="mx-auto my-3 h-4 w-4 animate-spin text-subtle" />
        ) : !list.length ? (
          <p className="px-2 py-2 text-[0.75rem] leading-relaxed text-subtle">
            {t('风格库还是空的。在 UI 设计的风格设置里点「存到风格库」就能存进来。')}
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {/* 游戏和网页的风格分开显示 */}
            {(['game', 'web'] as const).map((k) => {
              const items = [
                ...list.filter((s) => s.kind === k && !s.builtin),
                ...list.filter((s) => s.kind === k && s.builtin),
              ]
              return (
                items.length > 0 && (
                  <div key={k} role="group" aria-label={k === 'game' ? t('游戏 UI') : t('网页 UI')}>
                    <p className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-subtle">
                      {k === 'game' ? t('游戏 UI') : t('网页 UI')}
                    </p>
                    {items.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setOpen(false)
                          onImport(s)
                        }}
                        className="flex w-full cursor-pointer flex-col items-start rounded-lg px-2.5 py-1.5 text-left hover:bg-sel"
                      >
                        <span className="flex items-center gap-1.5 text-[0.75rem]">
                          {s.name}
                          {s.builtin && (
                            <span className="rounded bg-field px-1 text-[0.625rem] text-subtle">{t('内置')}</span>
                          )}
                        </span>
                        <span className="line-clamp-2 text-[0.6875rem] leading-snug text-subtle">
                          {s.summary || t('{n} 条提示词', { n: s.prompts.length })}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** 美术提示词：AI 按描述生成、常用的一键加入、按分类显示和编辑 */
function PromptsPage({
  prompts,
  onChange,
  translating,
  onTranslate,
}: {
  prompts: ProjectPrompt[]
  onChange: (fn: (l: ProjectPrompt[]) => ProjectPrompt[]) => void
  translating: Set<string>
  onTranslate: (items: ProjectPrompt[]) => void
}) {
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  // 这次生成的会话：CLI 要确认时按它取回请求显示
  const [aiScope] = useState(() => crypto.randomUUID())
  const [found, setFound] = useState<(Omit<ProjectPrompt, 'id' | 'enabled'> & { pick: boolean })[]>([])
  const [adding, setAdding] = useState<PromptCategory | ''>('')
  const has = (zh: string) => prompts.some((p) => p.zh === zh)

  const generate = async () => {
    if (!desc.trim() || busy) return
    setBusy(true)
    try {
      const r = await api.promptAi({
        mode: 'generate',
        text: desc.trim(),
        existing: prompts.map((p) => p.zh),
        scope: aiScope,
      })
      setFound(r.prompts.filter((p) => !has(p.zh)).map((p) => ({ ...p, pick: true })))
      if (!r.prompts.length) toast(t('AI 没有给出新的提示词'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const addFound = () => {
    const picked = found.filter((f) => f.pick)
    onChange((l) => [...l, ...picked.map(({ pick: _, ...p }) => ({ ...p, id: newId(), enabled: true }))])
    setFound([])
    setDesc('')
  }

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-[0.8125rem] font-semibold">{t('美术提示词')}</h3>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">
            {t(
              '这个项目里每一张图生成时都会自动带上打开的提示词，设计界面的 AI 也会照着它来，让整个游戏的界面风格统一。这里显示中文，发给生图 AI 的是对应的英文。',
            )}
          </p>
        </div>
        <ImportStyle
          onImport={(st) => {
            const fresh = st.prompts.filter((p) => !has(p.zh))
            if (!fresh.length) return toast(t('这个风格的提示词都已经有了'))
            onChange((l) => [...l, ...fresh.map((p) => ({ ...p, id: newId(), enabled: true }))])
            toast.success(t('已导入 {n} 条提示词', { n: fresh.length }))
          }}
        />
        <div className="rounded-xl bg-panel p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[0.75rem] font-medium">
            <Sparkles className="h-3.5 w-3.5 text-accent-text" />
            {t('让 AI 生成')}
          </p>
          <Textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate()
            }}
            rows={2}
            placeholder={t('描述想要的美术风格，例如：西方魔幻、石头和暗金色的边框、按钮有微微发光的符文')}
            className="text-[0.8125rem]"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {busy && <span className="text-xs text-subtle">{t('AI 正在整理提示词…')}</span>}
            <Button size="sm" onClick={() => void generate()} disabled={!desc.trim() || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t('生成提示词')}
            </Button>
          </div>
          <ScopeRequests scope={`prompts:${aiScope}`} active={busy} className="mt-2 mb-0 max-w-none" />
          {found.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <p className="mb-2 text-[0.75rem] text-muted">{t('选择要加入的提示词：')}</p>
              <div className="flex flex-wrap gap-1.5">
                {found.map((f, i) => (
                  <button
                    key={i}
                    title={f.en}
                    aria-pressed={f.pick}
                    onClick={() => setFound((l) => l.map((x, k) => (k === i ? { ...x, pick: !x.pick } : x)))}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[0.75rem] transition-colors',
                      f.pick ? 'bg-accent-soft text-fg' : 'chip-idle text-subtle hover:text-fg',
                    )}
                  >
                    {f.pick ? <Check className="h-3 w-3 text-accent-text" /> : <Plus className="h-3 w-3" />}
                    <span className="text-[0.6875rem] text-subtle">{catLabel(f.category)}</span>
                    {f.zh}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setFound([])}>
                  {t('放弃')}
                </Button>
                <Button size="sm" onClick={addFound} disabled={!found.some((f) => f.pick)}>
                  {t('加入 {n} 条', { n: found.filter((f) => f.pick).length })}
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      {PROMPT_CATEGORIES.map((c) => {
        const list = prompts.filter((p) => p.category === c)
        const presets = PRESETS[c].filter((p) => !has(p.zh))
        return (
          <section key={c} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h4 className="text-[0.8125rem] font-medium">{catLabel(c)}</h4>
              <span className="text-[0.6875rem] text-subtle">{list.length || ''}</span>
              <Button variant="ghost" size="sm" onClick={() => setAdding(c)} className="ml-auto h-7 gap-1 px-1.5">
                <Plus className="h-3.5 w-3.5" />
                {t('添加')}
              </Button>
            </div>
            {(list.length > 0 || adding === c) && (
              <ul className="flex flex-col divide-y overflow-hidden rounded-xl bg-panel">
                {list.map((p) => (
                  <PromptRow
                    key={p.id}
                    p={p}
                    translating={translating.has(p.id)}
                    onChange={(n) => {
                      onChange((l) => l.map((x) => (x.id === p.id ? n : x)))
                      // 改了中文、没改英文：重新翻译
                      if (n.zh !== p.zh && n.en === p.en) onTranslate([n])
                    }}
                    onRemove={() => onChange((l) => l.filter((x) => x.id !== p.id))}
                  />
                ))}
                {adding === c && (
                  <li className="px-3 py-2">
                    <Input
                      autoFocus
                      placeholder={t('写中文就行，会自动翻译成英文')}
                      size="sm"
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation()
                          setAdding('')
                        }
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                        const zh = e.currentTarget.value.trim()
                        if (!zh) return setAdding('')
                        const item: ProjectPrompt = { id: newId(), category: c, zh, en: '', enabled: true }
                        onChange((l) => [...l, item])
                        onTranslate([item])
                        e.currentTarget.value = ''
                      }}
                      onBlur={() => setAdding('')}
                    />
                  </li>
                )}
              </ul>
            )}
            {presets.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[0.6875rem] text-subtle">{t('常用：')}</span>
                {presets.map((p) => (
                  <button
                    key={p.zh}
                    title={p.en}
                    onClick={() => onChange((l) => [...l, { id: newId(), category: c, ...p, enabled: true }])}
                    className="chip-idle flex cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[0.75rem] text-subtle transition-colors hover:text-fg"
                  >
                    <Plus className="h-3 w-3" />
                    {p.zh}
                  </button>
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function PromptRow({
  p,
  translating,
  onChange,
  onRemove,
}: {
  p: ProjectPrompt
  translating: boolean
  onChange: (p: ProjectPrompt) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [zh, setZh] = useState(p.zh)
  const [en, setEn] = useState(p.en)
  useEffect(() => {
    if (!editing) {
      setZh(p.zh)
      setEn(p.en)
    }
  }, [p, editing])
  const commit = () => {
    setEditing(false)
    if (zh.trim() && (zh.trim() !== p.zh || en.trim() !== p.en)) onChange({ ...p, zh: zh.trim(), en: en.trim() })
  }
  if (editing)
    return (
      <li className="flex flex-col gap-1.5 px-3 py-2">
        <Input value={zh} onChange={(e) => setZh(e.target.value)} size="sm" aria-label={t('中文')} />
        <Input
          value={en}
          onChange={(e) => setEn(e.target.value)}
          size="sm"
          className="font-mono text-[0.75rem]"
          aria-label={t('发给生图 AI 的英文')}
          placeholder={t('发给生图 AI 的英文')}
        />
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t('取消')}
          </Button>
          <Button size="sm" onClick={commit} disabled={!zh.trim()}>
            {t('完成')}
          </Button>
        </div>
      </li>
    )
  return (
    <li className="group flex min-h-9 items-center gap-2.5 px-3 py-1.5">
      <Checkbox
        checked={p.enabled}
        ariaLabel={p.enabled ? t('停用这条') : t('启用这条')}
        onChange={(enabled) => onChange({ ...p, enabled })}
        className="shrink-0"
      />
      <span
        title={p.en || t('还没有英文，会直接用中文')}
        className={cn('min-w-0 flex-1 truncate text-[0.8125rem]', !p.enabled && 'text-subtle line-through')}
      >
        {p.zh}
      </span>
      {translating ? (
        <span className="flex shrink-0 items-center gap-1 text-[0.6875rem] text-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('翻译中')}
        </span>
      ) : (
        !p.en && <span className="shrink-0 text-[0.6875rem] text-warning">{t('没有英文')}</span>
      )}
      <IconButton icon={Pencil} label={t('编辑')} reveal="hover" onClick={() => setEditing(true)} />
      <IconButton icon={X} tone="danger" label={t('删除')} reveal="hover" onClick={onRemove} />
    </li>
  )
}
