import { useEffect, useState } from 'react'
import type { Project } from '@shared/schema'
import type { DocFile, ProjectDocs } from '@shared/docs'
import { api } from '@/lib/api'

/**
 * 项目说明文件（AGENTS.md 和各个 CLI 读的说明）的读取和草稿（从 ProjectSettingsDialog.tsx 挪出）。
 * 草稿放在弹窗上：左栏的改动点、底栏的「n 个说明文件有改动」和确认保存都要读它。
 */
export function useProjectDocs(project: Project | undefined, draftPath: string) {
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const [docError, setDocError] = useState('')
  const [docDrafts, setDocDrafts] = useState<Partial<Record<DocFile, string>>>({})
  // 说明文件按保存过的目录读；目录改了要先确认保存，免得读写到旧目录
  const docsReady = !!project && !!project.path && draftPath.trim() === project.path
  useEffect(() => {
    if (!project || !project.path) return
    api
      .projectDocs(project.id)
      .then(setDocs)
      .catch((e) => setDocError((e as Error).message))
  }, [project])
  const docOf = (f: DocFile) => docs?.files.find((d) => d.path === f)
  const changedDocs = (Object.entries(docDrafts) as [DocFile, string][]).filter(
    ([f, c]) => c !== (docOf(f)?.content ?? '') && (docOf(f)?.exists || c.trim()),
  )
  const isChanged = (files: DocFile[]) => changedDocs.some(([f]) => files.includes(f))
  const hasDoc = (files: DocFile[]) => files.some((f) => docOf(f)?.exists)
  return { docs, setDocs, docError, docDrafts, setDocDrafts, docsReady, docOf, changedDocs, isChanged, hasDoc }
}

export type ProjectDocsState = ReturnType<typeof useProjectDocs>
