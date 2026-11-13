import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleMinus, CircleX, RotateCw } from 'lucide-react'
import { mcpCatalogContract as C } from '@shared/api-contract/mcp-catalog'
import type { Audience, CatalogSource, McpCheckResult } from '@shared/mcp-catalog/types'
import { t } from '@shared/i18n'
import { defaultCli } from '@shared/settings'
import { call } from '@/lib/api/call'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { audienceLabel } from '@/components/ui/capability-row'
import { pluginIcon } from '@/plugins/icon'
import { mcpPageId, sourceCounts } from './McpNav'
import { reloadMcpCatalog, useMcpCatalog } from './mcp-store'
import { sourceIcon } from './source-icon'

/** 设置 →「MCP」第一页：检查 Agent 能拿到什么 + 各来源卡片 */
export function McpOverview({ onSection }: { onSection: (id: string) => void }) {
  const { data, loading, error } = useMcpCatalog()
  return (
    <div className="flex max-w-[880px] flex-col gap-8 pt-1">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-body text-muted">
          {t(
            '这里列出面板自己和开着的插件交给 Agent 的 MCP 工具：每个工具做什么、什么时候该用、会改什么。说明由面板和插件自己声明，和 Agent 实际拿到的是同一份。',
          )}
        </p>
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={reloadMcpCatalog} disabled={loading}>
          <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('刷新')}
        </Button>
      </div>
      <CheckCard />
      <section className="flex flex-col gap-3">
        <h3 className="text-body font-semibold">{t('来源')}</h3>
        {error && <p className="text-body text-danger">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {data?.sources.map((s) => (
            <SourceCard key={s.id} s={s} onOpen={() => onSection(mcpPageId(s.id))} />
          ))}
        </div>
      </section>
    </div>
  )
}

function SourceCard({ s, onOpen }: { s: CatalogSource; onOpen: () => void }) {
  const Icon = s.kind === 'plugin' ? pluginIcon(s.icon ?? '') : sourceIcon(s.kind)
  const tools = s.servers.flatMap((x) => x.tools).length
  const { missing } = sourceCounts(s)
  const what = [
    tools ? t('{n} 个工具', { n: tools }) : '',
    s.actions.length ? t('{n} 个面板动作', { n: s.actions.length }) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Card as="button" padding="md" interactive onClick={onOpen} className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sel text-muted">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-body font-medium">{s.name}</span>
          <span className="text-caption text-subtle">
            {s.kind === 'plugin' ? t('插件 {v}', { v: s.version ?? '' }) : t('面板自带')}
          </span>
        </span>
        <span className="mt-0.5 block text-caption text-muted">{what || t('没有给 Agent 的工具')}</span>
        {s.error ? (
          <span className="mt-0.5 block text-caption text-danger">{s.error}</span>
        ) : (
          tools > 0 && (
            <span className={cn('mt-0.5 block text-caption', missing ? 'text-warning' : 'text-subtle')}>
              {t('{a} / {b} 有说明', { a: tools - missing, b: tools })}
            </span>
          )
        )}
      </span>
    </Card>
  )
}

const KINDS: Audience[] = ['parent', 'child', 'helper', 'node', 'chat']

/** 检查 Agent 能拿到什么：服务端按真实规则现算（插件的 tools(run) 用预演模式问），不开对话、不起 CLI */
function CheckCard() {
  const { projects, agents, clis, settings } = useData()
  const defCli = settings ? defaultCli(settings) : ''
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? '')
  const [agentId, setAgentId] = useState('')
  const [cli, setCli] = useState(() => defCli || clis.find((c) => c.enabled)?.id || 'claude')
  const [kind, setKind] = useState<Audience>('parent')
  const [res, setRes] = useState<McpCheckResult>()
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    setErr('')
    call(C.check, { body: { projectId: kind === 'chat' ? '' : projectId, agentId, cli, kind } })
      .then((r) => live && setRes(r))
      .catch((e) => live && setErr((e as Error).message))
    return () => {
      live = false
    }
  }, [projectId, agentId, cli, kind])
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-body font-semibold">{t('检查 Agent 能拿到什么')}</h3>
      <Card padding="md" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            size="sm"
            className="w-48"
            aria-label={t('项目')}
            value={projectId}
            disabled={kind === 'chat'}
            onChange={(e) => setProjectId(e.target.value)}
            options={[{ value: '', label: t('不在项目里') }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          />
          <Select
            size="sm"
            className="w-48"
            aria-label={t('角色')}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            options={[{ value: '', label: t('默认角色') }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
          />
          <Select
            size="sm"
            className="w-40"
            aria-label="CLI"
            value={cli}
            onChange={(e) => setCli(e.target.value)}
            options={clis.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Segmented
            size="sm"
            label={t('对话类型')}
            value={kind}
            onChange={setKind}
            options={KINDS.map((k) => ({ id: k, label: audienceLabel(k) }))}
          />
        </div>
        {err && <p className="text-body text-danger">{err}</p>}
        {res && <CheckResult res={res} />}
      </Card>
    </section>
  )
}

function CheckResult({ res }: { res: McpCheckResult }) {
  if (!res.cli.mcp)
    return (
      <p className="flex items-start gap-2 text-body text-danger">
        <CircleX className="mt-0.5 h-4 w-4 shrink-0" />
        {t('{cli} 不支持 MCP：这样的对话拿不到面板和插件的任何工具。', { cli: res.cli.name })}
      </p>
    )
  return (
    <>
      <ul className="flex flex-col divide-y divide-border/60">
        {res.rows.map((r) => (
          <li key={`${r.source}-${r.server}`} className="flex items-start gap-3 py-2.5">
            {r.state === 'on' ? (
              <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            ) : r.state === 'error' ? (
              <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            ) : (
              <CircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
            )}
            <span className="w-24 shrink-0 truncate text-body font-medium">{r.name}</span>
            <code className="w-28 shrink-0 truncate font-mono text-caption leading-5 text-subtle">{r.server}</code>
            <span
              className={cn(
                'min-w-0 flex-1 text-body',
                r.state === 'on' ? 'text-muted' : r.state === 'error' ? 'text-danger' : 'text-subtle',
              )}
            >
              {r.reason}
            </span>
          </li>
        ))}
      </ul>
      {res.missing.map((m) => (
        <div
          key={m.source}
          className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-body text-warning"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t('{name} 有 {n} 个工具没写「什么时候用」，Agent 只能从原文里猜；升级插件后会补上。', {
              name: m.name,
              n: m.count,
            })}
          </span>
        </div>
      ))}
      <p className="text-caption text-subtle">
        {t('按真实规则现算，不会开对话。')}
        {res.last
          ? t('上一次真实对话「{title}」拿到 {n} 个工具{err}。', {
              title: res.last.title || t('（已删除）'),
              n: res.last.tools,
              err: res.last.errors.length ? t('，有插件出错：{e}', { e: res.last.errors.join('；') }) : t('，全部挂上'),
            })
          : t('面板这次启动后还没有对话取过工具。')}
      </p>
    </>
  )
}
