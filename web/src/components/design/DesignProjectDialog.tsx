import { useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Check, Loader2, Palette, Pencil, Plus, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { PROMPT_CATEGORIES, type DesignProject, type ProjectPrompt, type PromptCategory } from '@shared/design'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Field, FormSection, Input, Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { DirPicker, useDirInfo } from '@/components/projects/DirPicker'
import { DialogCloseButton, NavItem } from '@/components/projects/ProjectSettingsDialog'
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
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          // 改到一半点到外面不关闭，免得白填
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(760px,calc(100dvh-2rem))] w-[min(980px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
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
        </D.Content>
      </D.Portal>
    </D.Root>
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
        <D.Title className="min-w-0 flex-1 truncate font-serif text-[18px] font-semibold">
          {project ? t('项目设置 · {name}', { name: project.name }) : t('新建 UI 项目')}
        </D.Title>
        <DialogCloseButton />
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={t('项目设置分类')}
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[220px] md:flex-col md:border-r md:border-b-0 md:p-3"
        >
          <NavItem on={section === 'general'} onClick={() => setSection('general')}>
            <Settings2 className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('常规')}
          </NavItem>
          <NavItem
            on={section === 'prompts'}
            onClick={() => setSection('prompts')}
            hint={enabled ? String(enabled) : undefined}
          >
            <Palette className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('美术提示词')}
          </NavItem>
        </nav>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
          {section === 'general' ? (
            <form
              className="flex flex-col gap-7"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <FormSection title={t('基本信息')}>
                <p className="-mt-2 text-[12.5px] leading-relaxed text-muted">
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
  const [found, setFound] = useState<(Omit<ProjectPrompt, 'id' | 'enabled'> & { pick: boolean })[]>([])
  const [adding, setAdding] = useState<PromptCategory | ''>('')
  const has = (zh: string) => prompts.some((p) => p.zh === zh)

  const generate = async () => {
    if (!desc.trim() || busy) return
    setBusy(true)
    try {
      const r = await api.promptAi({ mode: 'generate', text: desc.trim(), existing: prompts.map((p) => p.zh) })
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
          <h3 className="text-[13px] font-semibold">{t('美术提示词')}</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            {t(
              '这个项目里每一张图生成时都会自动带上打开的提示词，设计界面的 AI 也会照着它来，让整个游戏的界面风格统一。这里显示中文，发给生图 AI 的是对应的英文。',
            )}
          </p>
        </div>
        <div className="rounded-xl border bg-panel/50 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
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
            className="text-[13px]"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {busy && <span className="text-xs text-subtle">{t('AI 正在整理提示词…')}</span>}
            <Button size="sm" onClick={() => void generate()} disabled={!desc.trim() || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t('生成提示词')}
            </Button>
          </div>
          {found.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <p className="mb-2 text-[12px] text-muted">{t('选择要加入的提示词：')}</p>
              <div className="flex flex-wrap gap-1.5">
                {found.map((f, i) => (
                  <button
                    key={i}
                    title={f.en}
                    aria-pressed={f.pick}
                    onClick={() => setFound((l) => l.map((x, k) => (k === i ? { ...x, pick: !x.pick } : x)))}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-[12.5px]',
                      f.pick ? 'border-accent/60 bg-accent-soft text-fg' : 'text-subtle hover:text-fg',
                    )}
                  >
                    {f.pick ? <Check className="h-3 w-3 text-accent" /> : <Plus className="h-3 w-3" />}
                    <span className="text-[11px] text-subtle">{catLabel(f.category)}</span>
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
              <h4 className="text-[13px] font-medium">{catLabel(c)}</h4>
              <span className="text-[11.5px] text-subtle">{list.length || ''}</span>
              <button
                onClick={() => setAdding(c)}
                className="ml-auto flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-subtle hover:bg-sel hover:text-fg"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('添加')}
              </button>
            </div>
            {(list.length > 0 || adding === c) && (
              <ul className="flex flex-col divide-y rounded-xl border">
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
                      className="h-8 text-[13px]"
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
                <span className="mr-1 text-[11.5px] text-subtle">{t('常用：')}</span>
                {presets.map((p) => (
                  <button
                    key={p.zh}
                    title={p.en}
                    onClick={() => onChange((l) => [...l, { id: newId(), category: c, ...p, enabled: true }])}
                    className="flex cursor-pointer items-center gap-0.5 rounded-md border border-dashed px-1.5 py-0.5 text-[12px] text-subtle hover:border-solid hover:text-fg"
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
        <Input value={zh} onChange={(e) => setZh(e.target.value)} className="h-8 text-[13px]" aria-label={t('中文')} />
        <Input
          value={en}
          onChange={(e) => setEn(e.target.value)}
          className="h-8 font-mono text-[12px]"
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
      <button
        role="checkbox"
        aria-checked={p.enabled}
        aria-label={p.enabled ? t('停用这条') : t('启用这条')}
        onClick={() => onChange({ ...p, enabled: !p.enabled })}
        className={cn(
          'grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded border',
          p.enabled ? 'border-accent bg-accent text-white' : 'border-line-strong',
        )}
      >
        {p.enabled && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      <span
        title={p.en || t('还没有英文，会直接用中文')}
        className={cn('min-w-0 flex-1 truncate text-[13px]', !p.enabled && 'text-subtle line-through')}
      >
        {p.zh}
      </span>
      {translating ? (
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('翻译中')}
        </span>
      ) : (
        !p.en && <span className="shrink-0 text-[11.5px] text-warning">{t('没有英文')}</span>
      )}
      <button
        onClick={() => setEditing(true)}
        aria-label={t('编辑')}
        title={t('编辑')}
        className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:bg-sel hover:text-fg focus-visible:opacity-100"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onRemove}
        aria-label={t('删除')}
        title={t('删除')}
        className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:bg-sel hover:text-danger focus-visible:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}
