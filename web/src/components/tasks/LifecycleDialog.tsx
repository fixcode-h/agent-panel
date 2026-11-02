import { useEffect, useMemo, useState } from 'react'
import { Bot, Download, FileUp, ListTree, MessageSquare, RefreshCw, Workflow } from 'lucide-react'
import { t, uiLocale } from '@shared/i18n'
import type { Anomaly, LifeNode, LifeReport } from '@shared/lifecycle'
import { convStateText, stopReasonText } from '@shared/task'
import { api, lifecycleDownloadUrl } from '@/lib/api'
import { toast } from '@/lib/toast'
import { useNow } from '@/lib/useNow'
import { fmtDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'

/**
 * 状态诊断（对话菜单「状态」，点「等待模型」那一行也会打开）：左边是这棵对话树（对话、子对话、子任务、工作流节点），
 * 右边是选中那个的 CLI 生命周期——现在在干什么、进程还在不在、不在的话为什么、哪里自相矛盾、最近的日志。
 * 结论都由服务端按 shared/lifecycle.ts 算好，这里只负责摆出来。
 * 「复制诊断文件」把完整的诊断文件放进系统剪贴板，粘贴到对话里就是附件，复现了问题直接交给开发
 */
export function LifecycleDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [report, setReport] = useState<LifeReport | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState(taskId)
  const [copying, setCopying] = useState(false)
  const [saved, setSaved] = useState<{ path: string; copied: boolean } | null>(null)
  // 开着的时候每 2 秒刷新：状态（在等模型、进程退出）变得很快，停着的弹窗没有意义
  useEffect(() => {
    let alive = true
    const load = () =>
      api.taskLifecycle(taskId).then(
        (r) => {
          if (!alive) return
          setReport(r)
          setError('')
        },
        (e: Error) => alive && setError(e.message),
      )
    void load()
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [taskId])
  const node = report?.nodes.find((n) => n.id === picked) ?? report?.nodes[0]
  const copy = async () => {
    setCopying(true)
    try {
      const r = await api.lifecycleFile(taskId)
      setSaved(r)
      if (r.copied) toast.success(t('诊断文件已放进剪贴板，直接粘贴到对话里就是附件'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setCopying(false)
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('状态')}
      size="xl"
      closeOnOutside
      className="flex h-[min(760px,calc(100dvh-3.75rem))] flex-col"
      footer={
        <>
          {saved && !saved.copied && (
            <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted">
              <span className="min-w-0 truncate" title={saved.path}>
                {t('没能放进剪贴板，文件在：{path}', { path: saved.path })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void api.lifecycleReveal(taskId)}>
                {t('打开所在文件夹')}
              </Button>
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={!report} onClick={() => download(taskId)}>
              <Download className="h-3.5 w-3.5" />
              {t('下载诊断文件')}
            </Button>
            <Button size="sm" disabled={copying || !report} onClick={() => void copy()}>
              {copying ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
              {t('复制诊断文件')}
            </Button>
          </span>
        </>
      }
    >
      {error && !report ? (
        <p className="text-xs text-danger">{error}</p>
      ) : !report || !node ? (
        <p className="text-xs text-subtle">{t('读取中…')}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row" data-lifecycle>
          <LifeTree report={report} picked={node.id} onPick={setPicked} />
          <LifeDetail node={node} generatedAt={report.generatedAt} />
        </div>
      )}
    </Modal>
  )
}

/** 下载诊断文件：服务端按 content-disposition 给文件名 */
function download(taskId: string) {
  const a = document.createElement('a')
  a.href = lifecycleDownloadUrl(taskId)
  a.download = ''
  a.click()
}

const KIND_ICON = { conversation: MessageSquare, helper: Bot, node: Workflow } as const

/** 异常里最重的一级：树上的小标记和详情的配色都按它 */
function worst(list: Anomaly[]) {
  return list.some((a) => a.level === 'danger') ? 'danger' : list.some((a) => a.level === 'warning') ? 'warning' : ''
}

function LifeTree({ report, picked, onPick }: { report: LifeReport; picked: string; onPick: (id: string) => void }) {
  // 按 parentId 排成树：每个节点后面紧跟它的子节点，缩进按层级
  const rows = useMemo(() => {
    const kids = new Map<string, LifeNode[]>()
    for (const n of report.nodes) {
      const k = n.parentId ?? ''
      kids.set(k, [...(kids.get(k) ?? []), n])
    }
    const out: { n: LifeNode; depth: number }[] = []
    const walk = (id: string, depth: number) => {
      for (const n of kids.get(id) ?? []) {
        out.push({ n, depth })
        walk(n.id, depth + 1)
      }
    }
    walk('', 0)
    // 父节点不在这棵树里的（数据不完整）也列出来，不悄悄丢掉
    for (const n of report.nodes) if (!out.some((x) => x.n === n)) out.push({ n, depth: 0 })
    return out
  }, [report])
  return (
    <ol
      aria-label={t('对话树')}
      className="flex max-h-48 shrink-0 flex-col overflow-y-auto rounded-lg border p-1 md:max-h-none md:w-72"
    >
      {rows.map(({ n, depth }) => {
        const Icon = KIND_ICON[n.kind]
        const level = worst(n.verdict.anomalies)
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onPick(n.id)}
              aria-current={n.id === picked}
              className={cn(
                'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs hover:bg-sel',
                n.id === picked && 'bg-sel text-fg',
              )}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span
                className={cn('h-1.5 w-1.5 shrink-0 rounded-full', n.facts.cliAlive ? 'bg-success' : 'bg-line-strong')}
                title={n.facts.cliAlive ? t('CLI 进程活着') : t('没有 CLI 进程')}
              />
              <span className="min-w-0 flex-1 truncate">{n.title || n.id}</span>
              {level && (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 text-caption',
                    level === 'danger' ? 'bg-danger/15 text-danger' : 'bg-warning/15 text-warning',
                  )}
                >
                  {n.verdict.anomalies.filter((a) => a.level !== 'info').length}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

const KIND_TEXT = { conversation: t('对话'), helper: t('子任务'), node: t('工作流节点') } as const

/** 日志里值得一眼看到的事件：停止、退出、出错、重试、放弃、卡住 */
const KEY_EVENT = /停止|退出|出错|报错|重试|放弃|卡住|失败|拒收|没有输出|收口/

function LifeDetail({ node, generatedAt }: { node: LifeNode; generatedAt: string }) {
  const now = useNow(true)
  const [keyOnly, setKeyOnly] = useState(false)
  const f = node.facts
  const tr = f.trace
  const ago = (ms?: number) => (ms ? t('{d} 前', { d: fmtDuration(Math.max(0, now - ms)) }) : '—')
  const level = worst(node.verdict.anomalies)
  const log = keyOnly ? node.log.filter((l) => KEY_EVENT.test(l)) : node.log
  const rows: [string, string][] = [
    [
      t('状态'),
      [f.state ? convStateText(f.state) : f.status, f.stopReason ? stopReasonText(f.stopReason) : '']
        .filter(Boolean)
        .join(' · '),
    ],
    [
      t('执行位'),
      f.live ? (f.live.stop ? t('正在停下（{why}）', { why: stopReasonText(f.live.stopReason) }) : t('占着')) : t('空'),
    ],
    [
      t('CLI 进程'),
      f.cliAlive
        ? t('活着（{list}）', { list: node.processes.map((p) => p.pid).join('、') || '?' })
        : node.verdict.why || t('不在'),
    ],
    [
      t('模型请求'),
      tr
        ? [
            t('第 {n} 次', { n: tr.requests }),
            tr.requestAt ? t('发出于 {ago}', { ago: ago(tr.requestAt) }) : '',
            tr.requestAt && tr.firstOutputAt
              ? t('{s} 秒后开始输出', { s: Math.round((tr.firstOutputAt - tr.requestAt) / 1000) })
              : tr.requestAt
                ? t('还没有输出')
                : '',
            tr.lastOutputAt ? t('最后输出 {ago}', { ago: ago(tr.lastOutputAt) }) : '',
            tr.retry ? t('在重试第 {n} 次：{error}', { n: tr.retry.attempt, error: tr.retry.error ?? '' }) : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : t('这次面板运行期间没有记录'),
    ],
    [t('排着的消息'), String(f.held)],
    [t('子任务 / 后台命令'), `${f.helpers} / ${f.jobs}`],
  ]
  if (node.viewer)
    rows.push([
      t('页面'),
      node.viewer.viewing ? t('开着') : node.viewer.watched ? t('切走了（还在宽限期里）') : t('没人在看'),
    ])
  if (node.cli || node.model) rows.push([t('CLI / 模型'), [node.cli, node.model].filter(Boolean).join(' · ')])
  if (node.session) rows.push([t('会话'), node.session])
  if (node.reruns) rows.push([t('重跑次数'), String(node.reruns)])
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto" aria-label={t('生命周期')}>
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs text-subtle">
          {node.kind === 'conversation' ? (
            <MessageSquare className="h-3.5 w-3.5" />
          ) : (
            <ListTree className="h-3.5 w-3.5" />
          )}
          {KIND_TEXT[node.kind]}
          <span className="ml-auto tabular-nums" title={new Date(generatedAt).toLocaleString(uiLocale())}>
            {t('{time} 采集', { time: new Date(generatedAt).toLocaleTimeString(uiLocale()) })}
          </span>
        </span>
        <h3 className="text-body font-semibold text-fg">{node.title}</h3>
        <p
          data-life-headline
          className={cn(
            'text-body',
            level === 'danger' ? 'text-danger' : level === 'warning' ? 'text-warning' : 'text-fg',
          )}
        >
          {node.verdict.headline}
        </p>
      </div>
      {node.verdict.anomalies.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={t('异常')}>
          {node.verdict.anomalies.map((a) => (
            <li
              key={a.code}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-xs',
                a.level === 'danger'
                  ? 'bg-danger/10 text-danger'
                  : a.level === 'warning'
                    ? 'bg-warning/10 text-warning'
                    : 'bg-sel text-muted',
              )}
            >
              {a.text}
              <span className="ml-1.5 font-mono text-caption opacity-70">{a.code}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-subtle">{k}</dt>
            <dd className="min-w-0 break-words text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      {node.processes.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-left text-subtle">
            <tr>
              <th className="font-normal">PID</th>
              <th className="font-normal">{t('启动')}</th>
              <th className="font-normal">{t('内存')}</th>
              <th className="font-normal">{t('命令')}</th>
            </tr>
          </thead>
          <tbody>
            {node.processes.map((p) => (
              <tr key={p.pid}>
                <td className="font-mono tabular-nums">{p.pid}</td>
                <td className="tabular-nums">{ago(p.startedAt ?? undefined)}</td>
                <td className="tabular-nums">{p.rss ? `${Math.round(p.rss / 1048576)} MB` : '—'}</td>
                <td className="max-w-0 truncate font-mono" title={p.command}>
                  {p.command}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex min-h-0 flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs text-subtle">
          {t('日志（最近 {n} 条）', { n: node.log.length })}
          <label className="ml-auto flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={keyOnly} onChange={(e) => setKeyOnly(e.target.checked)} />
            {t('只看停止、退出、出错和重试')}
          </label>
        </span>
        {log.length ? (
          <pre className="max-h-80 overflow-auto rounded-md bg-sel/60 p-2 font-mono text-caption leading-5 whitespace-pre-wrap text-muted">
            {log.join('\n')}
          </pre>
        ) : (
          <p className="text-xs text-subtle">{t('没有日志')}</p>
        )}
      </div>
    </section>
  )
}
