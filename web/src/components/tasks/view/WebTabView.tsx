/**
 * 对话右栏的网页页签（设计稿第 6 节，效果图 1–3）：地址栏 + 网页框；对方不许嵌入时换成被拒页，可以切阅读模式。
 * 页签本身画在 TaskFiles 的页签条上，这里只画页签下面的内容。
 */
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Copy,
  Ellipsis,
  ExternalLink,
  Globe,
  Lock,
  Puzzle,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import { t } from '@shared/i18n'
import { webViewContract as W, type WebProbeRes, type WebReaderRes } from '@shared/api-contract/web-view'
import { webUrlOf } from '@shared/web-view/embed'
import { call } from '@/lib/api/call'
import { copyText } from '@/lib/copy-text'
import {
  closeWebTab,
  extensionEmbedReady,
  navigateWebTab,
  prefersReader,
  setPrefersReader,
  setWebReader,
  stepWebTab,
  targetAddress,
  type WebTab,
  type WebTarget,
} from '@/lib/web-view/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { IconButton } from '@/components/ui/icon-button'
import { fieldClass } from '@/components/ui/input'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { WebFrame } from '@/components/ui/web-frame'
import { Markdown } from '../Markdown'
import { cn } from '@/lib/utils'

const NO_TEAM = new Set<string>()

/** 地址栏里输入的：像路径的当本机文件，其余当网址 */
function targetOf(text: string): WebTarget | null {
  const v = text.trim()
  if (!v) return null
  if (/^(\/|~\/|[a-zA-Z]:[\\/]|\.\.?\/)/.test(v)) return { kind: 'file', path: v }
  const u = webUrlOf(v)
  return u ? { kind: 'url', url: u.href } : null
}

/** 在浏览器新标签页打开：本机文件也走沙箱地址（CSP sandbox 对整页同样生效） */
async function openOutside(target: WebTarget, taskId: string, projectId?: string) {
  if (target.kind === 'url') {
    window.open(target.url, '_blank', 'noopener,noreferrer')
    return
  }
  const body =
    target.kind === 'file'
      ? { path: target.path, taskId: target.taskId ?? taskId, projectId }
      : {
          path: target.path,
          plugin: target.plugin,
          service: target.kind === 'plugin-service' ? target.service : undefined,
        }
  const r = await call(W.file, { body })
  window.open(r.url, '_blank', 'noopener,noreferrer')
}

export function WebTabView({ tab, taskId, projectId }: { tab: WebTab; taskId: string; projectId?: string }) {
  const [reload, setReload] = useState(0)
  const [draft, setDraft] = useState(targetAddress(tab.target))
  const address = targetAddress(tab.target)
  useEffect(() => setDraft(address), [address])
  const url = tab.target.kind === 'url' ? tab.target.url : ''
  const local = tab.target.kind === 'file' || tab.target.kind === 'plugin-file'
  const reader = !!url && (tab.reader ?? prefersReader(url))
  const go = () => {
    const next = targetOf(draft)
    if (next) navigateWebTab(taskId, tab.id, next)
    else setDraft(address)
  }
  const outside = () => void openOutside(tab.target, taskId, projectId).catch(() => {})

  return (
    <section aria-label={t('网页')} data-web-view className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b px-2">
        <IconButton
          icon={ArrowLeft}
          size="sm"
          label={t('后退')}
          disabled={!tab.back.length}
          onClick={() => stepWebTab(taskId, tab.id, 'back')}
        />
        <IconButton
          icon={ArrowRight}
          size="sm"
          label={t('前进')}
          disabled={!tab.forward.length}
          onClick={() => stepWebTab(taskId, tab.id, 'forward')}
        />
        <IconButton icon={RotateCw} size="sm" label={t('刷新')} onClick={() => setReload((n) => n + 1)} />
        <label
          className={cn(
            fieldClass,
            'mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2.5 text-footnote focus-within:border-focus',
          )}
        >
          {local ? (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <Lock className="h-3.5 w-3.5 shrink-0 text-subtle" />
          )}
          <input
            data-web-address
            aria-label={t('地址')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go()
              if (e.key === 'Escape') setDraft(address)
            }}
            onBlur={() => setDraft(address)}
            spellCheck={false}
            className="min-w-0 flex-1 truncate bg-transparent text-fg outline-none"
          />
          <span className="ml-auto shrink-0">
            {local ? (
              <Badge tone="success">{t('本机文件 · 沙箱')}</Badge>
            ) : tab.target.kind === 'plugin-service' ? (
              <Badge>{t('插件页面')}</Badge>
            ) : reader ? (
              <Badge tone="accent">
                <BookOpenText className="h-3 w-3" />
                {t('阅读模式')}
              </Badge>
            ) : null}
          </span>
        </label>
        {url && (
          <IconButton
            icon={BookOpenText}
            size="sm"
            label={reader ? t('退出阅读模式') : t('阅读模式')}
            aria-pressed={reader}
            className={cn(reader && 'bg-active text-fg')}
            onClick={() => setWebReader(taskId, tab.id, !reader)}
          />
        )}
        <IconButton icon={ExternalLink} size="sm" label={t('在新窗口打开')} onClick={outside} />
        <Menu>
          <MenuTrigger asChild>
            <IconButton icon={Ellipsis} size="sm" label={t('更多')} />
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => void copyText(address)}>
              <Copy className="h-3.5 w-3.5" />
              {t('复制地址')}
            </MenuItem>
            <MenuItem onSelect={() => closeWebTab(taskId, tab.id)}>
              <X className="h-3.5 w-3.5" />
              {t('关闭页签')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {reader ? (
        <ReaderView url={url} reload={reload} onOutside={outside} />
      ) : (
        <WebFrame
          target={tab.target}
          taskId={taskId}
          projectId={projectId}
          reloadKey={reload}
          title={tab.title}
          blocked={(probe) => (
            <BlockedPage probe={probe} onReader={() => setWebReader(taskId, tab.id, true)} onOutside={outside} />
          )}
        />
      )}
    </section>
  )
}

