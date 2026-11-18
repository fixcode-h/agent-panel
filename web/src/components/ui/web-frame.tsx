/**
 * 网页框：右栏网页页签、回复里的 HTML 卡片缩略图、插件声明的页面都用它（设计稿第 6 节）。
 *
 * - 本机文件先换成沙箱源上的地址（/api/web-view/file），iframe 再加一层 sandbox 属性、不给 allow-same-origin：
 *   页面跑在不透明源里，碰不到面板的 Cookie 和接口。
 * - 外部网址先让服务端预检（/api/web-view/probe）：对方不许嵌入时浏览器只给一块空白、JS 也看不出来，
 *   所以被拒时不开 iframe，换成 blocked 给的内容（右栏页签里是带阅读模式、新窗口的被拒页）。
 * - thumb：缩小的预览，不响应鼠标、不进 Tab 顺序，进了视口才加载，同时最多 MAX_THUMBS 个在加载。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Globe, LoaderCircle, TriangleAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import { webViewContract as W, type WebProbeRes } from '@shared/api-contract/web-view'
import { webUrlOf } from '@shared/web-view/embed'
import { withPanelScrollbar } from '@shared/web-view/scrollbar'
import { call } from '@/lib/api/call'
import { extensionAllows, targetAddress, type WebTarget } from '@/lib/web-view/tabs'
import { panelScrollbarLook } from '@/lib/web-view/scrollbar-look'
import { cn } from '@/lib/utils'
import { Button } from './button'

/** 本机页面：能跑脚本、弹窗、下载、提交表单，不给同源 */
const FILE_SANDBOX =
  'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals'
/** 外部网页保留它自己的源（登录、存储照常），但不许把面板整页跳走 */
const URL_SANDBOX = `${FILE_SANDBOX} allow-same-origin`
/** 缩略图按这个宽度排版再缩小：和常见桌面窗口差不多，网页不会按手机版排 */
const THUMB_W = 1280
/** 托管进程的页面开着时多久报一次「有人在看」：比最短的空闲停（1 分钟）短 */
const KEEPALIVE_MS = 45_000
/** 同时最多几个缩略图在加载：一屏好几张卡片时不一起拉起好几个网页 */
const MAX_THUMBS = 3

// 模块状态：运行时，正在加载的缩略图个数和排队的；页面刷新后从零开始
let thumbsBusy = 0
// 模块状态：运行时，排队等加载的缩略图（卸载时自己从队里拿掉）
const thumbQueue: (() => void)[] = []

/** 排队加载一个缩略图：返回的函数放掉名额（加载完、出错、卸载时调；调多次只算一次） */
function takeThumb(start: () => void) {
  let state: 'queued' | 'running' | 'done' = 'queued'
  const go = () => {
    thumbsBusy++
    state = 'running'
    start()
  }
  if (thumbsBusy < MAX_THUMBS) go()
  else thumbQueue.push(go)
  return () => {
    if (state === 'queued') {
      const i = thumbQueue.indexOf(go)
      if (i >= 0) thumbQueue.splice(i, 1)
    } else if (state === 'running') {
      thumbsBusy = Math.max(0, thumbsBusy - 1)
      thumbQueue.shift()?.()
    }
    state = 'done'
  }
}

/** 直接给一段 HTML（设置 → 组件里的示例、插件画好的预览）：用 srcdoc，同样关在 sandbox 里 */
export type WebFrameTarget = WebTarget | { kind: 'html'; html: string }

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; src: string; local: boolean; html?: string }
  | { state: 'blocked'; probe: WebProbeRes }
  | { state: 'error'; message: string }
  /** 本机文件不在常用目录里：等用户点「仍要打开」 */
  | { state: 'confirm'; message: string }

/** 本机文件换地址、外部网址预检；reloadKey 变了重新来一遍（令牌过期、文件改了） */
function useWebSource(
  target: WebFrameTarget,
  taskId: string | undefined,
  projectId: string | undefined,
  run: boolean,
  reloadKey: unknown,
) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const key = target.kind === 'html' ? `h:${target.html}` : `${target.kind}:${targetAddress(target)}`
  // 用户对这个文件点过「仍要打开」：换了目标就不算了
  const [forced, setForced] = useState('')
  const force = forced === key
  useEffect(() => {
    if (!run) return
    let off = false
    setLoaded({ state: 'loading' })
    const done = (v: Loaded) => !off && setLoaded(v)
    const fail = (e: Error) => done({ state: 'error', message: e.message })
    if (target.kind === 'html') done({ state: 'ready', src: '', local: true, html: target.html })
    else if (target.kind === 'file')
      call(W.file, {
        body: { path: target.path, taskId: target.taskId ?? taskId, projectId, ...(force && { force }) },
      }).then(
        (r) => done(r.confirm ? { state: 'confirm', message: r.confirm } : { state: 'ready', src: r.url, local: true }),
        fail,
      )
    else if (target.kind === 'plugin-file' || target.kind === 'plugin-service') {
      const service = target.kind === 'plugin-service' ? target.service : undefined
      // 托管进程的页面是它自己的源（另一个端口），保留同源它的登录、存储才能用；插件包里的文件和本机文件一样关进沙箱
      call(W.file, { body: { path: target.path, plugin: target.plugin, service } }).then(
        (r) => done({ state: 'ready', src: r.url, local: !service }),
        fail,
      )
    } else if (!webUrlOf(target.url)) done({ state: 'error', message: t('只能打开 http 或 https 的网址') })
    else
      call(W.probe, { body: { url: target.url } }).then(
        (p) =>
          // 浏览器扩展给这个站点开了「允许嵌入」时，扩展会去掉对方的响应头，照样开 iframe
          done(
            p.embeddable || extensionAllows(p.finalUrl)
              ? { state: 'ready', src: p.finalUrl, local: false }
              : { state: 'blocked', probe: p },
          ),
        fail,
      )
    return () => {
      off = true
    }
    // target 每次渲染可能是新对象，按 key 判断换没换
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, taskId, projectId, run, reloadKey, force])
  // 托管进程的页面开着时隔一会儿报一次「还有人在看」：页面自己的请求直接打到进程上，面板看不到，
  // 不报的话进程会按空闲停掉（server/plugins/services.ts 的 stopAfterIdleMin，按分钟算）
  const live = run && loaded.state === 'ready' && target.kind === 'plugin-service'
  useEffect(() => {
    if (!live || target.kind !== 'plugin-service') return
    const body = { path: '', plugin: target.plugin, service: target.service }
    // interval-ok: 托管进程保活，不是拉数据
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void call(W.file, { body }).catch(() => {})
    }, KEEPALIVE_MS)
    return () => clearInterval(timer)
    // 按 key 判断目标换没换
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [live, key])
  return { loaded, openAnyway: () => setForced(key) }
}

