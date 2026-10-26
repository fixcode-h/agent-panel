import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Brush,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  Paintbrush,
  Palette,
  Pencil,
  Quote,
  ScanSearch,
  X,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import { extensionSelfReload, hasMask } from '@shared/design'
import type {
  Annotation,
  BrowserStatus,
  DesignJob,
  DesignMessage,
  ImageSource,
  ReplyPart,
  SavedStyle,
  WidgetCitation,
} from '@shared/design'
import type { Attachment, TaskMessage, ToolUse } from '@shared/schema'
import { api } from '@/lib/api'
import { useScopedSetting } from '@/lib/useScopedSetting'
import { useData, useNav } from '@/lib/data'
import { needsInputImage, workflowInKind, type ComfyWorkflow } from '@shared/local-image'
import { useCliDef } from '@/lib/cli-models'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { ChatReply, DeliveryLine, PendingAuthor, SystemNote } from '@/components/tasks/Messages'
import { conversationAround } from '@shared/fix'
import { ChatComposer, useDraft } from '@/components/chat/ChatComposer'
import { ConversationShell, useConversationScroll } from '@/components/chat/ConversationShell'
import { AnswerMessage, UserMessage, msgAction } from '@/components/chat/ChatMessage'
import { ChatModelPicker, useChatRun, useRunAuthor, type ChatRun } from '@/components/tasks/ChatModelPicker'
import * as D from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { AnnotationChips, markColor, markLabel } from './Annotations'
import { DesignAnalysisCard } from './DesignAnalysisCard'
import { analysisButtonState } from '@shared/design-analysis'
import { ATTACHMENT_PROMPT, useAttachments } from '@/components/chat/Attachments'
import type { RichInputHandle } from '@/components/chat/RichInput'
import { forSend } from '@shared/composer'
import { QuestionPanel } from '@/components/chat/QuestionPanel'
import { useSlashMenu } from '@/components/chat/SlashMenu'
import { AskToggle, useAskUser, useScopeRequests } from '@/components/chat/AskToggle'
import { RequestCard, asksQuestion } from '@/components/tasks/RequestCard'
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

/** 本机 ComfyUI 的工作流和哪些能用（模型下载好了）；不常变，进来时读一次、之后慢慢刷新 */
export function useLocalWorkflows() {
  const [st, setSt] = useState<{ list: ComfyWorkflow[]; ready: string[]; loaded?: boolean }>({ list: [], ready: [] })
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .comfyWorkflows()
        .then((s) => alive && setSt({ ...s, loaded: true }))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 20000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return st
}

const SITE = { gemini: 'Gemini', chatgpt: 'ChatGPT' }
export const sourceKey = (s: ImageSource) =>
  s.kind === 'browser' ? `browser:${s.tabId}` : s.kind === 'local' ? `local:${s.workflow}` : s.kind
export function parseSource(v: string): ImageSource {
  if (v.startsWith('browser:')) return { kind: 'browser', tabId: v.slice(8) }
  if (v.startsWith('local:')) return { kind: 'local', workflow: v.slice(6) || 'auto' }
  return v === 'none' ? { kind: 'none' } : { kind: 'cli' }
}

