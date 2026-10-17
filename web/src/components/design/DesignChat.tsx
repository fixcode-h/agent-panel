import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { extensionSelfReload } from '@shared/design'
import type { Annotation, BrowserStatus, DesignJob, DesignMessage, ImageSource } from '@shared/design'
import type { Attachment, TaskMessage, ToolUse } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useCliDef } from '@/lib/cli-models'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/input'
import { AgentMessage, PendingAuthor, SystemNote } from '@/components/tasks/Messages'
import { ChatModelPicker, useChatRun, useRunAuthor, type ChatRun } from '@/components/tasks/ChatModelPicker'
import * as D from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { AnnotationChips, KIND_COLOR, kindLabel } from './Annotations'
import {
  AttachMenu,
  AttachmentChips,
  DropHint,
  MessageAttachments,
  useAttachments,
  useDropPaste,
} from '@/components/chat/Attachments'
import { t } from '@shared/i18n'

const NO_NAMES = new Set<string>()

/** 浏览器扩展报上来的 Gemini / ChatGPT 标签页；页面开着时每几秒问一次 */
export function useBrowserTabs(fast = false) {
  const [st, setSt] = useState<BrowserStatus>({
    connected: false,
    version: '',
    latestVersion: '',
    tabs: [],
    extensionDir: '',
    browsers: [],
  })
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .browserStatus()
        .then((s) => alive && setSt(s))
        .catch(() => {})
    load()
    // 安装说明打开着时问得勤一些，装好扩展后马上能看到连上
    const timer = setInterval(load, fast ? 1500 : 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [fast])
  return st
}

const SITE = { gemini: 'Gemini', chatgpt: 'ChatGPT' }
export const sourceKey = (s: ImageSource) => (s.kind === 'browser' ? `browser:${s.tabId}` : s.kind)
export function parseSource(v: string): ImageSource {
  if (v.startsWith('browser:')) return { kind: 'browser', tabId: v.slice(8) }
  return v === 'none' ? { kind: 'none' } : { kind: 'cli' }
}

