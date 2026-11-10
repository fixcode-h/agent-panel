import { useEffect, useMemo, useState } from 'react'
import { Activity, Download, FileUp, Loader2, Sparkles } from 'lucide-react'
import { t, uiLocale } from '@shared/i18n'
import type { LifeNode, LifeReport } from '@shared/lifecycle'
import { convStateText } from '@shared/task'
import { api, lifecycleDownloadUrl } from '@/lib/api'
import { openAiFix } from '@/lib/ai-fix'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { SIDEBAR_ROW_OFF, SIDEBAR_ROW_ON } from '@/components/ui/sidebar'
import { LifeDetail, nodeState, STATE_TONE, TONE_TEXT, worst } from './LifecycleDetail'

/**
 * 状态诊断（对话菜单「状态」，点「等待模型」那一行也会打开）：左边是这棵对话树（对话、子对话、子任务、工作流节点），
 * 右边是选中那个的 CLI 生命周期——现在在干什么、进程还在不在、不在的话为什么、哪里自相矛盾、最近的日志。
 * 结论都由服务端按 shared/lifecycle.ts 算好，这里只负责摆出来。
 * 右上角：「AI 分析」把选中节点的材料交给 AI 判断卡在哪；「复制诊断文件」把完整的诊断文件放进系统剪贴板，
 * 粘贴到对话里就是附件，复现了问题直接交给开发
 */
