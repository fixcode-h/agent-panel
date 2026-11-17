import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import type { Project } from '@shared/schema'
import type { McpEntry, McpServer, McpTestResult } from '@shared/library'
import type { ProjectMcpDetected, ProjectMcpOverview } from '@shared/projects/mcp'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { openAiFix } from '@/lib/ai-fix'
import { ConfirmDialog } from '@/components/ui/dialog'
import { McpEditDialog, mcpSummary } from './McpEditDialog'
import { useAutoMcpNotice } from './use-auto-mcp'

/**
 * 「技能与 MCP」页「项目自己的」里的 MCP：项目目录里识别到的配置（导入、用 AI 排查、安全扫描），
 * 以及从这里添加、编辑、删掉面板管理的条目。状态和弹窗都在这里，列表怎么画归 OwnBlock。
 * 后端见 server/projects/mcp.ts，写入复用 mcp-store 那套（只动 mcpServers 里自己那几段）。
 * onChanged：导入、增删改之后「从全局继承」那份也要重读（导入的条目会出现在面板管理的工具里）
 */
export function useOwnMcp(project: Project, onChanged: () => void) {
  const [data, setData] = useState<ProjectMcpOverview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [edit, setEdit] = useState<McpEntry | 'new' | null>(null)
  const [del, setDel] = useState<McpEntry | null>(null)
  // 导入确认：一次一条或全部
  const [confirm, setConfirm] = useState<{ file: string; name: string; toProject?: boolean }[] | null>(null)
  const [importing, setImporting] = useState(false)
  const { notice, refreshProjects } = useAutoMcpNotice()

  const changed = (d: ProjectMcpOverview) => {
    setData(d)
    onChanged()
  }
  const load = () => {
    setLoading(true)
    api
      .projectMcp(project.id)
      .then((d) => {
        setData(d)
        setError('')
        notice(d)
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    setData(null)
    load()
    // load 每次渲染都是新的函数，只在换了项目时重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  /**
   * 让 AI 排查：把项目路径、这一条的配置原文、连接测试的报错一起交过去；修完刷新列表。
   * 走的是页面通用的「AI 处理」（web/src/lib/ai-fix.ts），不另做弹窗。
   */
  const diagnose = async (
    target?: { name: string; server: McpServer; origin: string; raw: string },
    known?: string,
  ) => {
    let test: McpTestResult | undefined
    if (target) {
      test =
        known === undefined
          ? await api
              .testProjectMcp(target.server)
              .catch((e) => ({ ok: false, error: (e as Error).message, tools: [] }))
          : { ok: false, error: known, tools: [] }
    }
    const context = [
      t('项目：{name}（{path}）', { name: project.name, path: project.path }),
      target && t('这一条的来源：{origin}', { origin: target.origin }),
      target && t('当前配置：\n{raw}', { raw: target.raw }),
      data?.detected.length
        ? t('项目里识别到的配置：\n{list}', {
            list: data.detected.map((d) => `${d.file} → ${d.name}\n${d.raw}`).join('\n\n'),
          })
        : '',
      data?.servers.length
        ? t('面板管理的配置（各 Agent 的全局配置）：\n{list}', {
            list: data.servers
              .map((s) => `${s.name}（${s.transport}），装在：${s.clis.join('、') || t('没有')}`)
              .join('\n'),
          })
        : '',
      data?.errors.length
        ? t('读不懂的配置文件：\n{list}', {
            list: data.errors.map((e) => `${e.file}：${e.error}`).join('\n'),
          })
        : '',
    ].filter(Boolean)
    openAiFix({
      title: target ? t('项目的 MCP「{name}」', { name: target.name }) : t('项目的 MCP 配置'),
      error: test && !test.ok ? (test.error ?? '') : '',
      output: test?.ok ? t('连接成功，{n} 个工具', { n: test.tools.length }) : '',
      context: context.join('\n\n'),
      cwd: project.path,
      topic: 'project-mcp',
      home: { kind: 'project', projectId: project.id },
      // 修完可能是改了文件，也可能是装了包：重新读一遍列表
      onDone: load,
    })
  }
  const diagnoseDetected = (d: ProjectMcpDetected) =>
    void diagnose({ name: d.name, server: d.server, origin: `${d.file}（${d.source}）`, raw: d.raw })

  const doImport = async () => {
    if (!confirm?.length) return
    setImporting(true)
    try {
      const r = await api.importProjectMcp(project.id, confirm)
      changed(r.overview)
      if (r.done.length) {
        toast.success(
          confirm[0]?.toProject
            ? t('已改为只在本项目生效：{name}', { name: r.done[0].name })
            : t('已导入 {n} 条配置', { n: r.done.length }),
        )
        // 导入的同时在这个项目里打开了：项目记录变了，重新取一份
        refreshProjects()
      }
      if (r.skipped.length)
        toast.error(t('{n} 条没有导入：{reason}', { n: r.skipped.length, reason: r.skipped[0].reason }))
      setConfirm(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  // 还能导入的：名字合法、和面板里的不一样
  const todo = (data?.detected ?? []).filter((d) => d.nameOk && d.status !== 'same')
  /** 导入过的按项目条目在这个项目里开没开；全局的对所有项目生效，返回 undefined 不标 */
  const onHere = (name: string) =>
    data?.servers.find((x) => x.name === name)?.activation === 'project'
      ? !!project.capabilities?.mcp?.includes(name)
      : undefined
  const entryOf = (name: string) => data?.servers.find((x) => x.name === name)

  const dialogs = (
    <>
      {data && edit && (
        <McpEditDialog
          entry={edit === 'new' ? undefined : edit}
          clis={data.clis}
          projectId={project.id}
          onClose={() => setEdit(null)}
          onSaved={(d) => {
            changed(d)
            setEdit(null)
          }}
          onDiagnose={(server, err) =>
            void diagnose(
              { name: server.name, server, origin: t('编辑中的配置'), raw: JSON.stringify(server, null, 2) },
              err,
            )
          }
        />
      )}
      <ConfirmDialog
        open={!!confirm?.length}
        onOpenChange={(o) => !o && !importing && setConfirm(null)}
        title={
          confirm?.[0]?.toProject
            ? t('把「{name}」改为只在本项目生效？', { name: confirm[0].name })
            : confirm?.length === 1
              ? t('导入「{name}」？', { name: confirm[0].name })
              : t('导入这 {n} 条配置？', { n: confirm?.length ?? 0 })
        }
        description={
          confirm?.[0]?.toProject
            ? t(
                '会从各 Agent 的全局配置里移走它，改成只在这个项目生效并打开；别的项目要用，在那个项目的「管理能力」里打开。项目里的配置文件不会改动。',
              )
            : t(
                '导入成只在这个项目生效的 MCP 并打开，之后由面板管理；项目里的配置文件不会改动。面板里已有同名的会用项目里的配置覆盖。',
              )
        }
        confirmText={confirm?.[0]?.toProject ? t('改为只在本项目') : t('导入')}
        onConfirm={doImport}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={t('删除「{name}」？', { name: del?.name ?? '' })}
        description={t('会从所有 Agent 的配置文件里移除这个工具。')}
        onConfirm={async () => {
          try {
            changed(await api.deleteProjectMcp(project.id, del!.name))
            setDel(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </>
  )

  return {
    data,
    error,
    loading,
    load,
    todo,
    onHere,
    entryOf,
    summary: mcpSummary,
    diagnose,
    diagnoseDetected,
    askImport: setConfirm,
    add: () => setEdit('new'),
    edit: (e: McpEntry) => setEdit(e),
    remove: (e: McpEntry) => setDel(e),
    dialogs,
  }
}

export type OwnMcp = ReturnType<typeof useOwnMcp>