/** 和面板同源的地址（例如在页签里开了面板自己）不给 allow-same-origin：同源加脚本等于没有沙箱 */
function sandboxOf(src: string, local: boolean) {
  if (local) return FILE_SANDBOX
  try {
    return new URL(src, location.href).origin === location.origin ? FILE_SANDBOX : URL_SANDBOX
  } catch {
    return FILE_SANDBOX
  }
}

export function WebFrame({
  target,
  taskId,
  projectId,
  mode = 'full',
  reloadKey,
  title,
  blocked,
  className,
}: {
  target: WebFrameTarget
  /** 本机文件按哪个对话、哪个项目的目录找 */
  taskId?: string
  projectId?: string
  mode?: 'full' | 'thumb'
  /** 变了就重新取地址、重新加载（刷新按钮） */
  reloadKey?: unknown
  /** iframe 的读屏名 */
  title?: string
  /** 对方不许嵌入时显示什么；不给时显示一句原因 */
  blocked?: (probe: WebProbeRes) => ReactNode
  className?: string
}) {
  const thumb = mode === 'thumb'
  const box = useRef<HTMLDivElement>(null)
  // 缩略图：进了视口、排到了才加载；整页模式直接加载
  const [run, setRun] = useState(!thumb)
  const [scale, setScale] = useState(0.25)
  const release = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!thumb || !box.current) return
    const el = box.current
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || release.current) return
      release.current = takeThumb(() => setRun(true))
      io.disconnect()
    })
    io.observe(el)
    const ro = new ResizeObserver(() => setScale(el.clientWidth / THUMB_W || 0.25))
    ro.observe(el)
    return () => {
      io.disconnect()
      ro.disconnect()
      release.current?.()
    }
  }, [thumb])
  const { loaded, openAnyway } = useWebSource(target, taskId, projectId, run, reloadKey)
  // 缩略图加载完（或者根本开不了）就把名额让给下一个
  const settled = loaded.state === 'blocked' || loaded.state === 'error' || loaded.state === 'confirm'
  useEffect(() => {
    if (settled) release.current?.()
  }, [settled])

  const center =
    'flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-footnote text-subtle'
  let body: ReactNode
  if (loaded.state === 'ready')
    body = (
      <iframe
        key={`${loaded.src}\n${String(reloadKey ?? '')}`}
        src={loaded.html === undefined ? loaded.src : undefined}
        // 直接给的 HTML 也用全站那套滚动条（iframe 是另一个文档，管不到）
        srcDoc={loaded.html === undefined ? undefined : withPanelScrollbar(loaded.html, panelScrollbarLook())}
        title={title ?? t('网页')}
        sandbox={sandboxOf(loaded.src, loaded.local)}
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={() => release.current?.()}
        tabIndex={thumb ? -1 : undefined}
        aria-hidden={thumb || undefined}
        className={cn('border-0 bg-white', thumb ? 'pointer-events-none origin-top-left' : 'h-full w-full')}
        style={
          thumb ? { width: THUMB_W, height: Math.round(THUMB_W * 0.625), transform: `scale(${scale})` } : undefined
        }
      />
    )
  else if (loaded.state === 'blocked')
    body =
      !thumb && blocked ? (
        blocked(loaded.probe)
      ) : (
        <div className={center}>
          <Globe className="h-5 w-5" />
          {!thumb && <span>{loaded.probe.reason ?? t('这个网站不允许被嵌入')}</span>}
        </div>
      )
  else if (loaded.state === 'confirm')
    body = (
      <div className={center}>
        <TriangleAlert className="h-5 w-5 text-warning" />
        {!thumb && (
          <>
            <span className="max-w-md break-words">{loaded.message}</span>
            <span className="max-w-md">{t('页面仍在沙箱里打开、碰不到面板，但能读到同一目录里的其他文件。')}</span>
            <Button size="sm" variant="secondary" onClick={openAnyway}>
              {t('仍要打开')}
            </Button>
          </>
        )}
      </div>
    )
  else if (loaded.state === 'error')
    body = (
      <div className={cn(center, 'text-danger')}>
        <TriangleAlert className="h-5 w-5" />
        {!thumb && <span className="max-w-md break-words">{loaded.message}</span>}
      </div>
    )
  else
    body = (
      <div className={center}>
        <LoaderCircle className={cn('h-5 w-5', run && 'animate-spin')} />
      </div>
    )
  return (
    <div
      ref={box}
      data-web-frame={mode}
      data-web-state={loaded.state}
      className={cn('relative min-h-0 overflow-hidden', thumb ? 'bg-sel' : 'flex flex-1 flex-col', className)}
    >
      {body}
    </div>
  )
}
