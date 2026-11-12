import { useEffect, useRef, useState } from 'react'
import type { Project, ProjectInput } from '@shared/schema'
import { api } from '@/lib/api'
import type { useData } from '@/lib/data'
import type { useDirInfo } from '../DirPicker'
import type { AiSession, SetDraft, Vcs } from './project-draft'

/** 项目设置草稿周边的几个小副作用（从 ProjectSettingsDialog.tsx 的 Body 挪出，入参写明要什么） */

/**
 * 「禁止子对话执行」只对 Git 项目生效（ADR 0018）：路径变了重新判断，判断不出来按不是 Git 处理（置灰）。
 * 输入路径时每敲一个字都会变，等 300ms 再问，避免连续请求。
 * cherry-pick 目标也按这个判断：Git 下拉选分支，P4 填目标路径
 */
export function useDirVcs(path: string) {
  const [vcs, setVcs] = useState<Vcs>('none')
  useEffect(() => {
    const p = path.trim()
    if (!p) {
      setVcs('none')
      return
    }
    const timer = setTimeout(() => {
      api
        .dirVcs(p)
        .then((r) => setVcs(r.vcs))
        .catch(() => setVcs('none'))
    }, 300)
    return () => clearTimeout(timer)
  }, [path])
  return vcs
}

/**
 * 新建项目时 AI 会话还在跑就关掉了：草稿留给下次打开。
 * created / keep 交给保存：建好项目后就不用再留草稿了
 */
export function useDraftStash({
  project,
  ai,
  stash,
  draft,
}: {
  project?: Project
  ai: AiSession | null
  stash: { current: ProjectInput | null }
  draft: ProjectInput
}) {
  const draftNow = useRef(draft)
  draftNow.current = draft
  const created = useRef(false)
  const keep = useRef(false)
  keep.current = !project && !!ai && !created.current
  useEffect(
    () => () => {
      if (keep.current) stash.current = draftNow.current
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  return { created, keep }
}

/**
 * 页面上的项目列表是启动时读的：对话里的角色后来用 record_lesson 记的教训不在里面。
 * 打开时重新读一次，把新记的教训补进草稿，教训页才看得到，保存时也不会把它们盖掉
 */
export function useFreshLessons(
  project: Project | undefined,
  setProjects: ReturnType<typeof useData>['setProjects'],
  setDraft: SetDraft,
) {
  useEffect(() => {
    if (!project) return
    let alive = true
    api
      .projects()
      .then((list) => {
        const fresh = list.find((p) => p.id === project.id)
        if (!alive || !fresh) return
        setProjects(list)
        setDraft((d) => {
          // 用 Set 查：条目多时两层 some 是平方级，上万条要卡近一秒
          const have = new Set(d.lessons.map((x) => x.id))
          return { ...d, lessons: [...d.lessons, ...fresh.lessons.filter((l) => !have.has(l.id))] }
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // 只在打开（换项目）时读一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])
}

/**
 * 目录里已有初始化写好的 AGENTS.md 和文档（比如上次初始化完没保存、删了项目再建）：直接算初始化过，不用再跑一遍。
 * 只记是不是这样认出来的：目录再换成没初始化过的，要撤回
 */
export function useDirInit(dir: ReturnType<typeof useDirInfo>, initializedAt: string, setDraft: SetDraft) {
  const [dirInit, setDirInit] = useState(false)
  useEffect(() => {
    if (dir === undefined) return
    if (dir?.initialized && !initializedAt) {
      setDraft((d) => ({ ...d, initializedAt: new Date().toISOString() }))
      setDirInit(true)
    } else if (!dir?.initialized && dirInit) {
      setDraft((d) => ({ ...d, initializedAt: '' }))
      setDirInit(false)
    }
    // 只跟着目录检测结果走
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])
  return [dirInit, setDirInit] as const
}