export function LifecycleDialog({
  taskId,
  onClose,
  onOpenChild,
}: {
  taskId: string
  onClose: () => void
  /** 最上面那句的「去回答」落在子对话上时：在右栏打开它（任务页给；没有就只关窗口） */
  onOpenChild?: (id: string) => void
}) {
  const [report, setReport] = useState<LifeReport | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState(taskId)
  const [busy, setBusy] = useState<'' | 'copy' | 'ai'>('')
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
    setBusy('copy')
    try {
      const r = await api.lifecycleFile(taskId)
      setSaved(r)
      if (r.copied) toast.success(t('诊断文件已放进剪贴板，直接粘贴到对话里就是附件'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  /** AI 分析选中的节点：服务端整理材料（结论、异常、计数、日志、诊断文件路径），在统一的 AI 分析窗口里聊 */
  const analyze = async () => {
    if (!node) return
    setBusy('ai')
    try {
      const [input, task] = await Promise.all([api.lifecycleAnalysis(taskId, node.id), api.task(node.taskId)])
      openAiFix({ ...input, home: { kind: 'task', task } })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const alarming = !!node && worst(node.verdict.anomalies) !== ''
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={null}
      bare
      size="xl"
      closeOnOutside
      className="h-[min(780px,calc(100dvh-3.75rem))]"
    >
      <ModalHeader
        icon={Activity}
        title={t('状态')}
        meta={
          report && (
            <span className="inline-flex items-center gap-1.5" title={t('开着时每 2 秒刷新')}>
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {t('实时 · {time}', { time: new Date(report.generatedAt).toLocaleTimeString(uiLocale()) })}
            </span>
          )
        }
        aside={
          <Button
            size="sm"
            // 标题栏只有 33px 高：按钮压到 24px，和右边的图标按钮一样高；有异常时换成红色提示先看这里
            variant={alarming ? 'danger-outline' : 'secondary'}
            className="mr-1 h-6 gap-1 rounded-md px-2 text-footnote"
            disabled={!node || busy === 'ai'}
            onClick={() => void analyze()}
            title={t('把选中这一项的结论、异常、计数和日志交给 AI，判断卡在哪、怎么处理')}
            data-life-ai
          >
            {busy === 'ai' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {t('AI 分析')}
          </Button>
        }
        actions={
          <>
            <ModalButton
              icon={Download}
              label={t('下载诊断文件')}
              disabled={!report}
              onClick={() => download(taskId)}
            />
            <ModalButton
              icon={busy === 'copy' ? Loader2 : FileUp}
              label={t('复制诊断文件')}
              disabled={!report || busy === 'copy'}
              className={busy === 'copy' ? '[&>svg]:animate-spin' : undefined}
              onClick={() => void copy()}
              data-life-copy
            />
          </>
        }
      />
      {saved && !saved.copied && (
        <div className="flex min-w-0 items-center gap-2 border-b border-(color:--modal-edge) px-4 py-1.5 text-xs text-muted">
          <span className="min-w-0 flex-1 truncate" title={saved.path}>
            {t('没能放进剪贴板，文件在：{path}', { path: saved.path })}
          </span>
          <Button size="sm" variant="ghost" className="h-6" onClick={() => void api.lifecycleReveal(taskId)}>
            {t('打开所在文件夹')}
          </Button>
        </div>
      )}
      {error && !report ? (
        <p className="p-5 text-body text-danger">{error}</p>
      ) : !report || !node ? (
        <div className="grid flex-1 place-items-center text-subtle">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row" data-lifecycle>
          <LifeTree report={report} picked={node.id} onPick={setPicked} />
          <LifeDetail
            node={node}
            parent={report.nodes.find((n) => n.id === node.parentId)}
            onPick={setPicked}
            // 去回答 / 去回复：回到那个对话。就是打开窗口的这个对话时关掉窗口即可（卡片、输入框都在下面）
            onGo={(n) => {
              if (n.taskId !== taskId) onOpenChild?.(n.taskId)
              onClose()
            }}
          />
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

/** 树上每行右边的一句状态：对话用对外状态，子任务用步骤状态 */
function rowState(n: LifeNode) {
  const f = n.facts
  if (f.kind === 'helper') {
    if (f.interrupted) return t('被打断')
    return f.status === 'running'
      ? f.working
        ? t('执行中')
        : t('排队中')
      : convStateText(f.status === 'failed' ? 'failed' : f.status === 'stopped' ? 'stopped' : 'done')
  }
  // 和标题栏、侧栏同一个短词（服务端按 taskWord 填的）；旧的诊断文件没有，退回状态名
  return f.word || (f.state ? convStateText(f.state) : '')
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
  const alive = report.nodes.filter((n) => n.facts.cliAlive).length
  return (
    <aside
      aria-label={t('对话树')}
      className="flex max-h-48 min-h-0 shrink-0 flex-col border-b bg-panel md:max-h-none md:w-72 md:border-b-0 md:border-r"
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-1.5 text-footnote text-subtle">
        <span>{t('对话树')}</span>
        <span className="tabular-nums">{t('{n} 个 · {alive} 个进程活着', { n: report.nodes.length, alive })}</span>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">
        {rows.map(({ n, depth }) => {
          const level = worst(n.verdict.anomalies)
          const bad = n.verdict.anomalies.filter((a) => a.level !== 'info').length
          return (
            <li key={n.id} className="relative">
              {/* 层级引导线：每一层一道竖线，和文件树一样一眼看出父子 */}
              {Array.from({ length: depth }, (_, i) => (
                <span key={i} aria-hidden className="absolute inset-y-0 w-px bg-line" style={{ left: 12 + i * 14 }} />
              ))}
              <button
                type="button"
                onClick={() => onPick(n.id)}
                aria-current={n.id === picked}
                className={cn(
                  // 选中 / 悬停和侧栏的对话行同一套（SIDEBAR_ROW_*，基础类要带 border）
                  'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-(--c-nav-radius) border pr-2 text-left text-body transition-colors',
                  n.id === picked ? SIDEBAR_ROW_ON : SIDEBAR_ROW_OFF,
                )}
                style={{ paddingLeft: 10 + depth * 14 }}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    n.facts.cliAlive ? 'bg-success' : 'ring-1 ring-line-strong ring-inset',
                  )}
                  title={n.facts.cliAlive ? t('CLI 进程活着') : t('没有 CLI 进程')}
                />
                <span className="min-w-0 flex-1 truncate">{n.title || n.id}</span>
                {level ? (
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-1.5 text-caption font-medium tabular-nums',
                      level === 'danger' ? 'bg-danger/12 text-danger' : 'bg-warning/12 text-warning',
                    )}
                    title={t('{n} 个异常', { n: bad })}
                  >
                    {bad}
                  </span>
                ) : (
                  // 状态文字按状态着色（和状态胶囊同一套颜色），一眼分出在跑、停了、做完
                  <span className={cn('shrink-0 text-footnote', TONE_TEXT[STATE_TONE[nodeState(n)]])}>
                    {rowState(n)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
