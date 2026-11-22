import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, ExternalLink, FolderOpen, RotateCw, Settings2, Square, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { toolsContract as C } from '@shared/api-contract/tools'
import {
  AUTO_SOURCE,
  downloadCandidates,
  normalizeGithubInput,
  pickCandidates,
  type GhDownloadJob,
  type GhDownloadOverview,
} from '@shared/tools/gh-download'
import { call } from '@/lib/api/call'
import { copyText } from '@/lib/copy-text'
import { openPageStream } from '@/lib/live/page-stream'
import { useNav } from '@/lib/data'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DownloadRow } from '@/components/ui/download-row'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { IconButton } from '@/components/ui/icon-button'
import { Input, Select } from '@/components/ui/input'

/** 本机记住上次选的来源和目录：只是顺手，丢了按默认 */
const PREF_KEY = 'tools:gh-download'
function loadPref(): { source?: string; dir?: string } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as { source?: string; dir?: string }
  } catch {
    return {}
  }
}
function savePref(p: { source: string; dir: string }) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p))
  } catch {}
}

/** 按两次推送之间收到的字节算速度，平滑一下免得数字乱跳 */
function useSpeeds(jobs: GhDownloadJob[]) {
  const last = useRef(new Map<string, { at: number; received: number; speed?: number }>())
  return useMemo(() => {
    const now = Date.now()
    const out: Record<string, number | undefined> = {}
    for (const j of jobs) {
      const prev = last.current.get(j.id)
      let speed = prev?.speed
      if (prev && j.received >= prev.received && now - prev.at > 200) {
        const cur = ((j.received - prev.received) * 1000) / (now - prev.at)
        speed = speed === undefined ? cur : speed * 0.6 + cur * 0.4
      }
      if (!prev || now - prev.at > 200 || j.received < prev.received)
        last.current.set(j.id, { at: now, received: j.received, speed })
      out[j.id] = speed
    }
    return out
  }, [jobs])
}

/**
 * 小工具「GitHub 加速下载」：贴一个 GitHub 地址（文件、Release 附件、仓库、分支），挑一个来源下载到本机。
 * 来源就是「设置 · 网络与代理 · GitHub 下载来源」那张表（含预置的 gh-proxy），在那里加镜像、调顺序；
 * 「自动」按那张表的顺序试，卡住就换下一个。也能只拿加速后的地址，交给浏览器或别的下载器。
 */