/** 生成图片的方式：设置里的图片模型、浏览器里的 Gemini / ChatGPT 标签页，或者先不生成 */
export function SourceSelect({
  value,
  onChange,
  kind = 'game',
}: {
  value: ImageSource
  onChange: (s: ImageSource) => void
  kind?: 'game' | 'web'
}) {
  const { settings, clis } = useData()
  const { openSettings } = useNav()
  const local = useLocalWorkflows()
  const localReady = local.list.filter(
    // 去背景、图生图、放大这类要一张原图才能跑的工作流不列：这里只能出整张图，选了也只会在生成时失败
    (w) => workflowInKind(w, kind) && local.ready.includes(w.id) && !needsInputImage(w.graph),
  )
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
    // 还没读到工作流时保留已选的本机方式，免得被换成别的
    ...(!local.loaded && value.kind === 'local'
      ? [{ value: sourceKey(value), label: t('本机 ComfyUI'), group: t('本机 ComfyUI') }]
      : []),
    ...(localReady.length
      ? [
          { value: 'local:auto', label: t('本机 · 按图片用途自动选工作流'), group: t('本机 ComfyUI') },
          ...localReady.map((w) => ({
            value: `local:${w.id}`,
            label: t('本机 · {name}', { name: w.name }),
            group: t('本机 ComfyUI'),
          })),
        ]
      : []),
    {
      value: 'local-setup',
      label: localReady.length ? t('管理本机模型…') : t('配置本机生图（ComfyUI）…'),
      group: t('本机 ComfyUI'),
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
        onChange={(e) =>
          e.target.value === 'help'
            ? setHelp(true)
            : e.target.value === 'local-setup'
              ? openSettings('local-image')
              : onChange(parseSource(e.target.value))
        }
        options={options}
        className="h-7 w-auto max-w-[200px] min-w-0 justify-start rounded-md border-transparent bg-transparent px-2 text-[0.75rem] text-muted hover:bg-sel"
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
      await copyText(dir, { fail: false })
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
          <D.Title className="flex items-center gap-2 font-serif text-[1.125rem] font-semibold">
            <Globe className="h-5 w-5 text-accent" />
            {t('用浏览器里的 Gemini / ChatGPT 生成图片')}
          </D.Title>
          <D.Description className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
            {t(
              '不需要图片模型的 API：面板通过一个小扩展，用你在浏览器里已经登录的 Gemini 或 ChatGPT（会员版才能生成图片）。扩展只读取这两个网站的标签页。',
            )}
          </D.Description>

          <ol className="mt-5 flex flex-col gap-4 text-[0.8125rem] leading-relaxed">
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
                <p className="mt-1.5 text-[0.75rem] text-subtle">
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
              'mt-5 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[0.78125rem] leading-relaxed',
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
              <span className="shrink-0 font-mono text-[0.6875rem] text-subtle">v{status.version}</span>
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
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[0.78125rem] text-muted hover:bg-sel hover:text-fg'

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'grid h-5 w-5 shrink-0 place-items-center rounded-full text-[0.6875rem] font-medium',
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

/**
 * 「先出原画」开关，和「提问」开关放在一起：打开时 AI 先画整屏的效果图给你挑，
 * 确认一张作为模板后才搭界面、出切图；关着时直接搭界面。
 * 右键设置一次出几张原画，和输入框旁边的「每张几版」是两个独立的数
 */
function ConceptToggle({
  value,
  onChange,
  template,
  count,
  onCount,
}: {
  value: boolean
  onChange: (v: boolean) => void
  /** 已经确认了模板：AI 照着模板做，开关不起作用 */
  template: boolean
  /** 一次出几张原画 */
  count: number
  onCount: (n: number) => void
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onChange(!value)}
          aria-pressed={value}
          aria-label={t('先出原画')}
          title={
            template
              ? t('已经确认了原画模板，AI 照着模板搭界面（在原画里取消模板可以重新挑）')
              : value
                ? t('先画几张整屏原画给你挑，确认模板后再搭界面（点一下改成直接搭界面；右键设置一次出几张）')
                : t('直接搭界面（点一下改成先出原画；右键设置一次出几张）')
          }
          className={cn(
            'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.75rem] transition-colors',
            value && !template ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-sel hover:text-fg',
          )}
        >
          <Brush className="h-4 w-4" />
          {t('原画')}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{t('一次出几张原画')}</ContextMenuLabel>
        {[1, 2, 3, 4].map((n) => (
          <ContextMenuItem
            key={n}
            role="menuitemradio"
            aria-checked={count === n}
            onSelect={() => onCount(n)}
            className="justify-between"
          >
            {t('{n} 张', { n })}
            {count === n && <Check className="h-3.5 w-3.5" />}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 「只重绘蒙版区域」：默认关着，按原来的方式整张重画；打开时只重画涂过的区域。
 * 只有本机 ComfyUI 能按蒙版重绘，别的生图方式会降级成整张重画，按钮上先说清楚
 */
function InpaintToggle({
  value,
  onChange,
  supported,
}: {
  value: boolean
  onChange: (v: boolean) => void
  supported: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      aria-label={t('只重绘蒙版区域')}
      title={
        supported
          ? t('只重画涂过的区域，其余保持不变（本机 ComfyUI）')
          : t('当前生成方式不支持局部重绘，勾选后发送会整张重画，并在发送后提示')
      }
      className={cn(
        'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.75rem] transition-colors',
        value ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-sel hover:text-fg',
      )}
    >
      <Paintbrush className="h-4 w-4" />
      {t('只重绘蒙版')}
      {!supported && value && <span className="text-[0.6875rem] text-warning">{t('会整张重画')}</span>}
    </button>
  )
}

/** 每个设计各自记住「先出原画」；没选过时新的空白游戏界面默认打开，已经搭好的界面默认关着 */
function useConceptFirst(designId: string, fallback: boolean) {
  return useScopedSetting<boolean>(
    'design-concept',
    designId,
    (raw) => (raw === null ? fallback : raw === '1'),
    (v) => (v ? '1' : '0'),
  )
}

const RUN_KEY = 'design-chat-run'

/** 对话用的 CLI、模型和思考强度：记在本机，下次打开还是这个 */
/** 对话用的 CLI、模型和思考强度：每个设计各自记住 */
function useStoredRun(designId: string) {
  return useScopedSetting<ChatRun>(
    RUN_KEY,
    designId,
    (raw) => {
      try {
        const v = JSON.parse(raw ?? 'null')
        if (v && typeof v.cli === 'string') return { cli: v.cli, model: v.model ?? '', effort: v.effort ?? '' }
      } catch {}
      return { cli: '', model: '', effort: '' }
    },
    (v) => JSON.stringify(v),
  )
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
  onAnalyze,
  onStop,
  onRetry,
  kind = 'game',
  designId,
  dir,
  annotations = [],
  onRemoveAnnotation,
  cites = [],
  onRemoveCite,
  onClearCites,
  hasTemplate,
  request,
  inpaint = false,
  onInpaint,
  conceptDefault = false,
}: {
  messages: DesignMessage[]
  job: DesignJob | null | undefined
  disabled?: boolean
  source: ImageSource
  onSource: (s: ImageSource) => void
  count: number
  onCount: (n: number) => void
  onSend: (
    text: string,
    run: ChatRun,
    attachments: Attachment[],
    extra: {
      askUser: boolean
      style?: string
      styleName?: string
      answers?: { question: string; answer: string }[]
      concept: boolean
      /** 只重绘原画上蒙版涂过的区域；不支持局部重绘的来源会降级成整张重画 */
      inpaint?: boolean
      /** 「先出原画」时一次出几张，和每张图生成几版是两回事 */
      conceptCount?: number
      /** 这次一起发出去引用的控件 */
      refs?: WidgetCitation[]
    },
  ) => Promise<boolean>
  /** 「AI 分析」：只读检查对话和生成的 UI，不改设计、不生成图片 */
  onAnalyze: (run: ChatRun) => Promise<boolean | void>
  onStop: () => void
  /** 已经确认了原画模板：「先出原画」开关不再起作用，AI 照着模板做 */
  hasTemplate?: boolean
  /** 页面要替用户发的一句话（例如确认模板后让 AI 开始搭界面）：id 变了就发一次 */
  request?: { id: string; text?: string; kind?: 'send' }
  /** 只重绘原画上蒙版涂过的区域（在工具栏里勾选）：状态在页面上，原画面板的发送按钮也要读它 */
  inpaint?: boolean
  onInpaint?: (v: boolean) => void
  /** 「先出原画」第一次打开时默认开着（新的、空白的游戏界面） */
  conceptDefault?: boolean
  /** 哪个设计：对话的 CLI、模型各个设计分开记 */
  designId: string
  /** 设计所属项目的目录：出错交给 AI 排查时一起带上 */
  dir?: string
  /** 游戏 UI 还是网页 UI：示例要求不一样 */
  kind?: 'game' | 'web'
  /** 重新排队生成一张失败的图 */
  onRetry?: (imageId: string) => Promise<void>
  /** 效果图上还没发出去的标注，发送时一起带上 */
  annotations?: Annotation[]
  onRemoveAnnotation?: (id: string) => void
  /** 引用到对话里的控件：显示成可删除的引用条，随消息一起发出去 */
  cites?: WidgetCitation[]
  onRemoveCite?: (id: string) => void
  onClearCites?: () => void
}) {
  // 没发出去的内容按设计分开记，切到别的设计再回来还在
  const [text, setText] = useDraft(`design:${designId}`)
  const [sending, setSending] = useState(false)
  const [pick, setPick] = useStoredRun(designId)
  const [askUser, setAskUserState] = useAskUser(designId)
  const [concept, setConcept] = useConceptFirst(designId, conceptDefault)
  // 一次出几张原画：每个设计各自记住；第一次打开沿用输入框现在的「每张几版」，两个数之后互不影响
  const [conceptCount, setConceptCount] = useScopedSetting<number>(
    'design-concept-count',
    designId,
    (raw) => Math.max(1, Math.min(4, Number(raw) || 3)),
    String,
    () => count,
  )
  const { run } = useChatRun(pick)
  const box = useRef<RichInputHandle>(null)
  // 参考图、需求文档：选文件、粘贴截图、拖进来都行，在输入框上方以附件卡片显示
  const files = useAttachments()
  const running = job?.status === 'running'
  const conceptRound = concept && !hasTemplate
  const designing = running && job?.phase === 'design'
  // 原画上涂了蒙版：可以勾选「只重绘蒙版」，默认还是整张重画
  // （勾选状态存在页面上：原画面板的发送按钮要按它显示「只发蒙版这块」）
  const maskReady = annotations.some((a) => hasMask(a) && a.target.startsWith('concept:'))
  const canInpaintHere = source.kind === 'local'
  // CLI 执行中的审批和提问
  const asks = useScopeRequests(`design:${designId}`, running)
  // AI 回复里先问用户的问题（例如整体风格）：最后一条回复带问题、还没回答时，问题面板换掉输入框
  const lastMsg = messages.at(-1)
  const designQs = lastMsg?.role === 'agent' ? (lastMsg.questions ?? (lastMsg.question ? [lastMsg.question] : [])) : []
  const [dismissed, setDismissed] = useState('')
  const askDesign = !running && designQs.length > 0 && dismissed !== lastMsg?.id
  // 「/」：用选的 CLI 自己带的命令和 Skill，展开后放进设计要求里
  const slash = useSlashMenu({ cli: run.cli, scope: 'skills', setText, editor: box })

  // 消息区贴底：和任务对话共用同一个判定（只有真的往上滚才松开），换设计时重新贴底
  const scroller = useConversationScroll(designId)

  // 从「+」里引入的风格：随下一条消息一起发出，设计就按它的整体风格做
  const [styleRef, setStyleRef] = useState<SavedStyle | null>(null)
  const styleText = styleRef ? t('使用「{name}」风格', { name: styleRef.name }) : ''

  const send = async () => {
    const v = forSend(text, styleText || (files.attachments.length ? ATTACHMENT_PROMPT : ''))
    if (running) {
      // 正在回复：整条消息交给服务端补充给这一轮，收不下就在这一轮结束后自动接着处理
      if (sending || (!v && !cites.length)) return
      setSending(true)
      scroller.pin()
      try {
        if (
          await onSend(v, run, files.attachments, {
            askUser,
            concept,
            inpaint: false,
            refs: cites,
            conceptCount,
            ...(styleRef ? { style: styleRef.en, styleName: styleRef.name } : {}),
          })
        ) {
          setText('')
          files.clear()
          setStyleRef(null)
          onClearCites?.()
        }
      } finally {
        setSending(false)
      }
      return
    }
    // 只有标注、引用或附件、没写文字也能发
    if ((!v && !annotations.length && !files.attachments.length && !cites.length) || sending || files.uploading) return
    setSending(true)
    scroller.pin()
    try {
      if (
        await onSend(v, run, files.attachments, {
          askUser,
          concept,
          inpaint: inpaint && maskReady,
          refs: cites,
          conceptCount,
          ...(styleRef ? { style: styleRef.en, styleName: styleRef.name } : {}),
        })
      ) {
        setText('')
        files.clear()
        setStyleRef(null)
        onClearCites?.()
      }
    } finally {
      setSending(false)
    }
  }

  // 「AI 分析」：只读检查当前对话和设计。分析中的按钮变成取消，不占输入框和工具栏
  const [analyzing, setAnalyzing] = useState(false)
  const analysisRunning = running && job?.mode === 'analyze'
  const analysisState = analysisButtonState({
    running,
    mode: job?.mode,
    sending: sending || analyzing,
    asking: askDesign,
  })
  const analyze = async () => {
    if (analysisState === 'stop') return onStop()
    if (analysisState !== 'analyze') return
    setAnalyzing(true)
    scroller.pin()
    try {
      await onAnalyze(run)
    } finally {
      setAnalyzing(false)
    }
  }
  // 分析建议：作为一条新消息走现有的发送流程，可以继续补充再发
  const applyAnalysis = async (v: string) => {
    if (running || sending) return
    setSending(true)
    scroller.pin()
    try {
      await onSend(v, run, [], { askUser, concept, inpaint: false, conceptCount })
    } finally {
      setSending(false)
    }
  }

  // 回答了 AI 问的问题：全部答案一起作为一条消息发出去；选了带 style 的选项（整体风格）先定到设计里
  const answerDesign = async (answers: string[], picked: number[][]) => {
    if (running || sending) return
    setSending(true)
    scroller.pin()
    const style = designQs.flatMap((q, i) => picked[i].map((k) => q.options[k]?.style ?? '')).find(Boolean)
    const text = designQs.length === 1 ? answers[0] : designQs.map((q, i) => `${q.text}：${answers[i]}`).join('\n')
    try {
      await onSend(text, run, [], {
        askUser,
        concept,
        inpaint: false,
        conceptCount,
        ...(style ? { style } : {}),
        answers: designQs.map((q, i) => ({ question: q.text, answer: answers[i] ?? '' })),
      })
    } finally {
      setSending(false)
    }
  }

  // 页面替用户发的话：kind 为 send 时是图上的「发送标注给 AI」，走和输入框发送完全一样的路径
  // （带上输入框里写的意见、蒙版勾选）；否则就是固定的一句话（确认模板后开始搭界面）
  useEffect(() => {
    if (!request) return
    scroller.pin()
    if (request.kind === 'send') void send()
    else void onSend(request.text ?? '', run, [], { askUser, concept, inpaint: false })
    // 每个请求只发一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConversationShell scroller={scroller}>
        {!messages.length && !running && (
          <div className="mt-6 flex flex-col items-center gap-3 px-2 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent">
              <Sparkles className="h-5 w-5" />
            </span>
            <p className="text-[0.8125rem] leading-relaxed text-muted">
              {concept && !hasTemplate
                ? t(
                    '描述想要的界面，AI 先画几张整屏的原画给你挑，可以在图上标注修改；确认一张作为模板后再搭界面、出切图。',
                  )
                : t('描述想要的界面，AI 会搭好控件树并列出需要的图片，再按下面选的方式生成。')}
            </p>
            <div className="flex w-full flex-col gap-1.5">
              {(kind === 'web'
                ? [
                    t('做一个 SaaS 产品首页：顶部导航、左文右图的头图、三张功能卡片和页脚，暖色调'),
                    t('做一个登录页：左边品牌插图，右边邮箱、密码输入框和登录按钮'),
                    t('做一个电商商品详情页：大图、标题价格、规格选择、加入购物车按钮'),
                    t('照着附上的截图做一个一样的页面（点左下角的 + 附上截图，或直接粘贴）'),
                  ]
                : [
                    t('做一个暗黑奇幻风格的游戏主菜单：标题、开始游戏、设置、退出三个按钮，按钮要有高亮框'),
                    t('做一个背包界面：左边 5×4 的格子，右边是选中物品的详情，格子做成子控件'),
                    t('做一个战斗 HUD：左上角头像、血条和蓝条，右下角四个技能按钮带冷却'),
                    t('照着附上的截图做一个一样的界面（点左下角的 + 附上截图，或直接粘贴）'),
                  ]
              ).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setText(s)
                    box.current?.focus()
                  }}
                  className="cursor-pointer rounded-lg border px-3 py-2 text-left text-[0.75rem] leading-relaxed text-muted hover:border-line-strong hover:bg-sel/50 hover:text-fg"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-5">
          {messages.map((msg, i) => (
            <ChatMessage
              key={msg.id}
              msg={msg}
              msgs={messages}
              dir={dir}
              last={i === messages.length - 1 && !running}
              disabled={running || sending}
              onApplyAnalysis={(v) => void applyAnalysis(v)}
              onResend={
                running
                  ? undefined
                  : (v) => {
                      setText(v)
                      box.current?.focus()
                    }
              }
            />
          ))}
          {designing && job && <LiveReply job={job} />}
        </div>
      </ConversationShell>
      <div className="relative shrink-0 px-3 pb-3">
        <RequestCard requests={asks.list} onAnswer={asks.answer} onClose={asks.close} className="mb-2" />
        {askDesign && (
          <QuestionPanel
            questions={designQs.map((q) => ({
              header: q.header,
              question: q.text,
              multiSelect: q.multiSelect,
              options: q.options.map((o) => ({ label: o.label, description: o.desc })),
            }))}
            onSubmit={answerDesign}
            onSkip={() => setDismissed(lastMsg?.id ?? '')}
            skipLabel={t('自己说')}
            // 这一轮已经结束了，没有要终止的：关闭就是这些问题不回答
            onClose={() => setDismissed(lastMsg?.id ?? '')}
            closeLabel={t('不回答')}
          />
        )}
        {job && (running || job.images?.some((i) => i.status === 'failed')) && job.phase === 'images' ? (
          <JobProgress job={job} onRetry={onRetry} />
        ) : (
          running && job && <JobProgress job={job} />
        )}
        <div className="flex min-w-0 items-center gap-1 pb-1">
          <ChatModelPicker value={pick} onChange={setPick} />
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void analyze()}
            disabled={analysisState === 'disabled' || analysisState === 'busy' || analyzing}
            aria-label={analysisRunning ? t('取消分析') : analyzing ? t('分析中…') : t('AI 分析')}
            title={
              analysisState === 'stop'
                ? t('停止这次分析')
                : analysisState === 'busy'
                  ? t('等当前这一轮结束再分析')
                  : analysisState === 'disabled'
                    ? t('等 AI 回答完再分析')
                    : t('检查当前的对话和设计是否合理，列出需要修改的地方')
            }
            className={cn(
              'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.75rem] transition-colors',
              analysisRunning || analyzing ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-sel hover:text-fg',
              (analysisState === 'disabled' || analysisState === 'busy' || analyzing) &&
                'cursor-default opacity-45 hover:bg-transparent hover:text-muted',
            )}
          >
            {analysisRunning || analyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanSearch className="h-3.5 w-3.5" />
            )}
            {analysisRunning ? t('取消分析') : analyzing ? t('分析中…') : t('AI 分析')}
          </button>
        </div>
        {!askDesign && !asksQuestion(asks.list) && (
          <ChatComposer
            size="sm"
            value={text}
            onChange={setText}
            onSubmit={() => void send()}
            files={files}
            taRef={box}
            disabled={disabled}
            menus={slash.menu}
            onSync={slash.sync}
            onKeyDown={slash.onKeyDown}
            above={
              (annotations.length > 0 || styleRef || cites.length > 0) && (
                <div className="flex flex-col gap-1.5 border-b px-2.5 pt-2.5 pb-2">
                  {styleRef && (
                    <span className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-lg bg-accent-soft px-2 py-1 text-[0.75rem] text-accent">
                      <Palette className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate" title={styleRef.en}>
                        {t('风格：{name}', { name: styleRef.name })}
                      </span>
                      <button
                        type="button"
                        aria-label={t('不用这个风格')}
                        onClick={() => setStyleRef(null)}
                        className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded hover:bg-accent/15"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                  {annotations.length > 0 && <AnnotationChips list={annotations} onRemove={onRemoveAnnotation} />}
                  {cites.length > 0 && <CitationChips list={cites} onRemove={onRemoveCite} />}
                </div>
              )
            }
            attach={{ self: designId, onStyle: setStyleRef, styleKind: kind }}
            tools={
              <>
                <AskToggle
                  value={askUser}
                  onChange={(v) => {
                    setAskUserState(v)
                    // 执行中改也马上生效：等着的问题会按新的设置处理
                    if (running) void api.setAskUser(`design:${designId}`, v).catch(() => {})
                  }}
                />
                <ConceptToggle
                  value={concept}
                  onChange={setConcept}
                  template={!!hasTemplate}
                  count={conceptCount}
                  onCount={setConceptCount}
                />
                {maskReady && conceptRound && (
                  <InpaintToggle value={inpaint} onChange={(v) => onInpaint?.(v)} supported={canInpaintHere} />
                )}
                <SourceSelect value={source} onChange={onSource} kind={kind === 'web' ? 'web' : 'game'} />
                {source.kind !== 'none' && (
                  <Select
                    // 只表示每张图生成几版；原画一次出几张在「原画」按钮的右键菜单里，两个数互不影响
                    aria-label={t('每张图生成几版')}
                    value={String(count)}
                    onChange={(e) => onCount(Number(e.target.value))}
                    options={[1, 2, 3, 4].map((n) => ({
                      value: String(n),
                      label: t('每张 {n} 版', { n }),
                    }))}
                    className="h-7 w-auto shrink-0 justify-start rounded-md border-transparent bg-transparent px-2 text-[0.75rem] text-muted hover:bg-sel"
                  />
                )}
              </>
            }
            running={running}
            onStop={onStop}
            sending={sending}
            canSend={
              running
                ? !!text.trim() || files.attachments.length > 0 || cites.length > 0
                : !!text.trim() ||
                  !!styleRef ||
                  annotations.length > 0 ||
                  files.attachments.length > 0 ||
                  cites.length > 0
            }
            label={t('告诉 AI 要做什么')}
            placeholder={
              running
                ? t('AI 正在处理：发送会补充给这一轮，收不下就在结束后自动接着处理')
                : annotations.length && annotations.every((a) => a.target.startsWith('img:'))
                  ? t('写修改意见，发送后按图上的标记重新生成图片')
                  : annotations.length
                    ? t('补充说明，或直接发送让 AI 按标注修改')
                    : concept && !hasTemplate
                      ? t('描述界面，AI 先出几张原画给你挑…')
                      : t('描述界面，或者说要改哪里…（也可以在效果图上标注）')
            }
          />
        )}
      </div>
    </div>
  )
}

/** 引用的控件：输入框上方可删除的引用条，发出后显示在消息上 */
function CitationChips({
  list,
  onRemove,
  className,
}: {
  list: WidgetCitation[]
  onRemove?: (id: string) => void
  className?: string
}) {
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {list.map((c) => (
        <span
          key={c.id}
          title={[
            c.path,
            c.target ? t('在子控件 {name} 里', { name: c.target }) : t('主界面'),
            c.image ? t('图片：{name}', { name: c.image }) : '',
            c.text ? t('文字：{text}', { text: c.text }) : '',
          ]
            .filter(Boolean)
            .join('\n')}
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-line bg-field px-1.5 py-0.5 text-[0.71875rem] text-muted"
        >
          <Quote className="h-3 w-3 shrink-0 text-accent" />
          <span className="truncate font-medium text-fg">{c.name}</span>
          <span className="shrink-0 text-subtle">
            {c.type}
            {c.width || c.height ? ` · ${c.width}×${c.height}` : ''}
          </span>
          {onRemove && (
            <button
              type="button"
              aria-label={t('从对话里去掉')}
              title={t('从对话里去掉')}
              onClick={() => onRemove(c.id)}
              className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded hover:bg-sel"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
    </span>
  )
}

function ChatMessage({
  msg,
  msgs,
  dir,
  last,
  disabled,
  onApplyAnalysis,
  onResend,
}: {
  msg: DesignMessage
  /** 整个对话：系统消息出错时，把前后几条一起交给 AI 排查 */
  msgs: DesignMessage[]
  /** 设计所属项目的目录：出错时一起交给 AI 排查 */
  dir?: string
  /** 最后一条回复：时间和操作一直显示 */
  last?: boolean
  /** 正在执行或发送：分析卡片上的「按建议修改」先不让点 */
  disabled?: boolean
  /** 分析卡片里点了「按建议修改」：把要求交给对话 */
  onApplyAnalysis?: (text: string) => void
  /** 把这条要求放回输入框重新编辑 */
  onResend?: (text: string) => void
}) {
  const author = useRunAuthor(msg.run as ChatRun | undefined)
  // 回答 AI 提问的消息：每个问题和答案分开显示
  if (msg.role === 'user' && msg.answers?.length) return <AnswerMessage size="sm" answers={msg.answers} at={msg.at} />
  if (msg.role === 'user')
    return (
      <UserMessage
        size="sm"
        text={msg.text}
        at={msg.at}
        attachments={msg.attachments}
        actions={
          onResend && (
            <button
              type="button"
              className={msgAction}
              title={t('放回输入框，改了再发')}
              aria-label={t('放回输入框，改了再发')}
              onClick={() => onResend(msg.text)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )
        }
        extra={
          <>
            {msg.delivery && <DeliveryLine delivery={msg.delivery} />}
            {msg.style && <StyleTag name={msg.style} className="mt-1.5 flex" />}
            {!!msg.refs?.length && <CitationChips list={msg.refs} className="mt-1.5" />}
            {!!msg.annotations?.length && (
              <span className="mt-1.5 flex flex-col gap-0.5 text-[0.71875rem] whitespace-normal text-muted">
                {msg.annotations.map((a, i) => (
                  <span key={a.id} className="flex items-center gap-1.5">
                    <span
                      className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full px-0.5 font-mono text-[0.625rem] font-semibold text-white"
                      style={{ background: markColor(a) }}
                    >
                      {i + 1}
                    </span>
                    <span className="truncate">
                      {markLabel(a)}
                      {a.widgets.length ? ` · ${a.widgets.slice(0, 3).join('、')}` : ''}
                      {a.note ? ` · ${a.note}` : ''}
                    </span>
                  </span>
                ))}
              </span>
            )}
          </>
        }
      />
    )
  if (msg.role === 'system')
    return (
      <SystemNote
        text={msg.text}
        error={msg.error}
        conversation={msg.error ? conversationAround(msgs, msgs.indexOf(msg)) : ''}
        cwd={dir}
      />
    )
  // 旧的消息没有分段：思考和工具调用放在回复前面
  const parts: ReplyPart[] = msg.parts ?? [
    { text: msg.text, thinking: msg.thinking, tools: (msg.tools ?? []) as ToolUse[] },
  ]
  return (
    <ChatReply
      msgs={partsToMessages(msg.id, parts, msg.at)}
      teamNames={NO_NAMES}
      author={author ?? { name: t('AI'), cli: '', icon: 'sparkles' }}
      last={last}
      // 和 Chat 对话一模一样：回复完成后思考、工具调用和中间的说明收进一个折叠，只留最后的回复和「需要的图片」
      fold
    >
      {!!msg.images?.length && (
        <span className="pl-[38px] text-[0.71875rem] text-subtle">
          {t('需要的图片：{n} 张', { n: msg.images.length })}
        </span>
      )}
      {!!msg.analysis && (
        <div className="pl-[38px]">
          <DesignAnalysisCard analysis={msg.analysis} disabled={disabled} onApply={onApplyAnalysis} />
        </div>
      )}
    </ChatReply>
  )
}

/** 回复的各段换成 Agent 输出的消息格式：和任务对话一样按顺序显示，只有第一段带头像和名字 */
const partsToMessages = (id: string, parts: ReplyPart[], at: string) =>
  parts.map((p, i) => asTaskMessage(`${id}:${i}`, p.text, at, p))

/** 正在输出的回复：思考、工具调用和说明按顺序边出边显示，和 Agent 的输出一样 */
function LiveReply({ job }: { job: DesignJob }) {
  const author = useRunAuthor(job.run as ChatRun | undefined) ?? { name: t('AI'), cli: '', icon: 'sparkles' }
  const parts = (job.parts ?? []).filter((p) => p.text || p.thinking?.trim() || p.tools.length)
  return (
    <div className="flex flex-col gap-1.5">
      {!parts.length ? (
        <PendingAuthor author={author}>
          <span className="thinking-shimmer text-[0.78125rem] text-subtle">{t('正在思考…')}</span>
        </PendingAuthor>
      ) : (
        // 不传 fold：这里 live 恒为真，FoldedRun 遇到 live 就整段平铺（流式输出本来就要边出边看）；
        // 收尾后的折叠由上面已完成的消息（ChatMessage）负责，两处职责不重叠
        <ChatReply msgs={partsToMessages('live', parts, '')} teamNames={NO_NAMES} author={author} live />
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
    <div className="mb-2 flex flex-col gap-2 rounded-xl border bg-card px-3 py-2.5 text-[0.78125rem] shadow-card">
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
              : job.phase === 'concepts'
                ? t('正在出原画 {i}/{n}', { i: job.concepts?.got ?? 0, n: job.concepts?.want ?? 0 })
                : job.mode === 'analyze'
                  ? t('正在分析设计')
                  : job.attempt > 1
                    ? t('检查还有问题，正在接着改')
                    : t('正在设计')}
        </span>
        {running && (
          <span className="ml-auto shrink-0 font-mono text-[0.6875rem] font-normal text-subtle tabular-nums">
            {sec}s
          </span>
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
            <li key={i.id} className="flex min-w-0 items-center gap-2 text-[0.75rem]">
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
                <span className="shrink-0 font-mono text-[0.6875rem] text-subtle tabular-nums">
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
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-px text-[0.71875rem] text-accent hover:bg-sel disabled:cursor-default disabled:opacity-50"
                >
                  {retrying === i.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  {t('重试')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!open && active[0]?.text && <p className="truncate text-[0.71875rem] text-subtle">{active[0].text}</p>}
    </div>
  )
}

/** 选的整体风格：排队的消息和发出去的消息上都显示，看得出风格跟着这条发了 */
function StyleTag({ name, title, className }: { name: string; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex w-fit max-w-full shrink-0 items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[0.71875rem] text-accent',
        className,
      )}
    >
      <Palette className="h-3 w-3 shrink-0" />
      <span className="truncate">{t('风格：{name}', { name })}</span>
    </span>
  )
}
