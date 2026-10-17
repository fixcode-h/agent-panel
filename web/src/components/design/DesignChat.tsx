import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, FolderOpen, Globe, Loader2, Sparkles, Square } from 'lucide-react'
import { toast } from 'sonner'
import type { BrowserTab, DesignJob, DesignMessage, ImageSource } from '@shared/design'
import { agentRun, defaultCli } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useCliDef } from '@/lib/cli-models'
import { cliColor, effortLabel } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/input'
import { Markdown } from '@/components/tasks/Markdown'
import * as D from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { t } from '@shared/i18n'

const NO_NAMES = new Set<string>()

/** 浏览器扩展报上来的 Gemini / ChatGPT 标签页；页面开着时每几秒问一次 */
export function useBrowserTabs() {
  const [st, setSt] = useState<{ connected: boolean; tabs: BrowserTab[]; extensionDir: string }>({
    connected: false,
    tabs: [],
    extensionDir: '',
  })
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .browserStatus()
        .then((s) => alive && setSt(s))
        .catch(() => {})
    load()
    const timer = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
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
  const browser = useBrowserTabs()
  const [help, setHelp] = useState(false)
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
    ...(!browser.tabs.length
      ? [
          {
            value: 'help',
            label: browser.connected ? t('打开 Gemini 或 ChatGPT…') : t('连接浏览器…'),
            group: t('浏览器标签页'),
          },
        ]
      : []),
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
        className="h-7 max-w-[200px] rounded-md border-transparent bg-transparent px-2 text-[12px] text-muted hover:bg-sel"
      />
      <BrowserHelp open={help} onOpenChange={setHelp} connected={browser.connected} dir={browser.extensionDir} />
    </>
  )
}

