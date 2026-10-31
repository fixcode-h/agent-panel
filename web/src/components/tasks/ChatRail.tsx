import { useMemo, useState } from 'react'
import { Code2, Copy, FileText, FolderInput, Globe, Image as ImageIcon, Paperclip } from 'lucide-react'
import type { Attachment, TaskMessage } from '@shared/schema'
import { attachChip } from '@shared/composer'
import { t } from '@shared/i18n'
import { chatAttachments, chatCodeBlocks, chatSources, codeFileName, type ChatCode } from '@/lib/chat-rail'
import { copyText } from '@/lib/copy-text'
import { useData } from '@/lib/data'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Input, Select, SelectLook } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { SourceLink } from '@/components/ui/source-link'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { Markdown } from './Markdown'

/**
 * Chat 页（没有项目的聊天）的右栏（Chat.dc.html）：聊天没有项目文件可看，右栏换成从这段对话里抽出来的三样东西——
 * 回复里的代码（能复制、存进某个项目）、联网工具查到的来源、用户传的附件。哪一样都没有的页签不画。
 */

export type ChatRailTab = 'code' | 'sources' | 'files'

/** 三个页签各有几项：标题栏的右栏开关按它判断有没有东西可看（都没有时禁用） */
export function useChatRail(messages: readonly TaskMessage[]) {
  return useMemo(() => {
    const code = chatCodeBlocks(messages)
    const sources = chatSources(messages)
    const files = chatAttachments(messages)
    return { code, sources, files, empty: !code.length && !sources.length && !files.length }
  }, [messages])
}

const NO_TEAM = new Set<string>()

export function ChatRail({
  rail,
  onOpenFile,
}: {
  rail: ReturnType<typeof useChatRail>
  /** 点附件：用对话页的文件窗口看（图片是大图，文本是内容） */
  onOpenFile: (path: string) => void
}) {
  const tabs = (
    [
      ['code', t('代码'), rail.code.length, <Code2 key="i" className="h-3.5 w-3.5" />],
      ['sources', t('来源'), rail.sources.length, <Globe key="i" className="h-3.5 w-3.5" />],
      ['files', t('附件'), rail.files.length, <Paperclip key="i" className="h-3.5 w-3.5" />],
    ] as const
  ).filter(([, , n]) => n > 0)
  const [picked, setPicked] = useState<ChatRailTab>('code')
  // 选中的页签这时可能没东西了（撤回了带代码的那条）：落到第一个还有内容的
  const tab = tabs.some(([id]) => id === picked) ? picked : (tabs[0]?.[0] ?? 'code')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 收起放在标题栏的右栏开关上（和设计稿一致），页签条上不再放关闭按钮，页签按内容宽度排 */}
      <TabBar label={t('聊天右栏页签')}>
        {tabs.map(([id, label, n, icon]) => (
          <TabItem
            key={id}
            active={tab === id}
            onSelect={() => setPicked(id)}
            icon={icon}
            className="basis-auto pr-2"
            tag={n}
          >
            {label}
          </TabItem>
        ))}
      </TabBar>
      {tab === 'code' && <CodeTab list={rail.code} />}
      {tab === 'sources' && (
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">
          {rail.sources.map((s) => (
            <SourceLink key={s.url} url={s.url} host={s.host} path={s.path} note={s.via !== s.url ? s.via : ''} />
          ))}
        </div>
      )}
      {tab === 'files' && <FilesTab list={rail.files} onOpen={onOpenFile} />}
    </div>
  )
}

