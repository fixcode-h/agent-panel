import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import {
  BUILD_OUTPUTS,
  CHAT_WORKSPACE_TOP_N,
  CHAT_WORKSPACE_WARN_BYTES,
  type CleanupReport,
  type WorktreeCleanup,
} from '@shared/data'
import { formatBytes } from '@shared/memory'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Card } from '@/components/ui/card'
import { t } from '@shared/i18n'

type ChatRow = CleanupReport['chats']['top'][number]

/**
 * 设置 →「数据」→ 清理：对话工作目录、失效的独立分支、构建产物。
 * 三块都是「占地方但能重建」的东西，只在这里列出来由用户点清理，不动任务记录和项目文件。
 *
 * 独立分支单独拉（进去还要点一次「检查」）：它要跑 git 判定、递归四 GB / 十几万个文件，
 * 设置页每次打开都扫一遍太慢，而这张表大部分时候没人看
 */
export function CleanupSection({ onCleared }: { onCleared?: () => void }) {
  const [report, setReport] = useState<CleanupReport>()
  const [worktrees, setWorktrees] = useState<WorktreeCleanup>()
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  /** 正在清的项（`chat:<id>` / `worktrees` / `builds`）：按钮转圈，其余项也先禁用 */
  const [busy, setBusy] = useState('')
  const [clearingChat, setClearingChat] = useState<ChatRow | null>(null)
  const [confirmBuilds, setConfirmBuilds] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      setReport(await api.cleanupReport())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  /** 独立分支的占用和可清清单：只在点「检查」时算（重） */
  const checkWorktrees = async () => {
    setChecking(true)
    try {
      setWorktrees(await api.worktreeCleanup())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  /** 清理后刷新这张清单，并让上面的占用表跟着变（它和这份清单是两个接口） */
  const done = async (message: string) => {
    toast.success(message)
    await load()
    onCleared?.()
  }

  const clearChat = async (row: ChatRow) => {
    setBusy(`chat:${row.id}`)
    try {
      const r = await api.clearChatWorkspace(row.id)
      // 用和列表同一个名字：有记录但没标题的对话不能叫「已删除的对话」
      await done(t('已清理「{title}」的工作目录，释放 {size}', { title: chatName(row), size: formatBytes(r.bytes) }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
      setClearingChat(null)
    }
  }

  const clearWorktrees = async () => {
    setBusy('worktrees')
    try {
      const r = await api.clearStaleWorktrees()
      if (r.failed)
        toast.warning(
          t('清理了 {n} 个，释放 {size}；还有 {failed} 个删不掉，下次启动会再试', {
            n: r.removed,
            size: formatBytes(r.bytes),
            failed: r.failed,
          }),
        )
      else if (r.removed)
        toast.success(t('清理了 {n} 个失效目录，释放 {size}', { n: r.removed, size: formatBytes(r.bytes) }))
      else toast.success(t('没有可清理的失效目录'))
      // 清完把这一块重算一遍；对话目录和构建产物没变，不用重拉
      if (worktrees) await checkWorktrees()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const clearBuilds = async () => {
    setBusy('builds')
    try {
      const r = await api.clearBuildOutputs()
      await done(t('已清理构建产物，释放 {size}', { size: formatBytes(r.bytes) }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
      setConfirmBuilds(false)
    }
  }

  const chats = report?.chats
  const chatName = (row: ChatRow) => row.title || (row.orphan ? t('已删除的对话') : t('未命名对话'))

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col">
        <div className="flex items-center pb-2">
          <h3 className="text-[0.8125rem] font-semibold">{t('对话工作目录')}</h3>
          <span className="ml-2 text-xs text-subtle">
            {chats ? t('共 {size}', { size: formatBytes(chats.bytes) }) : '…'}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={t('刷新清理清单')}
            onClick={load}
            disabled={loading || !!busy}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
        <p className="pb-2 text-[0.8125rem] leading-relaxed text-subtle">
          {t(
            '每个对话有一个自己的工作目录，Agent 在里面写文件、下载网页。清理只删目录内容，对话记录和消息都还在，下次执行时面板会重新建这个目录。回收站里的对话和正在执行的不能清。',
          )}
        </p>
        <Card className="overflow-hidden">
          {chats?.top.length ? (
            chats.top.map((row) => (
              <div key={row.id} className="flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-[0.84375rem]" title={chatName(row)}>
                  {chatName(row)}
                </span>
                {row.orphan && <span className="shrink-0 text-xs text-subtle">{t('对话记录已删除')}</span>}
                {row.trashed && <span className="shrink-0 text-xs text-subtle">{t('回收站')}</span>}
                {row.running && <span className="shrink-0 text-xs text-muted">{t('正在执行')}</span>}
                {!row.trashed && !row.running && row.bytes >= CHAT_WORKSPACE_WARN_BYTES && (
                  <span className="shrink-0 text-xs text-warning">{t('占用较大')}</span>
                )}
                <span className="shrink-0 text-right font-mono text-[0.78125rem] text-muted">
                  {formatBytes(row.bytes)}
                  <span className="block text-[0.6875rem] text-subtle">{t('{n} 个文件', { n: row.files })}</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  disabled={!!busy || row.trashed || row.running}
                  onClick={() => setClearingChat(row)}
                >
                  {busy === `chat:${row.id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  {t('清理')}
                </Button>
              </div>
            ))
          ) : (
            <p className="px-3.5 py-3 text-[0.8125rem] text-subtle">
              {report ? t('没有存了文件的工作目录') : t('正在统计…')}
            </p>
          )}
        </Card>
        {!!chats?.more && (
          <p className="pt-2 text-xs leading-relaxed text-subtle">
            {t('另外 {n} 个工作目录较小，没有列出（只列占用最大的 {top} 个），都算在上面的合计里。', {
              n: chats.more,
              top: CHAT_WORKSPACE_TOP_N,
            })}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[0.8125rem] font-semibold">{t('独立分支')}</h3>
          <span className="text-xs text-subtle">
            {worktrees
              ? t('共 {total} · 可清 {stale}', {
                  total: formatBytes(worktrees.bytes),
                  stale: formatBytes(worktrees.staleBytes),
                })
              : t('还没检查（要跑 git 判定，比较慢）')}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={checkWorktrees} disabled={checking || !!busy}>
            <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
            {t('检查占用')}
          </Button>
        </div>
        <p className="text-[0.8125rem] leading-relaxed text-subtle">
          {t(
            '子对话的独立工作目录。改动已经合回原分支、任务也收口的可以清；正在执行、回收站里的、还有没合回的提交或有没提交的改动的都不会动。没有目标的链接也一起清掉。',
          )}
        </p>
        {worktrees?.stale.length ? (
          <Card className="overflow-hidden">
            {worktrees.stale.slice(0, 8).map((item) => (
              <div key={item.dir} className="flex items-center gap-3 border-b px-3.5 py-2 last:border-b-0">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]" title={item.dir}>
                  {item.dir}
                </span>
                <span className="shrink-0 text-xs text-subtle">{item.reason}</span>
                <span className="w-16 shrink-0 text-right font-mono text-[0.75rem] text-muted">
                  {formatBytes(item.bytes)}
                </span>
              </div>
            ))}
            {worktrees.stale.length > 8 && (
              <p className="px-3.5 py-2 text-xs text-subtle">
                {t('还有 {n} 个没列出', { n: worktrees.stale.length - 8 })}
              </p>
            )}
          </Card>
        ) : (
          <p className="text-[0.8125rem] text-subtle">
            {!worktrees ? t('点「检查占用」看看有多少能清') : t('没有失效的独立分支目录')}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={clearWorktrees}>
            {busy === 'worktrees' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {t('清理失效的目录')}
          </Button>
          {!!worktrees?.stale.length && (
            <span className="text-xs text-subtle">
              {t('可释放 {size}', { size: formatBytes(worktrees.staleBytes) })}
            </span>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-semibold">{t('构建产物')}</h3>
        <p className="text-[0.8125rem] leading-relaxed text-subtle">
          {t(
            '面板前端、演示版、打出来的安装包和界面检查截图，都由 npm run 重新生成，占地方时可以清掉。清理后刷新页面会打不开，重新构建一次就恢复。',
          )}
        </p>
        <Card className="overflow-hidden">
          {BUILD_OUTPUTS.map((b) => {
            const u = report?.builds.find((x) => x.id === b.id)
            return (
              <div key={b.id} className="flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[0.84375rem]">
                    {b.label} <span className="font-mono text-[0.71875rem] text-subtle">{b.id}</span>
                  </span>
                  <span className="text-xs leading-relaxed text-subtle">{b.hint}</span>
                </span>
                <span className="shrink-0 font-mono text-[0.78125rem] text-muted">
                  {u ? (u.present ? formatBytes(u.bytes) : t('不在')) : '…'}
                </span>
              </div>
            )
          })}
        </Card>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!!busy || !report?.builds.some((b) => b.present)}
            onClick={() => setConfirmBuilds(true)}
          >
            {busy === 'builds' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t('清理构建产物')}
          </Button>
          {!!report && (
            <span className="text-xs text-subtle">
              {t('可释放 {size}', { size: formatBytes(report.builds.reduce((n, b) => n + b.bytes, 0)) })}
            </span>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={!!clearingChat}
        onOpenChange={(o) => !o && setClearingChat(null)}
        title={clearingChat ? t('清理「{title}」的工作目录？', { title: chatName(clearingChat) }) : ''}
        description={
          clearingChat
            ? t(
                '只删这个目录里的文件（{size}），对话记录和消息都还在，下次执行时面板会重新建一个空目录。删掉的文件不能恢复。',
                {
                  size: formatBytes(clearingChat.bytes),
                },
              )
            : ''
        }
        onConfirm={() => clearingChat && clearChat(clearingChat)}
      />
      <ConfirmDialog
        open={confirmBuilds}
        onOpenChange={setConfirmBuilds}
        title={t('清理构建产物？')}
        description={t(
          '会删掉前端构建产物、演示版、历史安装包和界面检查截图。需要时重新 npm run build / package 生成，当前页面刷新后会打不开。',
        )}
        onConfirm={clearBuilds}
      />
    </div>
  )
}
