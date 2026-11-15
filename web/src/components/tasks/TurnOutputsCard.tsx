import { useEffect, useMemo, useState } from 'react'
import type { Task } from '@shared/schema'
import { currentRound, splitOutputs, turnOutputCandidates, type TurnOutput } from '@shared/turn-outputs/pick'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useFileRef } from '@/components/files/FileRefLayer'
import { OutputRow, OutputsCard } from '@/components/ui/outputs-card'
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
  if (!cand.paths.length || !files.length) return null
  const { html, rest } = splitOutputs(files)
  const shownHtml = all ? html : html.slice(0, FIRST)
  const shownRest = all ? rest : rest.slice(0, Math.max(0, FIRST - shownHtml.length))
  const added = files.filter((f) => f.status === 'added').length
  const changed = files.length - added
  const note = !changed
    ? t('这一轮新建了 {n} 个能直接看的文件', { n: added })
    : !added
      ? t('这一轮改了 {n} 个能直接看的文件', { n: changed })
      : t('这一轮新建了 {a} 个、改了 {m} 个能直接看的文件', { a: added, m: changed })
  const preview = (path: string) => (refs ? void refs.open({ path }) : openFile?.(path))
  return (
    <OutputsCard
      note={note}
      aside={t('上一轮的在「本对话改动」里')}
      cards={shownHtml.length > 0 && shownHtml.map((f) => <TaskHtmlCard key={f.path} path={f.path} size={f.size} />)}
      more={files.length > FIRST ? { all, onToggle: () => setAll(!all) } : undefined}
    >
      {shownRest.length > 0 &&
        shownRest.map((f) => (
          <OutputRow key={f.path} path={f.path} status={f.status} size={f.size} onPreview={() => preview(f.path)} />
        ))}
    </OutputsCard>
  )
}