/** 代码页签：上面一行是名字和操作，下面是选中那一块的高亮源码；多块时名字是下拉，按回复里的顺序列 */
function CodeTab({ list }: { list: ChatCode[] }) {
  const [pickedId, setPickedId] = useState('')
  const [saving, setSaving] = useState(false)
  // 默认看最新的一块：通常就是刚回复里要用的那段
  const cur = list.find((c) => c.id === pickedId) ?? list.at(-1)
  if (!cur) return null
  const at = list.indexOf(cur)
  const names = list.map((c, i) => ({ value: c.id, label: `${i + 1}. ${codeFileName(c, i)}` }))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b px-3">
        {list.length > 1 ? (
          <SelectLook.Provider value="ghost">
            <Select
              aria-label={t('选择代码块')}
              value={cur.id}
              options={names}
              onChange={(e) => setPickedId(e.target.value)}
              className="mr-auto ml-0 justify-start px-1.5 font-semibold text-fg"
            />
          </SelectLook.Provider>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1.5 text-body font-semibold">{codeFileName(cur, at)}</span>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="h-7"
          onClick={() => void copyText(cur.code, { done: t('已复制'), fail: (msg) => t('复制失败：{msg}', { msg }) })}
        >
          <Copy className="h-3.5 w-3.5" />
          {t('复制')}
        </Button>
        <Button variant="secondary" size="sm" className="h-7" onClick={() => setSaving(true)}>
          <FolderInput className="h-3.5 w-3.5" />
          {t('存到项目…')}
        </Button>
      </div>
      {/* 高亮沿用回复里的代码块（同一套 Markdown 渲染），只把语言栏和外框去掉，铺满整栏 */}
      <div className="min-h-0 flex-1 overflow-auto bg-(--code-bg)">
        <Markdown
          key={cur.id}
          text={'````' + cur.lang + '\n' + cur.code + '\n````'}
          teamNames={NO_TEAM}
          className="[&_.md-code]:m-0! [&_.md-code]:rounded-none! [&_.md-code]:border-0! [&_.md-code]:bg-transparent! [&_.md-code-bar]:hidden! [&_pre]:px-4! [&_pre]:py-3.5!"
        />
      </div>
      {saving && <SaveToProject code={cur} index={at} onClose={() => setSaving(false)} />}
    </div>
  )
}

/** 存到项目：选一个项目、写项目里的相对路径；路径限在项目目录里（服务端再校验一次），同名要勾「覆盖」才改写 */
function SaveToProject({ code, index, onClose }: { code: ChatCode; index: number; onClose: () => void }) {
  const { projects } = useData()
  const usable = projects.filter((p) => p.path)
  const [projectId, setProjectId] = useState(usable[0]?.id ?? '')
  const [path, setPath] = useState(codeFileName(code, index))
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const rel = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
  const cut = rel.lastIndexOf('/')
  const dir = cut < 0 ? '' : rel.slice(0, cut)
  const name = rel.slice(cut + 1)
  const submit = async () => {
    if (!projectId || !name) return
    setBusy(true)
    setError('')
    try {
      const r = await api.saveProjectFile(projectId, dir, name, code.code, overwrite)
      const p = usable.find((x) => x.id === projectId)
      toast.success(t('已存到「{project}」的 {path}', { project: p?.name ?? '', path: r.path }))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('存到项目')}
      footer={
        <>
          <span className="min-w-0 flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button disabled={busy || !projectId || !name || /(^|\/)\.\.(\/|$)/.test(rel)} onClick={() => void submit()}>
            {t('保存')}
          </Button>
        </>
      }
    >
      {usable.length ? (
        <>
          <Field label={t('项目')}>
            <Select
              aria-label={t('项目')}
              value={projectId}
              options={usable.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          </Field>
          <Field
            label={t('项目里的相对路径')}
            hint={t('中间缺的目录会一起建好；只能写在项目目录里')}
            error={error || undefined}
          >
            <Input
              aria-label={t('项目里的相对路径')}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void submit()}
              className="h-9 font-mono text-body"
            />
          </Field>
          <Checkbox checked={overwrite} onChange={setOverwrite} label={t('已有同名文件时覆盖')} />
        </>
      ) : (
        <p className="text-body text-subtle">{t('还没有设置了目录的项目，先在「项目」里添加一个。')}</p>
      )}
    </Modal>
  )
}

/** 附件页签：一行一个，点开用对话页的文件窗口看 */
function FilesTab({ list, onOpen }: { list: Attachment[]; onOpen: (path: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">
      {list.map((a) => {
        const image = attachChip(a) === 'image'
        const Icon = image ? ImageIcon : FileText
        return (
          <button
            key={a.path}
            type="button"
            title={a.path}
            onClick={() => onOpen(a.path)}
            className={cn(
              'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-body transition-colors hover:bg-sel/60',
            )}
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-sel text-muted">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
            <span className="shrink-0 text-caption text-subtle tabular-nums">{fmtSize(a.size)}</span>
          </button>
        )
      })}
    </div>
  )
}

const fmtSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`