/** 怎么连上浏览器：装一次扩展，打开并登录 Gemini 或 ChatGPT */
function BrowserHelp({
  open,
  onOpenChange,
  connected,
  dir,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  connected: boolean
  dir: string
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 animate-[fade-in_120ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-6 shadow-pop">
          <D.Title className="flex items-center gap-2 font-serif text-[18px] font-semibold">
            <Globe className="h-5 w-5 text-accent" />
            {t('用浏览器里的 Gemini / ChatGPT 生成图片')}
          </D.Title>
          <D.Description className="mt-2 text-[13px] leading-relaxed text-muted">
            {t(
              '不需要图片模型的 API：面板通过一个小扩展，用你在浏览器里已经登录的 Gemini 或 ChatGPT（会员版才能生成图片）。扩展只读取这两个网站的标签页。',
            )}
          </D.Description>
          <ol className="mt-4 flex list-decimal flex-col gap-2.5 pl-5 text-[13px] leading-relaxed">
            <li className={cn(connected && 'text-subtle line-through')}>
              {t(
                '在 Chrome 或 Edge 的地址栏打开 chrome://extensions（Edge 是 edge://extensions），打开右上角的「开发者模式」。',
              )}
            </li>
            <li className={cn(connected && 'text-subtle line-through')}>
              {t('点「加载已解压的扩展程序」，选择 Agent 面板程序目录里的 extension 文件夹。')}
              {dir && !import.meta.env.VITE_DEMO && (
                <button
                  onClick={() => api.revealExtension().catch((e) => toast.error((e as Error).message))}
                  className="mt-1 flex cursor-pointer items-center gap-1.5 text-accent hover:underline"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('打开这个文件夹')}
                </button>
              )}
            </li>
            <li>{t('打开 gemini.google.com 或 chatgpt.com 并登录，停在聊天页面。之后就能在这里选那个标签页。')}</li>
          </ol>
          <p className="mt-4 flex items-center gap-2 text-[12.5px]">
            <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-success' : 'bg-line-strong')} />
            {connected ? t('扩展已连上') : t('扩展还没连上')}
          </p>
          <div className="mt-5 flex justify-end">
            <D.Close asChild>
              <Button variant="ghost">{t('知道了')}</Button>
            </D.Close>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 对话用的 CLI 和模型：默认 CLI 的高档 */
function useChatModel() {
  const { settings } = useData()
  const cli = settings ? defaultCli(settings) : 'claude'
  const def = useCliDef(cli)
  if (!settings || !def) return undefined
  const run = agentRun({ cli, model: '@high' }, settings)
  return { def, model: run.model, effort: run.effort }
}

/** 对话用的 CLI 和模型，放在对话栏标题右边（输入框下面放不下） */
export function ChatModelLabel() {
  const m = useChatModel()
  if (!m) return null
  return (
    <span
      title={t('对话用默认 CLI 的高档模型，在设置里修改')}
      className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-normal text-subtle"
    >
      <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: cliColor(m.def.id) }} />
      <span className="truncate">
        {m.def.name} · {m.model || t('默认模型')}
        {m.effort ? ` · ${m.effort}` : ''}
      </span>
    </span>
  )
}

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
}: {
  messages: DesignMessage[]
  job: DesignJob | null | undefined
  disabled?: boolean
  source: ImageSource
  onSource: (s: ImageSource) => void
  count: number
  onCount: (n: number) => void
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const running = job?.status === 'running'

  // 新消息、进度变化时滚到底
  useLayoutEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, job?.text, job?.phase, running])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(200, el.scrollHeight)}px`
  }, [text])

  const send = async () => {
    const v = text.trim()
    if (!v || running || sending) return
    setSending(true)
    try {
      if (await onSend(v)) setText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
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
        <div className="flex flex-col gap-4">
          {messages.map((msg) => (
            <ChatMessage key={msg.id} msg={msg} />
          ))}
          {running && job && <JobProgress job={job} />}
        </div>
      </div>
      <div className="shrink-0 px-3 pb-3">
        <div className="rounded-2xl border border-line-strong bg-field shadow-card focus-within:border-accent/60">
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={disabled}
            rows={2}
            placeholder={running ? t('AI 正在处理，完成后可以继续说') : t('描述界面，或者说要改哪里…')}
            aria-label={t('告诉 AI 要做什么')}
            className="block max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed outline-none placeholder:text-subtle"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <span className="flex-1" />
            <SourceSelect value={source} onChange={onSource} />
            {source.kind !== 'none' && (
              <Select
                aria-label={t('每张图生成几版')}
                value={String(count)}
                onChange={(e) => onCount(Number(e.target.value))}
                options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: t('每张 {n} 版', { n }) }))}
                className="h-7 w-auto shrink-0 rounded-md border-transparent bg-transparent px-2 text-[12px] text-muted hover:bg-sel"
              />
            )}
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
                disabled={!text.trim() || sending || disabled}
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
  const def = useCliDef(msg.run?.cli)
  if (msg.role === 'user')
    return (
      <div className="ml-8 self-end rounded-2xl rounded-br-md bg-sel px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
        {msg.text}
      </div>
    )
  if (msg.role === 'system')
    return (
      <div className="flex gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] leading-relaxed text-danger">
        <span className="flex h-[1.625em] shrink-0 items-center">
          <AlertCircle className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{msg.text}</span>
      </div>
    )
  return (
    <div className="flex flex-col gap-1">
      {msg.run && def && (
        <span className="flex items-center gap-1.5 text-[11px] text-subtle">
          <span className="h-2 w-2 rounded-[3px]" style={{ background: cliColor(def.id) }} />
          {def.name} · {msg.run.model}
          {msg.run.effort ? ` · ${msg.run.effort} · ${effortLabel(def, msg.run.effort)}` : ''}
        </span>
      )}
      <Markdown text={msg.text} teamNames={NO_NAMES} className="text-[13px]" />
      {!!msg.images?.length && (
        <span className="text-[11.5px] text-subtle">{t('需要的图片：{n} 张', { n: msg.images.length })}</span>
      )}
    </div>
  )
}

function JobProgress({ job }: { job: DesignJob }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const sec = Math.round((Date.now() - job.startedAt) / 1000)
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border bg-panel px-3 py-2.5 text-[12.5px]">
      <span className="flex items-center gap-2 font-medium text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        {job.phase === 'images' ? t('正在生成图片') : job.attempt > 1 ? t('格式不对，正在修正') : t('正在设计')}
        <span className="ml-auto font-mono text-[11px] font-normal text-subtle tabular-nums">{sec}s</span>
      </span>
      {job.phase === 'design' && job.thinking && !job.text && (
        <p className="line-clamp-3 text-[12px] leading-relaxed text-subtle italic">{job.thinking.slice(-300)}</p>
      )}
      {job.text && (
        <p className="line-clamp-4 text-[12px] leading-relaxed whitespace-pre-wrap text-muted">{job.text}</p>
      )}
      {job.phase === 'design' && job.outChars > 0 && !job.text && (
        <p className="text-[11.5px] text-subtle">{t('已输出 {n} 个字符', { n: job.outChars })}</p>
      )}
    </div>
  )
}