/** 一种「换个方式看」：图标、说明、按钮 */
function Way({
  icon: Icon,
  title,
  desc,
  action,
  primary,
  onClick,
}: {
  icon: typeof Globe
  title: string
  desc: string
  action: string
  primary?: boolean
  onClick?: () => void
}) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3', primary && 'bg-card')}>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sel text-muted">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-fg">{title}</p>
        <p className="text-footnote leading-relaxed text-muted">{desc}</p>
      </div>
      {onClick && (
        <Button size="sm" variant={primary ? 'primary' : 'secondary'} onClick={onClick}>
          {action}
        </Button>
      )}
    </div>
  )
}

/** 对方不许嵌入（效果图 2）：说清楚为什么，给三条路 */
function BlockedPage({
  probe,
  onReader,
  onOutside,
}: {
  probe: WebProbeRes
  onReader: () => void
  onOutside: () => void
}) {
  const host = webUrlOf(probe.finalUrl)?.hostname ?? probe.finalUrl
  const [always, setAlways] = useState(() => prefersReader(probe.finalUrl))
  const ext = extensionEmbedReady()
  return (
    <div data-web-blocked className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 py-10">
      <div className="flex w-full max-w-[520px] flex-col gap-4">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-warning/12 text-warning">
          <ShieldAlert className="h-5 w-5" />
        </span>
        <div>
          <p className="text-prose font-semibold text-fg">{t('{host} 不让别的网页嵌入它', { host })}</p>
          <p className="mt-1 text-body leading-relaxed text-muted">
            {t('{reason}。浏览器不会把它放进页签，换个方式看：', {
              reason: probe.reason ?? t('这个网站不允许被嵌入'),
            })}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Way
            icon={BookOpenText}
            title={t('阅读模式')}
            desc={t('面板在本机取回页面，只留正文、图片和代码块，去掉脚本后显示。不带你在浏览器里的登录状态。')}
            action={t('用阅读模式看')}
            primary
            onClick={onReader}
          />
          <Way
            icon={ExternalLink}
            title={t('在新窗口打开')}
            desc={t('交给浏览器的新标签页，登录状态、交互都在。')}
            action={t('打开')}
            onClick={onOutside}
          />
          <Way
            icon={Puzzle}
            title={t('允许嵌入（要装面板浏览器扩展）')}
            desc={
              ext
                ? t(
                    '点浏览器工具栏里的 Agent 面板扩展，在「允许嵌入」里加上 {host}，再刷新这个页签。扩展只对面板页签里的网页去掉这两个响应头。',
                    { host },
                  )
                : t(
                    '扩展只对面板页签里的网页去掉这两个响应头，你在别处打开的网页不受影响。装上新版扩展后，在扩展弹窗的「允许嵌入」里加上 {host}。',
                    { host },
                  )
            }
            action=""
          />
        </div>
        <Checkbox
          checked={always}
          onChange={(v) => {
            setAlways(v)
            setPrefersReader(probe.finalUrl, v)
          }}
          label={t('以后 {host} 直接用阅读模式打开', { host })}
        />
      </div>
    </div>
  )
}

/** 阅读模式（效果图 3）：服务端取回正文转成 Markdown，用对话同一套渲染 */
function ReaderView({ url, reload, onOutside }: { url: string; reload: number; onOutside: () => void }) {
  const [state, setState] = useState<{ doc?: WebReaderRes; error?: string; at?: Date }>({})
  useEffect(() => {
    let off = false
    setState({})
    call(W.reader, { body: { url } }).then(
      (doc) => !off && setState({ doc, at: new Date() }),
      (e: Error) => !off && setState({ error: e.message }),
    )
    return () => {
      off = true
    }
  }, [url, reload])
  if (state.error)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-body text-danger">
        <span className="max-w-md break-words">{state.error}</span>
        <Button size="sm" variant="secondary" onClick={onOutside}>
          {t('在新窗口打开')}
        </Button>
      </div>
    )
  if (!state.doc)
    return <p className="flex flex-1 items-center justify-center text-body text-subtle">{t('正在取回网页…')}</p>
  const { doc, at } = state
  return (
    <div data-web-reader className="min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto flex max-w-[640px] flex-col gap-3.5 px-8 pt-7 pb-10">
        <p className="flex items-center gap-1.5 text-footnote text-subtle">
          <Globe className="h-3.5 w-3.5" />
          {t('{site} · {time} 取回', {
            site: doc.site,
            time: at ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
          })}
        </p>
        <h1 className="text-title font-semibold tracking-tight text-fg">{doc.title}</h1>
        {doc.markdown ? (
          <Markdown text={doc.markdown} teamNames={NO_TEAM} />
        ) : (
          <p className="text-body text-subtle">{t('这个网页没有能取出来的正文')}</p>
        )}
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-footnote text-muted">
          {t('阅读模式不运行页面脚本，视频、交互演示不会显示；要完整看点地址栏右边的「在新窗口打开」。')}
        </div>
      </article>
    </div>
  )
}