export function GhDownloadTool() {
  const { openSettings } = useNav()
  const [data, setData] = useState<GhDownloadOverview | null>(null)
  const [error, setError] = useState('')
  const pref = useMemo(loadPref, [])
  const [input, setInput] = useState('')
  const [source, setSource] = useState(pref.source ?? AUTO_SOURCE)
  const [dir, setDir] = useState(pref.dir ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    call(C.ghDownloads)
      .then(setData)
      .catch((e) => setError((e as Error).message))
    // 下载进度由服务端推（server/tools/gh-download.ts），不轮询
    const stream = openPageStream()
    stream.on('gh-download', (e) => {
      try {
        const { jobs } = JSON.parse(e.data) as { jobs: GhDownloadJob[] }
        setData((d) => (d ? { ...d, jobs } : d))
      } catch {
        // 坏的一条推送不影响下一条
      }
    })
    return () => stream.close()
  }, [])

  const norm = input.trim() ? normalizeGithubInput(input) : null
  const candidates = useMemo(
    () => (norm && !('error' in norm) && data ? downloadCandidates(norm.url, data.sources) : []),
    // norm 每次渲染都是新对象，按算出的地址比
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [norm && 'url' in norm ? norm.url : '', data?.sources],
  )
  // 选过的来源这次不适用（例如仓库文件才有的 jsDelivr），回到自动
  const pick = source === AUTO_SOURCE || candidates.some((c) => c.key === source) ? source : AUTO_SOURCE
  const first = norm && 'url' in norm ? pickCandidates(candidates, pick)[0] : undefined
  const options = [
    { value: AUTO_SOURCE, label: t('自动（按设置里的顺序，卡住就换）') },
    ...candidates.map((c) => ({
      value: c.key,
      label: c.enabled ? c.label : t('{label}（设置里关着）', { label: c.label }),
    })),
  ]
  const speeds = useSpeeds(data?.jobs ?? [])

  const start = async (url = input, src = pick) => {
    setBusy(true)
    try {
      const job = await call(C.ghDownloadStart, { body: { url, source: src, dir: dir.trim() || undefined } })
      savePref({ source: src, dir: dir.trim() })
      setData((d) => (d ? { ...d, jobs: [job, ...d.jobs.filter((j) => j.id !== job.id)] } : d))
      if (url === input) setInput('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const act = (p: Promise<unknown>) => p.catch((e) => toast.error((e as Error).message))

  if (error) return <p className="px-4 py-6 text-body text-warning md:px-8">{t('读取失败：{error}', { error })}</p>

  return (
    <div className="flex max-w-[860px] flex-col gap-6 px-4 pt-6 pb-10 md:px-8 md:pt-7">
      <Card padding="lg" className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-body font-medium">{t('GitHub 地址')}</span>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && first && !busy && void start()}
            placeholder="https://github.com/owner/repo/releases/download/v1.0/app.zip"
            className="font-mono text-body"
            spellCheck={false}
            aria-label={t('GitHub 地址')}
          />
          <span className={norm && 'error' in norm ? 'text-caption text-warning' : 'text-caption text-subtle'}>
            {norm && 'error' in norm
              ? norm.error
              : norm
                ? t('将下载 {name}', { name: norm.name })
                : t('支持文件网页、Release 附件、源码包、raw 文件；贴仓库或分支的地址会下载源码 zip')}
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* 不用 label 包：里面有「管理来源」按钮，点标题文字会误触它 */}
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="flex items-center justify-between gap-2 text-body font-medium">
              {t('下载来源')}
              <Button
                variant="link"
                className="text-caption"
                onClick={() => openSettings('network')}
                title={t('在「设置 · 网络与代理 · GitHub 下载来源」里加镜像前缀、调顺序、开关来源')}
              >
                <Settings2 className="h-3.5 w-3.5" />
                {t('管理来源')}
              </Button>
            </span>
            <Select
              value={pick}
              onChange={(e) => setSource(e.target.value)}
              options={options}
              aria-label={t('下载来源')}
            />
          </div>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-body font-medium">{t('保存到')}</span>
            <Input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder={data?.defaultDir ?? ''}
              className="font-mono text-body"
              spellCheck={false}
              aria-label={t('保存到')}
            />
          </label>
        </div>
        {first && (
          <div className="flex min-w-0 items-center gap-2 rounded-lg bg-sel/40 px-3 py-2">
            <span className="shrink-0 text-caption text-muted">
              {pick === AUTO_SOURCE ? t('先试 {source}', { source: first.label }) : first.label}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-caption" title={first.url}>
              {first.url}
            </span>
            <IconButton
              icon={Copy}
              size="xs"
              label={t('复制这个地址')}
              onClick={() => void copyText(first.url, { done: t('已复制'), fail: t('复制失败') })}
            />
            <IconButton
              icon={ExternalLink}
              size="xs"
              label={t('交给浏览器下载')}
              onClick={() => window.open(first.url, '_blank', 'noopener')}
            />
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={() => void start()} disabled={!first || busy}>
            <Download className="h-4 w-4" />
            {t('下载')}
          </Button>
        </div>
      </Card>

      <section className="flex flex-col gap-2">
        <h3 className="text-heading font-semibold">{t('下载记录')}</h3>
        {!data ? (
          <p className="text-body text-subtle">{t('读取中…')}</p>
        ) : !data.jobs.length ? (
          <EmptyPanel size="md">{t('还没有下载过。记录只保留到面板重启，文件留在磁盘上。')}</EmptyPanel>
        ) : (
          <Card padding="xs" className="flex flex-col">
            {data.jobs.map((j) => (
              <DownloadRow
                key={j.id}
                name={j.name}
                detail={j.path}
                state={j.status}
                received={j.received}
                total={j.total}
                speed={speeds[j.id]}
                source={j.source}
                attempts={j.attempts}
                error={j.error}
                actions={
                  <>
                    {j.status === 'running' && (
                      <IconButton
                        icon={Square}
                        size="sm"
                        label={t('取消')}
                        onClick={() => void act(call(C.ghDownloadCancel, { params: { id: j.id }, body: {} }))}
                      />
                    )}
                    {j.status === 'done' && (
                      <IconButton
                        icon={FolderOpen}
                        size="sm"
                        label={t('在文件夹中显示')}
                        onClick={() => void act(call(C.ghDownloadReveal, { params: { id: j.id }, body: {} }))}
                      />
                    )}
                    {(j.status === 'failed' || j.status === 'cancelled') && (
                      <IconButton
                        icon={RotateCw}
                        size="sm"
                        label={t('重新下载')}
                        disabled={busy}
                        onClick={() => void start(j.input, j.pick)}
                      />
                    )}
                    {j.status !== 'running' && (
                      <IconButton
                        icon={X}
                        size="sm"
                        label={t('从记录里移除')}
                        onClick={() =>
                          void act(
                            call(C.ghDownloadRemove, { params: { id: j.id } }).then(() =>
                              setData((d) => (d ? { ...d, jobs: d.jobs.filter((x) => x.id !== j.id) } : d)),
                            ),
                          )
                        }
                      />
                    )}
                  </>
                }
              />
            ))}
          </Card>
        )}
      </section>
    </div>
  )
}