/** 生成图片的方式：设置里的图片模型、浏览器里的 Gemini / ChatGPT 标签页，或者先不生成 */
export function SourceSelect({ value, onChange }: { value: ImageSource; onChange: (s: ImageSource) => void }) {
  const { settings, clis } = useData()
  const [help, setHelp] = useState(false)
  const browser = useBrowserTabs(help)
  const imgCli = settings?.imageGen.cli || 'codex'
  const def = useCliDef(imgCli)
  const st = clis.find((c) => c.id === imgCli)
  const cliOk = !st || (st.installed && st.enabled)
  const options = [
    ...(cliOk
      ? [{ value: 'cli', label: t('图片模型 · {cli}', { cli: def?.name ?? imgCli }), group: t('图片模型') }]
      : []),
    ...browser.tabs.map((tb) => ({
      value: `browser:${tb.id}`,
      // 标签页标题一般就是「Gemini」「ChatGPT」，和站点名重复时只显示一次
      label: (tb.title || '').toLowerCase().includes(SITE[tb.site].toLowerCase())
        ? tb.title
        : `${SITE[tb.site]} · ${tb.title || tb.url}`,
      group: t('浏览器标签页'),
    })),
    {
      value: 'help',
      label: !browser.connected
        ? t('连接浏览器…')
        : browser.tabs.length
          ? t('浏览器扩展…')
          : t('打开 Gemini 或 ChatGPT…'),
      group: t('浏览器标签页'),
    },
    { value: 'none', label: t('先不生成图片'), group: ' ' },
  ]
  // 选的标签页关掉了：换成第一个能用的
  const key = sourceKey(value)
  useEffect(() => {
    if (!options.some((o) => o.value === key) && options[0]) onChange(parseSource(options[0].value))
    // 只在可选项变化时检查
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [options.map((o) => o.value).join('|')])
  return (
    <>
      <Select
        aria-label={t('生成图片的方式')}
        value={key}
        onChange={(e) => (e.target.value === 'help' ? setHelp(true) : onChange(parseSource(e.target.value)))}
        options={options}
        className="h-7 w-auto max-w-[200px] min-w-0 justify-start rounded-md border-transparent bg-transparent px-2 text-[12px] text-muted hover:bg-sel"
      />
      <BrowserHelp
        open={help}
        onOpenChange={(o) => {
          setHelp(o)
          // 连好后关掉说明：还没选浏览器标签页的话直接选上第一个
          if (!o && value.kind !== 'browser' && browser.tabs[0])
            onChange({ kind: 'browser', tabId: browser.tabs[0].id })
        }}
        status={browser}
      />
    </>
  )
}

/** 怎么连上浏览器：一键打开扩展页面装上扩展，弹窗开着时自动检测连接状态 */
function BrowserHelp({
  open,
  onOpenChange,
  status,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  status: BrowserStatus
}) {
  const [installing, setInstalling] = useState('')
  const [waiting, setWaiting] = useState(false)
  const demo = !!import.meta.env.VITE_DEMO
  const { connected, tabs } = status
  const outdated = connected && !!status.latestVersion && status.version !== status.latestVersion
  const install = async (browser: string) => {
    setInstalling(browser)
    try {
      const { dir } = await api.installExtension(browser)
      // 不想拖文件夹时，「加载已解压的扩展程序」弹出的选择窗口里可以直接粘贴路径
      await navigator.clipboard?.writeText(dir).catch(() => {})
      setWaiting(true)
      toast.success(t('已打开扩展页面，extension 文件夹已选中，把它拖到扩展页面上'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setInstalling('')
    }
  }
  const [reloading, setReloading] = useState('')
  const selfReload = extensionSelfReload(status.version)
  // 1.3 起的扩展让它自己重新加载；更早的版本只能打开扩展页面，让用户点一下扩展上的刷新按钮
  const reload = async (browser: string) => {
    setReloading(browser || 'auto')
    try {
      const { auto } = await api.reloadExtension(browser)
      toast.success(
        auto
          ? t('扩展正在刷新，几秒后会重新连上')
          : t('已打开扩展页面：点一下「Agent 面板 · 网页生图」上的刷新按钮。只需要这一次，以后会自动刷新'),
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setReloading('')
    }
  }
  const state = !connected
    ? waiting
      ? { tone: 'wait', text: t('正在等待扩展连上…装好后这里会自动变成已连上') }
      : { tone: 'off', text: t('扩展还没连上') }
    : outdated
      ? {
          tone: 'warn',
          text: t('扩展已连上，但不是最新版（{v} → {latest}）：在扩展页面点一下扩展的刷新按钮', {
            v: status.version || '?',
            latest: status.latestVersion,
          }),
        }
      : tabs.length
        ? { tone: 'ok', text: t('已连上，找到 {n} 个可以用的标签页', { n: tabs.length }) }
        : { tone: 'warn', text: t('扩展已连上，还没有打开 Gemini 或 ChatGPT') }
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 animate-[fade-in_120ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[min(540px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-6 shadow-pop">
          <D.Title className="flex items-center gap-2 font-serif text-[18px] font-semibold">
            <Globe className="h-5 w-5 text-accent" />
            {t('用浏览器里的 Gemini / ChatGPT 生成图片')}
          </D.Title>
          <D.Description className="mt-2 text-[13px] leading-relaxed text-muted">
            {t(
              '不需要图片模型的 API：面板通过一个小扩展，用你在浏览器里已经登录的 Gemini 或 ChatGPT（会员版才能生成图片）。扩展只读取这两个网站的标签页。',
            )}
          </D.Description>

          <ol className="mt-5 flex flex-col gap-4 text-[13px] leading-relaxed">
            <Step n={1} done={connected} title={t('安装扩展')}>
              <p className="text-muted">
                {t('点下面的按钮，会打开浏览器的扩展页面，并打开文件夹选中 extension 文件夹。')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {status.browsers.map((b) => (
                  <Button
                    key={b.id}
                    size="sm"
                    variant={connected ? 'secondary' : 'primary'}
                    disabled={demo || !!installing}
                    onClick={() => void install(b.id)}
                  >
                    {installing === b.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {t('安装到 {name}', { name: b.name })}
                  </Button>
                ))}
                {status.extensionDir && !demo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => api.revealExtension().catch((e) => toast.error((e as Error).message))}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t('打开扩展文件夹')}
                  </Button>
                )}
              </div>
              {!status.browsers.length && !demo && (
                <p className="mt-1.5 text-[12px] text-subtle">
                  {t('没有找到 Chrome 或 Edge：在浏览器地址栏打开 chrome://extensions 手动安装。')}
                </p>
              )}
            </Step>
            <Step n={2} done={connected} title={t('加载扩展')}>
              <p className="text-muted">
                {t(
                  '在扩展页面打开右上角的「开发者模式」，把选中的 extension 文件夹拖到扩展页面上松手就装好了（也可以点「加载已解压的扩展程序」，粘贴已复制的路径）。只要装这一次，以后面板更新时扩展会自动刷新。',
                )}
              </p>
            </Step>
            <Step n={3} done={connected && tabs.length > 0} title={t('打开 Gemini 或 ChatGPT')}>
              <p className="text-muted">{t('登录后停在聊天页面，之后就能在对话框下面选这个标签页。')}</p>
              <div className="mt-2 flex gap-2">
                <a href="https://gemini.google.com/app" target="_blank" rel="noreferrer" className={LINK}>
                  Gemini
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a href="https://chatgpt.com/" target="_blank" rel="noreferrer" className={LINK}>
                  ChatGPT
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </Step>
          </ol>

          <div
            role="status"
            className={cn(
              'mt-5 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed',
              state.tone === 'ok' && 'border-success/40 bg-success/8',
              state.tone === 'warn' && 'border-warning/40 bg-warning/8',
            )}
          >
            {state.tone === 'wait' ? (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
            ) : (
              <span
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  state.tone === 'ok' ? 'bg-success' : state.tone === 'warn' ? 'bg-warning' : 'bg-line-strong',
                )}
              />
            )}
            <div className="min-w-0 flex-1">
              <p>{state.text}</p>
              {outdated && !demo && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(selfReload ? [{ id: '', name: '' }] : status.browsers).map((b) => (
                    <Button
                      key={b.id}
                      size="sm"
                      variant="primary"
                      disabled={!!reloading}
                      onClick={() => void reload(b.id)}
                    >
                      {reloading === (b.id || 'auto') ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {selfReload ? t('一键刷新扩展') : t('打开 {name} 的扩展页面刷新', { name: b.name })}
                    </Button>
                  ))}
                </div>
              )}
              {connected && tabs.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5 text-muted">
                  {tabs.map((tb) => (
                    <li key={tb.id} className="truncate">
                      {SITE[tb.site]} · {tb.title || tb.url}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {connected && status.version && (
              <span className="shrink-0 font-mono text-[11px] text-subtle">v{status.version}</span>
            )}
          </div>

          <div className="mt-5 flex justify-end">
            <D.Close asChild>
              <Button variant={connected && tabs.length ? 'primary' : 'ghost'}>
                {connected && tabs.length ? t('完成') : t('知道了')}
              </Button>
            </D.Close>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

const LINK =
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12.5px] text-muted hover:bg-sel hover:text-fg'

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-medium',
          done ? 'bg-success text-white' : 'bg-sel text-muted',
        )}
      >
        {done ? <Check className="h-3 w-3" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </li>
  )
}

const RUN_KEY = 'design-chat-run'

/** 对话用的 CLI、模型和思考强度：记在本机，下次打开还是这个 */
function useStoredRun() {
  const [run, setRun] = useState<ChatRun>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null')
      if (v && typeof v.cli === 'string') return { cli: v.cli, model: v.model ?? '', effort: v.effort ?? '' }
    } catch {}
    return { cli: '', model: '', effort: '' }
  })
  const set = (v: ChatRun) => {
    setRun(v)
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify(v))
    } catch {}
  }
  return [run, set] as const
}

