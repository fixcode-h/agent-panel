import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import type { Project, ProjectInput, Workflow } from '@shared/schema'
import type { Proposal } from '@shared/assist'
import type { ProjectProposal } from '@shared/project-init'
import type { ProjectDocs } from '@shared/docs'
import { GENERAL_NAME, UE_PROJECT_NAME } from '@shared/builtin/workflows'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { runAssistInProject } from '@/lib/assist-conv'
import type { AiSession, SetDraft } from './project-draft'

/**
 * 「AI 初始化项目」：先快速扫一遍目录（几毫秒，拿技术栈、版本控制这类能直接读出的线索），
 * 再打开 AI 对话，让本机 Agent 在项目目录里写 AGENTS.md 和文档框架、评估工作流和设置。
 * 推荐项回到「AI 初始化」页应用；收下结果才算初始化过，之后才能确认保存。
 * 从 ProjectSettingsDialog.tsx 的 Body 挪出：「常规」和「AI 初始化」两页都能发起，收结果时要切页、刷新说明文件。
 */
export function useProjectInit({
  project,
  draft,
  setDraft,
  workflows,
  initialSection,
  item,
  onAssist,
  deliver,
  setDirInit,
  setSection,
  setDocs,
}: {
  project?: Project
  draft: ProjectInput
  setDraft: SetDraft
  workflows: Workflow[]
  initialSection?: string
  item?: string
  onAssist: (s: AiSession) => void
  deliver: (projectId: string, p: Proposal) => void
  setDirInit: (v: boolean) => void
  setSection: (s: string) => void
  setDocs: (d: ProjectDocs) => void
}) {
  const [analyzing, setAnalyzing] = useState(false)
  const [signals, setSignals] = useState<string[]>([])
  // 这次打开弹窗里 AI 初始化的结果：推荐项在「AI 初始化」页逐项或整体应用
  const [init, setInit] = useState<ProjectProposal | null>(null)
  const [scan, setScan] = useState<Awaited<ReturnType<typeof api.analyzeProject>> | null>(null)
  const startInit = async () => {
    if (!draft.path.trim() || analyzing) return
    setAnalyzing(true)
    try {
      const r = await api.analyzeProject(draft.path)
      setScan(r)
      setSignals(r.signals)
      const start = t('初始化这个项目：写好 AGENTS.md 和项目文档框架，评估可用的工作流，推荐项目设置')
      const subject = { path: draft.path.trim(), scan: scanText(r) }
      // 已经建好的项目：在这个项目里开一个对话来做，过程和结果留在项目的对话列表里（AI 分析统一归属）
      if (project?.id) {
        runAssistInProject({
          kind: 'project',
          projectId: project.id,
          title: t('AI 初始化项目：{name}', { name: project.name }),
          start,
          subject,
          onProposal: (p) => deliver(project.id, p),
        })
        return
      }
      // 新建项目还没保存、没有项目可放对话：照旧在 AI 窗口里做。目录和扫描线索随会话一起存，关掉设置后草稿没了也能继续用
      onAssist({ kind: 'project', title: t('AI 初始化项目'), start, subject })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }
  // 对话里的 AI 按用户要求初始化项目（动作 project.init 打开时带 item=start）：打开就开始，不用再点按钮
  const autoInit = useRef(initialSection === 'init' && item === 'start')
  useEffect(() => {
    if (!autoInit.current) return
    autoInit.current = false
    void startInit()
    // 只在打开时看一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // AI 没评估出默认工作流时按项目类型落到内置的「通用项目」/「UE 项目」
  const fallbackWorkflow = (type: 'general' | 'ue') => {
    const want = type === 'ue' ? UE_PROJECT_NAME : GENERAL_NAME
    return workflows.find((w) => w.origin === `builtin:project-${type}`) ?? workflows.find((w) => w.name === want)
  }
  // 刚初始化的结果和上次保存的推荐都按项目类型找内置工作流兜底
  const initType = init?.type ?? draft.initResult?.type
  const initFallbackId = initType ? (fallbackWorkflow(initType)?.id ?? '') : ''
  const acceptInit = (p: ProjectProposal) => {
    // 扫描给的工作流参数（结构技能、文档目录）没被 AI 覆盖时一起推荐
    const params = scan && scan.workflow === p.type ? { ...scan.workflowParams, ...p.params } : p.params
    const def = p.workflows.find((w) => w.verdict === 'default')?.id ?? fallbackWorkflow(p.type)?.id
    const expose = workflows.find((w) => w.id === def)?.expose ?? []
    const result: ProjectProposal = {
      ...p,
      params: Object.fromEntries(Object.entries(params).filter(([k]) => expose.some((e) => e.key === k))),
    }
    setInit(result)
    // 推荐随项目保存：关掉设置再打开，卡片上还能直接应用（点「确认」才真正写进项目）
    setDraft((d) => ({ ...d, initializedAt: new Date().toISOString(), initResult: result }))
    setDirInit(false)
    setSection('init')
    // AGENTS.md 刚被改过，「项目说明」页要读新的
    if (project?.path)
      void api
        .projectDocs(project.id)
        .then(setDocs)
        .catch(() => {})
    toast.success(t('初始化完成，按需应用推荐的设置后点「确认」保存'))
  }
  return { analyzing, signals, init, startInit, acceptInit, initFallbackId }
}

/** 扫描结果写成交给 AI 的线索 */
function scanText(r: Awaited<ReturnType<typeof api.analyzeProject>>) {
  return [
    `- 名称：${r.name}`,
    r.description ? `- 简介：${r.description}` : '',
    `- 类型：${r.workflow}`,
    ...r.signals.map((s) => `- ${s}`),
    r.testSteps.length ? `- 扫出的测试步骤：${r.testSteps.map((s) => `${s.name}（${s.command}）`).join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
