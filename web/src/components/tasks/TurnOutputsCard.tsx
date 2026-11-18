import { useEffect, useMemo, useState } from 'react'
import type { Task } from '@shared/schema'
import { currentRound, splitOutputs, turnOutputCandidates, type TurnOutput } from '@shared/turn-outputs/pick'
import { roundUrls, urlLabel } from '@shared/turn-outputs/local-url'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useLiveById } from '@/lib/live/store'
import { toast } from '@/lib/toast'
import { openWebTab, useWebHost } from '@/lib/web-view/tabs'
import { useFileRef } from '@/components/files/FileRefLayer'
import { OutputRow, OutputsCard, UrlRow } from '@/components/ui/outputs-card'
import { usePlugins } from '@/plugins/registry'
import { useFileOpen } from './FileDialog'
import { TaskHtmlCard } from './TaskHtmlCard'

/** 先列几个，其余的点「查看全部」展开（和完成依据一样） */
const FIRST = 4

/**
 * 本轮产出（设计稿 6.7，效果图 8）：对话停下后接在这一轮总结后面、完成依据上面，列出这一轮做出来的能直接看的文件。
 * 只看这一轮（用户最后一次发话以后，见 currentRound）：新的一轮结束后整张换成新一轮的，上一轮的去右栏「本对话改动」找。
 * 候选按 shared/turn-outputs/pick.ts 从这一轮的改动记录里挑，新建还是修改、大小由服务端查；没有就不显示
 */
export function TurnOutputsCard({ task }: { task: Pick<Task, 'id' | 'messages'> }) {
  const plugins = usePlugins()
  // 开着的插件文件查看器认得的扩展名也算（UE 插件的 .uasset 这类）
  const exts = useMemo(
    () => [...plugins.web.values()].flatMap((p) => (p.fileViewers ?? []).flatMap((v) => v.exts)),
    [plugins],
  )
  const cand = turnOutputCandidates(currentRound(task.messages), exts)
  const key = `${cand.msgs.join(',')}|${cand.paths.join('\n')}`
  const [got, setGot] = useState<{ key: string; files: TurnOutput[] } | null>(null)
  const [all, setAll] = useState(false)
  const refs = useFileRef()
  const openFile = useFileOpen()

  useEffect(() => {
    if (!cand.paths.length) return
    let off = false
    // 查不到（导入的对话、目录没了）就不显示这张卡片：它只是方便直接看，不影响对话
    api.turnOutputs(task.id, cand.msgs, cand.paths).then(
      (r) => !off && setGot({ key, files: r.files }),
      () => !off && setGot({ key, files: [] }),
    )
    return () => {
      off = true
    }
    // key 已经包含了候选消息和文件：cand 每次渲染都是新对象，不能放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, key])

  const files = got?.key === key ? got.files : []
  const urls = useRoundUrls(task)
  if (!urls.length && (!cand.paths.length || !files.length)) return null
  const { html, rest } = splitOutputs(files)
  const shownHtml = all ? html : html.slice(0, FIRST)
  const shownRest = all ? rest : rest.slice(0, Math.max(0, FIRST - shownHtml.length))
  const added = files.filter((f) => f.status === 'added').length
  const changed = files.length - added
  const fileNote = !files.length
    ? ''
    : !changed
      ? t('这一轮新建了 {n} 个能直接看的文件', { n: added })
      : !added
        ? t('这一轮改了 {n} 个能直接看的文件', { n: changed })
        : t('这一轮新建了 {a} 个、改了 {m} 个能直接看的文件', { a: added, m: changed })
  const urlNote = urls.length ? t('{n} 个可浏览的地址', { n: urls.length }) : ''
  const note = [urlNote, fileNote].filter(Boolean).join(' · ')
  const preview = (path: string) => (refs ? void refs.open({ path }) : openFile?.(path))
  return (
    <OutputsCard
      note={note}
      aside={t('上一轮的在「本对话改动」里')}
      urls={urls.length > 0 && <UrlRows taskId={task.id} urls={urls} />}
      cards={
        shownHtml.length > 0 && shownHtml.map((f) => <TaskHtmlCard key={f.path} path={f.path} size={f.size} compact />)
      }
      more={files.length > FIRST ? { all, onToggle: () => setAll(!all) } : undefined}
    >
      {shownRest.length > 0 &&
        shownRest.map((f) => (
          <OutputRow key={f.path} path={f.path} status={f.status} size={f.size} onPreview={() => preview(f.path)} />
        ))}
    </OutputsCard>
  )
}

/** 这一轮的可浏览地址（规则见 shared/turn-outputs/local-url.ts 的 roundUrls）：服务端经 live.urls 给 */
function useRoundUrls(task: Pick<Task, 'id' | 'messages'>) {
  const live = useLiveById(task.id)
  const since = [...task.messages].reverse().find((m) => m.role === 'user')?.at ?? ''
  return roundUrls(live?.urls ?? [], since)
}

/** 面板是不是在本机打开的：经穿透、局域网打开时 localhost 指的是看页面的这台，不是跑服务的那台 */
const onLocalHost = () => ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

/** 可浏览地址的几行：点地址或「在右栏打开」开到右栏网页页签，停止 / 重新运行走后台命令的接口 */
function UrlRows({ taskId, urls }: { taskId: string; urls: ReturnType<typeof roundUrls> }) {
  const host = useWebHost()
  const [busy, setBusy] = useState('')
  const remote = !onLocalHost()
  const act = async (job: string, run: () => Promise<{ ok: boolean; info: string }>) => {
    setBusy(job)
    try {
      const r = await run()
      if (!r.ok) toast.error(r.info)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return urls.map((u) => (
    <UrlRow
      key={u.job}
      url={u.url}
      running={u.state === 'running'}
      command={u.command}
      remote={remote}
      busy={busy === u.job}
      // 子对话的产出开在它所在的右栏（父对话页里时开到父对话那边）；没有右栏时新窗口打开
      onOpen={() =>
        host
          ? openWebTab(host.taskId, { kind: 'url', url: u.url }, { title: urlLabel(u.url) })
          : window.open(u.url, '_blank', 'noopener')
      }
      onStop={() => void act(u.job, () => api.stopJob(taskId, u.job))}
      onRerun={() => void act(u.job, () => api.rerunJob(taskId, u.job))}
    />
  ))
}