/** 设计消息换成 Agent 输出用的消息格式，和 Agent 对话显示得一样 */
const asTaskMessage = (
  id: string,
  text: string,
  at: string,
  live?: { thinking?: string; tools?: ToolUse[] },
): TaskMessage => ({
  id,
  role: 'agent',
  agentId: '',
  step: '',
  text,
  tools: live?.tools ?? [],
  thinking: live?.thinking,
  at,
})

export function DesignChat({
  messages,
  job,
  disabled,
  source,
  onSource,
  count,
  onCount,
  onSend,
  onStop,
  onRetry,
  annotations = [],
  onRemoveAnnotation,
}: {
  messages: DesignMessage[]
  job: DesignJob | null | undefined
  disabled?: boolean
  source: ImageSource
  onSource: (s: ImageSource) => void
  count: number
  onCount: (n: number) => void
  onSend: (text: string, run: ChatRun, attachments: Attachment[]) => Promise<boolean>
  onStop: () => void
  /** 重新排队生成一张失败的图 */
  onRetry?: (imageId: string) => Promise<void>
  /** 效果图上还没发出去的标注，发送时一起带上 */
  annotations?: Annotation[]
  onRemoveAnnotation?: (id: string) => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [pick, setPick] = useStoredRun()
  const { run } = useChatRun(pick)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  // 参考图、需求文档：选文件、粘贴截图、拖进来都行
  const files = useAttachments()
  const drop = useDropPaste(files.add)
  const running = job?.status === 'running'
  const designing = running && job?.phase === 'design'

  // 新消息、输出变化时滚到底（用户往上翻看时不打扰）
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, job?.text, job?.thinking, job?.tools?.length, job?.phase, running])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(200, el.scrollHeight)}px`
  }, [text])

  const send = async () => {
    const v = text.trim()
    // 只有标注、没写文字也能发：按标注改
    if ((!v && !annotations.length && !files.attachments.length) || running || sending || files.uploading) return
    setSending(true)
    stick.current = true
    try {
      if (await onSend(v, run, files.attachments)) {
        setText('')
        files.clear()
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {!messages.length && !running && (
          <div className="mt-6 flex flex-col items-center gap-3 px-2 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent">
              <Sparkles className="h-5 w-5" />
            </span>
            <p className="text-[13px] leading-relaxed text-muted">
              {t('描述想要的界面，AI 会搭好控件树并列出需要的图片，再按下面选的方式生成。')}
            </p>
            <div className="flex w-full flex-col gap-1.5">
              {[
                t('做一个暗黑奇幻风格的游戏主菜单：标题、开始游戏、设置、退出三个按钮，按钮要有高亮框'),
                t('做一个背包界面：左边 5×4 的格子，右边是选中物品的详情，格子做成子控件'),
                t('做一个战斗 HUD：左上角头像、血条和蓝条，右下角四个技能按钮带冷却'),
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setText(s)
                    box.current?.focus()
                  }}
                  className="cursor-pointer rounded-lg border px-3 py-2 text-left text-[12px] leading-relaxed text-muted hover:border-line-strong hover:bg-sel/50 hover:text-fg"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-5">
          {messages.map((msg) => (
            <ChatMessage key={msg.id} msg={msg} />
          ))}
          {designing && job && <LiveReply job={job} />}
        </div>
      </div>
      <div className="relative shrink-0 px-3 pb-3">
        {job && (running || job.images?.some((i) => i.status === 'failed')) && job.phase === 'images' ? (
          <JobProgress job={job} onRetry={onRetry} />
        ) : (
          running && job && <JobProgress job={job} />
        )}
        <div className="flex min-w-0 items-center pb-1">
          <ChatModelPicker value={pick} onChange={setPick} />
        </div>
        <div
          {...drop.container}
          className={cn(
            'relative rounded-2xl border border-line-strong bg-field shadow-card focus-within:border-accent/60',
            drop.over && 'border-accent ring-2 ring-accent/25',
          )}
        >
          {drop.over && <DropHint />}
          <AttachmentChips items={files.items} onRemove={files.remove} />
          {annotations.length > 0 && (
            <div className="border-b px-2.5 pt-2.5 pb-2">
              <AnnotationChips list={annotations} onRemove={onRemoveAnnotation} />
            </div>
          )}
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={drop.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={disabled}
            rows={2}
            placeholder={
              running
                ? t('AI 正在处理，完成后可以继续说')
                : annotations.length
                  ? t('补充说明，或直接发送让 AI 按标注修改')
                  : t('描述界面，或者说要改哪里…（也可以在效果图上标注）')
            }
            aria-label={t('告诉 AI 要做什么')}
            className="block max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed outline-none placeholder:text-subtle"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <AttachMenu onFiles={files.add} canMention={false} className="h-7 w-7" />
            <SourceSelect value={source} onChange={onSource} />
            {source.kind !== 'none' && (
              <Select
                aria-label={t('每张图生成几版')}
                value={String(count)}
                onChange={(e) => onCount(Number(e.target.value))}
                options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: t('每张 {n} 版', { n }) }))}
                className="h-7 w-auto shrink-0 justify-start rounded-md border-transparent bg-transparent px-2 text-[12px] text-muted hover:bg-sel"
              />
            )}
            <span className="flex-1" />
            {running ? (
              <button
                onClick={onStop}
                aria-label={t('停止')}
                title={t('停止')}
                className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full bg-fg text-bg hover:opacity-85"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={
                  (!text.trim() && !annotations.length && !files.attachments.length) ||
                  sending ||
                  files.uploading ||
                  disabled
                }
                aria-label={t('发送')}
                title={t('发送（Enter）')}
                className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ChatMessage({ msg }: { msg: DesignMessage }) {
  const author = useRunAuthor(msg.run as ChatRun | undefined)
  if (msg.role === 'user')
    return (
      <div className="ml-8 flex flex-col items-end gap-1.5 self-end">
        {!!msg.attachments?.length && <MessageAttachments items={msg.attachments} />}
        <div className="rounded-2xl rounded-br-md bg-sel px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
          {msg.text}
          {!!msg.annotations?.length && (
            <span className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] whitespace-normal text-muted">
              {msg.annotations.map((a, i) => (
                <span key={a.id} className="flex items-center gap-1.5">
                  <span
                    className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full px-0.5 font-mono text-[10px] font-semibold text-white"
                    style={{ background: KIND_COLOR[a.kind] }}
                  >
                    {i + 1}
                  </span>
                  <span className="truncate">
                    {kindLabel(a.kind)}
                    {a.widgets.length ? ` · ${a.widgets.slice(0, 3).join('、')}` : ''}
                    {a.note ? ` · ${a.note}` : ''}
                  </span>
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    )
  if (msg.role === 'system') return <SystemNote text={msg.text} error={msg.error} />
  return (
    <div className="flex flex-col gap-1.5">
      <AgentMessage
        m={asTaskMessage(msg.id, msg.text, msg.at)}
        teamNames={NO_NAMES}
        author={author ?? { name: t('AI'), cli: '', icon: 'sparkles' }}
      />
      {!!msg.images?.length && (
        <span className="pl-[38px] text-[11.5px] text-subtle">{t('需要的图片：{n} 张', { n: msg.images.length })}</span>
      )}
    </div>
  )
}

/** 正在输出的回复：思考、工具调用和说明边出边显示，和 Agent 的输出一样 */
function LiveReply({ job }: { job: DesignJob }) {
  const author = useRunAuthor(job.run as ChatRun | undefined) ?? { name: t('AI'), cli: '', icon: 'sparkles' }
  const writingJson = job.outChars > job.text.length + 20
  const empty = !job.text && !job.thinking?.trim() && !job.tools?.length
  return (
    <div className="flex flex-col gap-1.5">
      {empty ? (
        <PendingAuthor author={author}>
          <span className="thinking-shimmer text-[12.5px] text-subtle">{t('正在思考…')}</span>
        </PendingAuthor>
      ) : (
        <AgentMessage
          m={asTaskMessage('live', job.text, '', { thinking: job.thinking, tools: job.tools })}
          teamNames={NO_NAMES}
          author={author}
          live
        />
      )}
      {writingJson && <LiveOutput job={job} />}
    </div>
  )
}

/** 正在写的控件树和图片清单：像 Claude Code 写文件一样边写边显示，自动滚到最新的地方 */
function LiveOutput({ job }: { job: DesignJob }) {
  const box = useRef<HTMLPreElement>(null)
  const [follow, setFollow] = useState(true)
  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [job.out, follow])
  return (
    <div className="ml-[38px] min-w-0 overflow-hidden rounded-lg border bg-field">
      <div className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        <span className="min-w-0 flex-1 truncate">
          <span className="mr-1.5 font-sans font-medium text-fg/80">{job.attempt > 1 ? t('修正格式') : t('写入')}</span>
          {t('控件树和图片清单')}
        </span>
        <span className="shrink-0 text-subtle tabular-nums">{t('{n} 个字符', { n: job.outChars })}</span>
      </div>
      {job.out && (
        <pre
          ref={box}
          // 用户往上翻时不再自动滚动，翻回底部再跟随
          onScroll={(e) => {
            const el = e.currentTarget
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
          }}
          className="max-h-[220px] overflow-auto border-t bg-card/60 px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]"
        >
          {job.out}
        </pre>
      )}
    </div>
  )
}

/** 固定在输入框上方的进度：设计时是一行状态，生成图片时是每张图的进度 */
function JobProgress({ job, onRetry }: { job: DesignJob; onRetry?: (imageId: string) => Promise<void> }) {
  const [, tick] = useState(0)
  const [open, setOpen] = useState(true)
  const [retrying, setRetrying] = useState('')
  const running = job.status === 'running'
  const failedN = (job.images ?? []).filter((i) => i.status === 'failed').length
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const sec = Math.round((Date.now() - job.startedAt) / 1000)
  const items = job.phase === 'images' ? (job.images ?? []) : []
  const done = items.filter((i) => i.status === 'done' || i.status === 'failed').length
  const want = items.reduce((n, i) => n + i.want, 0)
  const got = items.reduce((n, i) => n + Math.min(i.got, i.want), 0)
  const active = items.filter((i) => i.status === 'generating')
  return (
    <div className="mb-2 flex flex-col gap-2 rounded-xl border bg-card px-3 py-2.5 text-[12.5px] shadow-card">
      <button
        onClick={() => setOpen(!open)}
        disabled={!items.length}
        aria-expanded={items.length ? open : undefined}
        className="flex cursor-pointer items-center gap-2 font-medium text-muted disabled:cursor-default"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
        )}
        <span className="min-w-0 truncate">
          {!running
            ? t('有 {n} 张图片没有生成出来', { n: failedN })
            : job.phase === 'images'
              ? t('正在生成图片 {i}/{n}', { i: done, n: items.length })
              : job.attempt > 1
                ? t('格式不对，正在修正')
                : t('正在设计')}
        </span>
        {running && (
          <span className="ml-auto shrink-0 font-mono text-[11px] font-normal text-subtle tabular-nums">{sec}s</span>
        )}
        {items.length > 0 && (
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', !open && '-rotate-90')} />
        )}
      </button>
      {items.length > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-sel">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${want ? Math.max(4, (got / want) * 100) : 0}%` }}
          />
        </div>
      )}
      {open && items.length > 0 && (
        <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className="flex min-w-0 items-center gap-2 text-[12px]">
              {i.status === 'done' ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : i.status === 'failed' ? (
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
              ) : i.status === 'generating' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
              ) : (
                <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />
                </span>
              )}
              <span className={cn('shrink-0 font-mono', i.status === 'waiting' ? 'text-subtle' : 'text-fg')}>
                {i.name}
              </span>
              <span
                className={cn('min-w-0 flex-1 truncate', i.status === 'failed' ? 'text-danger' : 'text-subtle')}
                title={i.text}
              >
                {i.text ?? ''}
              </span>
              {i.want > 1 && (
                <span className="shrink-0 font-mono text-[11px] text-subtle tabular-nums">
                  {i.got}/{i.want}
                </span>
              )}
              {i.status === 'failed' && onRetry && (
                <button
                  disabled={!!retrying}
                  onClick={() => {
                    setRetrying(i.id)
                    void onRetry(i.id).finally(() => setRetrying(''))
                  }}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-px text-[11.5px] text-accent hover:bg-sel disabled:cursor-default disabled:opacity-50"
                >
                  {retrying === i.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  {t('重试')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!open && active[0]?.text && <p className="truncate text-[11.5px] text-subtle">{active[0].text}</p>}
    </div>
  )
}
