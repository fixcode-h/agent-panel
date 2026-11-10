import { useState } from 'react'
import { GitBranch, Loader2, TriangleAlert } from 'lucide-react'
import type { Task } from '@shared/schema'
import { sharesWorkdir } from '@shared/task'
import { sharedDirMuteKey, type SharedDirInfo } from '@shared/shared-dir'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useTasks } from '@/lib/data'
import { usePolling } from '@/lib/polling'
import { toast } from '@/lib/toast'
import { barRow } from './TaskViewParts'
import { refreshWorktrees } from './Worktrees'

/** 别的对话在跑时多久问一次：对方可能跑了一会儿才开始改文件，列表里的状态不会跟着变 */
const POLL_MS = 4000

// 浏览器存储读写都可能抛（隐私模式、被禁用）：读不到按没点过算，照常提醒
const muted = (projectId: string) => {
  try {
    return localStorage.getItem(sharedDirMuteKey(projectId)) === '1'
  } catch {
    return false
  }
}

/**
 * 输入框上方的一行提醒：同一个目录里有别的对话正在改文件（规则见 shared/shared-dir.ts）。
 * 只提醒不拦发送：用户可以照常发，也可以让这个对话开独立分支分开做，或者点「不再提示」（按项目记在浏览器里）。
 * 放在 FloatAbove 里，不占位、不把输入框往下顶
 */
export function SharedDirNotice({ task, onChange }: { task: Task; onChange: (t: Task) => void }) {
  const { tasks } = useTasks()
  const [info, setInfo] = useState<SharedDirInfo | null>(null)
  const [off, setOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const watch = !!task.projectId && !task.imported && sharesWorkdir(task) && !off && !muted(task.projectId)
  // 同项目里别的正在跑的对话：一个都没有就不用问服务端。是不是同一个目录、改没改过文件由服务端判断
  const running = watch
    ? tasks
        .filter((x) => x.id !== task.id && x.projectId === task.projectId && x.working)
        .map((x) => x.id)
        .sort()
        .join(',')
    : ''
  usePolling(
    () =>
      api.sharedDir(task.id).then(
        (r) => setInfo(r),
        // 查不到就当没有：这只是一行提醒，不值得为它报错
        () => setInfo(null),
      ),
    running ? POLL_MS : null,
    `${task.id}:${running}`,
  )
  if (!running || !info?.peers.length) return null
  const first = info.peers[0].title || t('未命名对话')
  const text =
    info.peers.length > 1
      ? t('「{title}」等 {n} 个对话正在这个目录里改文件，两边的改动可能互相影响', {
          title: first,
          n: info.peers.length,
        })
      : t('「{title}」正在这个目录里改文件，两边的改动可能互相影响', { title: first })

  const isolate = async () => {
    setBusy(true)
    try {
      const next = await api.isolateTask(task.id)
      onChange(next)
      setInfo(null)
      void refreshWorktrees(task.id)
      toast.success(
        t('已开独立分支 {name}，下一句起在里面做；这个对话之前没提交的改动留在原目录', {
          name: next.worktree?.branch ?? '',
        }),
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const mute = () => {
    try {
      localStorage.setItem(sharedDirMuteKey(task.projectId), '1')
    } catch {
      // 存不下也先收起来：这次打开期间不再出现
    }
    setOff(true)
  }

  return (
    <div className="shared-dir-notice mx-auto mb-2 w-full max-w-(--content-w)">
      <div className={`${barRow} flex-wrap gap-y-1`}>
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="min-w-40 flex-1" title={info.peers.map((p) => p.title).join('\n')}>
          {text}
        </span>
        {info.canIsolate && (
          <button
            type="button"
            disabled={busy || !!task.working}
            onClick={() => void isolate()}
            title={
              task.working
                ? t('对话正在执行，等这一轮结束后再开独立分支')
                : t('从项目最新的提交开一个单独的分支和目录，这个对话之后在里面改，做完再合并或丢弃')
            }
            className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-accent-text hover:bg-accent/10 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
            {t('这个对话开独立分支')}
          </button>
        )}
        <button
          type="button"
          onClick={mute}
          title={t('这个项目里不再出现这条提醒（记在这个浏览器里）')}
          className="inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs text-muted hover:bg-sel hover:text-fg"
        >
          {t('不再提示')}
        </button>
      </div>
    </div>
  )
}
