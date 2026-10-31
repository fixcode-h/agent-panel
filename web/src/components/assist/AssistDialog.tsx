import { useEffect, useMemo, useRef, useState } from 'react'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import * as D from '@radix-ui/react-dialog'
import { toast, toastError } from '@/lib/toast'
import { Check, CircleAlert, Crown, Loader2, Minus, Sparkles, Terminal, Wand2, X } from 'lucide-react'
import {
  applyProposal,
  type AssistJob,
  type AssistKind,
  type AssistMessage,
  type ProjectProposal,
  type Proposal,
} from '@shared/assist'
import { CLIS, MODEL_TIERS, type CliDefinition, type ModelTier } from '@shared/clis'
import { agentRun, cliSettings, defaultCli, orderClis } from '@shared/settings'
import type {
  Agent,
  AgentInput,
  GlobalLesson,
  ParamValues,
  Settings,
  TaskMessage,
  TestStep,
  Workflow,
} from '@shared/schema'
import type { DerivedParam } from '@shared/agent-params'
import type { GlobalLessonChange } from '@shared/lessons'
import { ENV_LABEL } from '@shared/test-steps'
import { api } from '@/lib/api'
import { cliColor, defaultEffortOptions, effortValue, modelEfforts } from '@/lib/cli-style'
import { useCliDef } from '@/lib/cli-models'
import { Select } from '@/components/ui/input'
import { useAgentView } from '@/lib/agent-view'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import type { McpServer } from '@shared/library'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { ChipGroup } from '@/components/ui/chip-group'
import { Checkbox } from '@/components/ui/checkbox'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { MinimizedChat } from '@/components/ui/minimized-chat'
import { FlowCanvas } from '@/components/flow/FlowCanvas'
import { ChatReply, FoldedRun, type Author } from '@/components/tasks/Messages'
import { UserMessage } from '@/components/chat/ChatMessage'
import { ChatComposer } from '@/components/chat/ChatComposer'
import { useAttachments } from '@/components/chat/Attachments'
import { modelOptions } from '@/components/agents/ModelSelect'
import { nodeViews } from '@/components/flow/views'
import { entryFlow, flowLabel, getFlow } from '@shared/flow'
import { AskToggle, ScopeRequests, useNewAskUser } from '@/components/chat/AskToggle'
import { askUserDefault } from '@/lib/askUserDefault'
import { t } from '@shared/i18n'
import { fmtDuration } from '@shared/duration'

type Turn = AssistMessage & { proposal?: Proposal; error?: string; msgs?: TaskMessage[] }

const EXAMPLES: Record<AssistKind, string[]> = {
  agent: [
    t('一个专门写 Playwright 端到端测试的角色，用 Claude Code'),
    t('负责代码审查的角色，重点看安全和性能问题'),
    t('帮我写 Go 后端接口的角色，用 Codex'),
  ],
  workflow: [
    t('Web 功能开发：先分析需求，前后端并行开发，然后测试和代码审查，最后验收'),
    t('Bug 修复：复现问题、定位修复、回归测试'),
    t('文档更新：并行整理 README 和接口文档，再统一校对'),
  ],
  skill: [
    t('一个按团队约定写提交说明的 Skill：先看改动，再按「类型：标题」的格式写'),
    t('代码审查 Skill：逐个文件看改动，先给结论，再列问题和缺失的测试'),
    t('帮我写技术方案文档的 Skill，包含背景、方案对比、风险和排期'),
  ],
  command: [
    t('/fix-issue <编号>：读 issue，定位原因并修复，补上回归测试'),
    t('/changelog：按最近的提交整理一段给用户看的更新说明'),
    t('/i18n：找出界面里没翻译的文案，补上英文'),
  ],
  mcp: [],
  params: [
    t('按这个项目的情况，把测试与验收的参数配一下'),
    t('这个项目在 Windows 上，端到端测试要在 WSL 里跑，按这个填'),
  ],
  lessons: [t('把这个项目里换个项目也适用的教训提取出来'), t('只看角色自己记的那些，挑出通用的')],
  project: [t('初始化这个项目：写好 AGENTS.md 和项目文档框架，评估可用的工作流，推荐项目设置')],
  teststeps: [
    t('按项目现在的脚本，生成一套类型检查、单元测试、端到端和构建的步骤'),
    t('这是 UE 项目，补上编译和 Lua 语法检查的步骤'),
  ],
}

/** Skill、命令的预览：优化时和当前内容对比，标出改没改 */
function SkillPreview({
  name,
  content,
  before,
  command,
}: {
  name: string
  content: string
  before?: string
  command?: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {command ? (
          <Terminal className="h-4 w-4 text-accent-text" />
        ) : (
          <Sparkles className="h-4 w-4 text-accent-text" />
        )}
        <span className="font-mono text-heading font-semibold">
          {command ? '/' : ''}
          {name}
        </span>
        {before !== undefined && (
          <Badge tone={before === content ? 'neutral' : 'accent'}>
            {before === content ? t('没有变化') : t('已修改')}
          </Badge>
        )}
      </div>
      <span className="text-xs text-muted">{command ? t('命令文件（所有 Agent 共用）') : 'SKILL.md'}</span>
      <pre className="max-h-[560px] overflow-auto rounded-lg border bg-field p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
        {content}
      </pre>
    </div>
  )
}

/** MCP 工具的预览：修复后的配置，和修改前不同的字段标出来 */
function McpPreview({ server, before }: { server: McpServer; before?: McpServer }) {
  const rows: [string, keyof McpServer, string][] =
    server.transport === 'stdio'
      ? [
          [t('启动命令'), 'command', server.command],
          [t('参数'), 'args', server.args.join(' ')],
          [
            t('环境变量'),
            'env',
            Object.entries(server.env)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n'),
          ],
        ]
      : [
          [t('地址'), 'url', server.url],
          [
            t('请求头'),
            'headers',
            Object.entries(server.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n'),
          ],
        ]
  const changed = (k: keyof McpServer) => before && JSON.stringify(before[k]) !== JSON.stringify(server[k])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-heading font-semibold">{server.name}</span>
        <Badge>{server.transport === 'stdio' ? t('本地命令') : t('远程地址')}</Badge>
        {before && before.transport !== server.transport && <Badge tone="accent">{t('已修改')}</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-body">
        {rows.map(([label, key, value]) => (
          <div key={key} className="contents">
            <dt className="text-subtle">{label}</dt>
            <dd className="flex flex-wrap items-start gap-2">
              <span className="font-mono text-xs break-all whitespace-pre-wrap">{value || t('（空）')}</span>
              {changed(key) && <Badge tone="accent">{t('已修改')}</Badge>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function AgentPreview({ agent, before, newCategory }: { agent: AgentInput; before?: Agent; newCategory: string }) {
  const { categories } = useData()
  const { cliOf, modelOf } = useAgentView()
  const changed = (k: keyof AgentInput) => before && JSON.stringify(before[k]) !== JSON.stringify(agent[k])
  const tag = (k: keyof AgentInput) => (changed(k) ? <Badge tone="accent">{t('已修改')}</Badge> : null)
  const cat = newCategory || categories.find((c) => c.id === agent.categoryId)?.name
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <AgentAvatar icon={agent.icon} cli={agent.cli} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-subtitle font-semibold">{agent.name}</span>
            {tag('name')}
          </div>
          <p className="text-body text-muted">
            {agent.description || t('没有简介')} {tag('description')}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body">
        <dt className="text-subtle">Agent</dt>
        <dd className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: cliColor(cliOf(agent)) }} />
          {agent.cli
            ? CLIS.find((c) => c.id === agent.cli)?.name
            : t('系统默认（{cli}）', { cli: CLIS.find((c) => c.id === cliOf(agent))?.name ?? cliOf(agent) })}{' '}
          {tag('cli')}
        </dd>
        <dt className="text-subtle">{t('模型')}</dt>
        <dd className="font-mono text-xs">
          {modelOf(agent)} {tag('model')}
        </dd>
        <dt className="text-subtle">{t('分类')}</dt>
        <dd>
          {cat || t('未分类')} {newCategory && <Badge>{t('新建')}</Badge>} {tag('categoryId')}
        </dd>
      </dl>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs text-muted">
          {t('角色设定')} {tag('instructions')}
        </span>
        <pre className="max-h-[340px] overflow-auto rounded-lg border bg-field p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
          {agent.instructions || t('（空）')}
        </pre>
      </div>
    </div>
  )
}

function WorkflowPreview({ p }: { p: Extract<Proposal, { kind: 'workflow' }> }) {
  const { agents, workflows } = useData()
  const { modelOf } = useAgentView()
  const w = p.workflow
  const who = (id: string) => {
    const a = agents.find((x) => x.id === id) ?? p.newAgents.find((x) => x.ref === id)
    return a ? { ...a, isNew: id.startsWith('new:') } : undefined
  }
  const main = who(w.mainAgentId)
  const pool = [...agents, ...p.newAgents.map((a): Agent => ({ ...a, id: a.ref, createdAt: '', updatedAt: '' }))]
  const [fid, setFid] = useState(w.entryFlowId)
  const flow = getFlow(w, fid) ?? entryFlow(w)
  const views = nodeViews(flow, w, workflows, pool, modelOf)
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-subtitle font-semibold">{w.name}</div>
        <p className="text-body text-muted">{w.description || t('没有简介')}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[
          main && { a: main, role: t('主角色') },
          ...w.members.map((m) => ({ a: who(m.agentId), role: m.responsibility })),
        ]
          .filter((x): x is { a: NonNullable<ReturnType<typeof who>>; role: string } => !!x && !!x.a)
          .map(({ a, role }, i) => (
            <span
              key={i}
              title={role}
              className={cn(
                'flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-1 text-xs',
                a.isNew ? 'bg-accent-soft' : 'bg-sel/70',
              )}
            >
              <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
              {a.name}
              {i === 0 && <Crown className="h-3 w-3 text-accent-text" />}
              {a.isNew && <span className="text-caption text-accent-text">{t('新建')}</span>}
            </span>
          ))}
      </div>
      <div className="overflow-hidden rounded-xl border">
        {w.flows.length > 1 && (
          <div role="tablist" className="flex flex-wrap gap-1 border-b p-1.5">
            {w.flows.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={f.id === flow.id}
                onClick={() => setFid(f.id)}
                className={cn(
                  'h-7 cursor-pointer rounded-md px-2.5 text-xs',
                  f.id === flow.id ? 'bg-sel font-medium text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {flowLabel(f, w)}
              </button>
            ))}
          </div>
        )}
        <FlowCanvas
          key={flow.id}
          flow={flow}
          views={views}
          startSub={flow.id === w.entryFlowId ? t('主流程') : t('子流程')}
          selected=""
          onSelect={() => {}}
          className="flex h-[360px] bg-panel"
        />
      </div>
      {p.newAgents.length > 0 && (
        <p className="text-xs text-muted">
          {t('应用时会先创建 {n} 个新角色：{names}。', {
            n: p.newAgents.length,
            names: p.newAgents.map((a) => a.name).join(t('、')),
          })}
        </p>
      )}
      {w.document.trim() && (
        <details className="rounded-lg border bg-field">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted">{t('工作流说明')}</summary>
          <pre className="max-h-[260px] overflow-auto border-t px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {w.document}
          </pre>
        </details>
      )}
    </div>
  )
}

/** 生成中：流式显示思考过程、说明文字、用到的工具和已写的字数，加上已用时间 */
function JobProgress({
  job,
  cliName,
  author,
  teamNames,
}: {
  job: AssistJob
  cliName: string
  author: Author
  teamNames: Set<string>
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = job.startedAt ? Math.max(0, now - job.startedAt) : 0
  const writingJson = (job.outChars ?? 0) > job.text.length + 20
  const phase =
    job.attempt > 1
      ? t('格式不对，正在让 Agent 修正')
      : writingJson
        ? t('正在写配置（已写 {n} 字）', { n: (job.outChars ?? 0).toLocaleString() })
        : job.text
          ? t('正在写说明')
          : job.thinking
            ? t('正在思考')
            : t('{cli} 正在生成', { cli: cliName })
  return (
    <div className="flex flex-col gap-2 text-body leading-relaxed">
      {/* 和任务页同一套消息流：思考可以折叠，工具调用点开看详情 */}
      {!!job.messages?.length && <FoldedRun msgs={job.messages} teamNames={teamNames} live author={author} />}
      <span className="flex items-center gap-2 text-xs text-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-text" />
        {phase}…<span className="tabular-nums">{fmtDuration(elapsed)}</span>
      </span>
    </div>
  )
}

/** 输入框下面的模型、思考强度：显示这次实际会用的值，选了就只对这次生成生效 */
function RunPicker({
  def,
  settings,
  model,
  effort,
  onModel,
  onEffort,
  disabled,
}: {
  def: CliDefinition
  settings: Settings
  model: string
  effort: string
  onModel: (v: string) => void
  onEffort: (v: string) => void
  disabled?: boolean
}) {
  const cs = cliSettings(settings, def.id)
  const run = agentRun({ cli: def.id, model, effort }, settings)
  // 不单独放「默认」选项：默认会用到的那个模型直接选中，后面标上（默认）
  const base = agentRun({ cli: def.id, model: '' }, settings)
  const defaultModel = base.model || def.models.find((m) => m.isDefault)?.id || ''
  const tierRun = (tier: ModelTier) => agentRun({ cli: def.id, model: `@${tier}` }, settings)
  // 和 Agent、设置里的模型下拉同一套：档位、CLI 读取、配置文件三组，默认的那项标（默认）
  const defaultPick = cs.defaultModel || def.models.find((m) => m.isDefault)?.id || ''
  const tierRuns = Object.fromEntries(MODEL_TIERS.map((m) => [m.id, { model: tierRun(m.id).model }])) as Record<
    ModelTier,
    { model: string }
  >
  const options = modelOptions(def, { tiers: tierRuns, defaultValue: defaultPick, extra: [model] })
  // 思考强度的默认：档位或设置给的，其次是模型自己的默认
  const usedModel = run.model || defaultModel
  const defaultEffort =
    agentRun({ cli: def.id, model }, settings).effort || def.models.find((m) => m.id === usedModel)?.defaultEffort || ''
  // 只列这个模型支持的强度：模型不认的强度 CLI 会启动即报错退出
  const effortOpts = defaultEffortOptions(def, defaultEffort, modelEfforts(def, usedModel))
  const compact =
    'h-7 w-auto min-w-0 gap-1 rounded-md border-transparent bg-transparent px-2 text-footnote text-muted shadow-none hover:bg-sel hover:text-fg'
  return (
    <div
      className="flex min-w-0 items-center gap-0.5"
      title={
        t('这次用 {model}', { model: run.model || defaultModel || t('Agent 自动选择的模型') }) +
        (run.effort ? ` · ${run.effort}` : '')
      }
    >
      <Select
        aria-label={t('模型')}
        value={model === defaultPick ? '' : model}
        // 选默认的那项就是留空，之后设置里改了默认也会跟着变
        onChange={(e) => onModel(e.target.value)}
        options={options}
        disabled={disabled}
        // 限制宽度：模型名很长时截断，不要把右边的发送按钮挤出去
        className={cn(compact, 'max-w-[170px] font-mono')}
      />
      {effortOpts.length > 1 && (
        <Select
          aria-label={t('思考强度')}
          value={effortValue(def, defaultEffort, modelEfforts(def, usedModel), effort)}
          onChange={(e) => onEffort(e.target.value)}
          disabled={disabled}
          className={cn(compact, 'max-w-[130px]')}
          options={effortOpts}
        />
      )}
      {!cs.enabled && <span className="text-caption text-warning">{t('已停用')}</span>}
    </div>
  )
}

/** 参数和测试步骤的预览：都是「这次要填进表单草稿」的值，确认后才生效 */
function ParamPreview({ values, spec }: { values: ParamValues; spec: DerivedParam[] }) {
  const rows = spec.filter((d) => d.key in values)
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs text-muted">{t('这些值只会填进表单，保存项目设置后才生效')}</span>
      {rows.length === 0 ? (
        <span className="text-body text-subtle">{t('没有给出可用的值')}</span>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body">
          {rows.map((d) => (
            <div key={d.key} className="contents">
              <dt className="text-subtle">
                {d.label}
                <span className="ml-1 font-mono text-caption">{d.key}</span>
              </dt>
              <dd className="font-mono text-xs break-all">{JSON.stringify(values[d.key])?.replace(/^"|"$/g, '')}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/**
 * 全局教训的预览：每条改动前面一个勾选框，用户勾了的才会写进去；
 * 改写已有的那条时把原来的规则一起列出来对照
 */
function LessonChangesPreview({
  changes,
  globals,
  picked,
  onPick,
}: {
  changes: GlobalLessonChange[]
  globals: GlobalLesson[]
  picked: Set<number>
  onPick: (i: number, on: boolean) => void
}) {
  if (!changes.length)
    return <p className="text-body text-subtle">{t('没有适合提取成全局教训的条目，原因见左边的说明。')}</p>
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs text-muted">{t('全局教训会带进所有项目的对话。勾选要采用的，确认后才会写进去。')}</span>
      <ul className="flex flex-col gap-2">
        {changes.map((c, i) => {
          const old = c.op === 'update' ? globals.find((g) => g.id === c.id) : undefined
          return (
            <li key={i} className={cn('rounded-lg bg-sel/40 p-2.5', !picked.has(i) && 'opacity-60')}>
              <Checkbox
                checked={picked.has(i)}
                onChange={(v) => onPick(i, v)}
                className="w-full"
                label={
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={old ? 'accent' : 'neutral'}>{old ? t('改写') : t('新加')}</Badge>
                      <span className="text-body font-medium">{c.title}</span>
                    </span>
                    {c.rule && <span className="text-xs leading-relaxed text-muted">{c.rule}</span>}
                    {c.cause && <span className="text-xs text-subtle">{t('起因：{text}', { text: c.cause })}</span>}
                    {old && (
                      <span className="mt-1 rounded-md bg-field px-2 py-1.5 text-xs text-subtle">
                        {t('原来：{text}', { text: old.title })}
                        {old.rule && <span className="mt-0.5 block line-through decoration-subtle/60">{old.rule}</span>}
                      </span>
                    )}
                  </span>
                }
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TestStepsPreview({ steps }: { steps: TestStep[] }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs text-muted">{t('这些步骤只会填进表单，保存项目设置后才生效')}</span>
      <ol className="flex flex-col gap-2">
        {steps.map((s) => (
          <li key={s.id} className="rounded-lg bg-sel/40 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium">{s.name}</span>
              <Badge>{ENV_LABEL[s.env]}</Badge>
              {s.when && <span className="text-xs text-subtle">{s.when}</span>}
              {!s.enabled && <span className="text-xs text-subtle">{t('停用')}</span>}
            </div>
            <code className="mt-1 block font-mono text-xs break-all whitespace-pre-wrap">{s.command}</code>
            {s.note && <p className="mt-1 text-xs text-subtle">{s.note}</p>}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** 初始化的预览：写了哪些文件、推荐了多少项；逐项应用在项目设置的「AI 初始化」页 */
function ProjectPreview({ p }: { p: ProjectProposal }) {
  const recs =
    p.settings.length +
    Object.keys(p.params).length +
    p.workflows.filter((w) => w.verdict !== 'skip').length +
    (p.steps.length ? 1 : 0)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-heading font-semibold">{p.name}</span>
          <Badge>{p.type === 'ue' ? t('UE 项目') : t('一般项目')}</Badge>
        </div>
        {p.description && <p className="text-body leading-relaxed text-muted">{p.description}</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">{t('写入的文件')}</span>
        {p.files.length ? (
          <ul className="flex flex-col gap-1">
            {p.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 text-xs">
                <Badge tone={f.action === 'created' ? 'success' : f.action === 'updated' ? 'accent' : 'neutral'}>
                  {f.action === 'created' ? t('新建') : f.action === 'updated' ? t('修改') : t('未改')}
                </Badge>
                <code className="min-w-0 truncate font-mono">{f.path}</code>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-subtle">{t('没有报告写入的文件')}</span>
        )}
      </div>
      <p className="rounded-lg bg-sel/40 px-3 py-2.5 text-body leading-relaxed">
        {t(
          '推荐了 {n} 项设置（工作流、测试步骤、子对话、文件格式等）。点「查看推荐并应用」回到项目设置，逐项或整体应用。',
          {
            n: recs,
          },
        )}
      </p>
    </div>
  )
}

/**
 * 用本机 CLI 对话生成 / 优化 Agent 或工作流。左边对话，右边预览最新的结果，确认后应用。
 */
export function AssistDialog({
  open,
  onOpenChange,
  kind,
  target,
  onApplied,
  subject,
  title,
  autoStart,
  onApply,
  projectId,
  paramSpec,
  paramAgentId,
  globalLessons,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  kind: AssistKind
  /** 有值表示优化它，没有表示新建；params 时是要配的工作流 */
  target?: Agent | Workflow
  onApplied?: (r: { agent?: Agent; workflow?: Workflow }) => void
  /** Skill、MCP 工具的当前内容（见 AssistInput.subject）；params 时用 agentId 指定只配一个 Agent */
  subject?: Record<string, string>
  /** Skill、MCP 工具优化 / 修复时显示的名字 */
  title?: string
  /** 打开后自动发出的第一句话（例如让 AI 排查测试连接的报错） */
  autoStart?: string
  /** Skill、MCP、参数、测试步骤的结果交给页面去应用 */
  onApply?: (p: Proposal) => Promise<void> | void
  /** params / teststeps：只读分析这个项目 */
  projectId?: string
  /** params：预览用的参数说明（和项目设置里派生的同一份） */
  paramSpec?: DerivedParam[]
  /** params：只配这一个 Agent 分组的参数 */
  paramAgentId?: string
  /** lessons：现有的全局教训，预览「改写」时对照 */
  globalLessons?: GlobalLesson[]
}) {
  const shown = target?.name ?? title
  const { clis, settings, categories, agents, setAgents, setCategories, setWorkflows } = useData()
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const usable = clis.filter((c) => c.installed && c.enabled)
  const [cli, setCli] = useState('')
  // 这次生成用的模型和思考强度：默认跟设置走，可以在输入框下面临时调整
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const cliDef = useCliDef(cli)
  // 消息流里的「说话人」就是这次用的 CLI
  const author: Author = { name: CLIS.find((c) => c.id === cli)?.name ?? cli, cli, icon: 'sparkles' }
  const pickCli = (id: string) => {
    setCli(id)
    setModel(id === settings?.assist.cli ? (settings?.assist.model ?? '') : '')
    setEffort('')
  }
  const [turns, setTurns] = useState<Turn[]>([])
  const [askUser, setAskUser] = useNewAskUser()
  const [text, setText] = useState('')
  const [job, setJob] = useState<AssistJob | null>(null)
  const [applying, setApplying] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  // Agent 和工作流各用整句文案，英文语序和中文不同，不拼接
  const L =
    kind === 'command'
      ? {
          create: t('用 AI 创建命令'),
          desc: t('本机 Agent 写出命令文件，在右侧预览，确认后所有 Agent 都能用'),
          intro: t('描述你想要的命令：打「/名字」时要让 Agent 做什么、要不要参数。可以从下面的例子开始：'),
          placeholder: t('描述你想要的命令'),
          empty: t('生成的命令会显示在这里'),
          button: t('创建命令'),
        }
      : kind === 'skill'
        ? {
            create: t('用 AI 创建 Skill'),
            desc: t('本机 Agent 写出 SKILL.md，在右侧预览，确认再应用'),
            intro: t('描述你想要的 Skill，越具体越好。可以从下面的例子开始：'),
            placeholder: t('描述你想要的 Skill'),
            empty: t('生成的 Skill 会显示在这里'),
            button: t('创建 Skill'),
          }
        : kind === 'mcp'
          ? {
              create: t('用 AI 排查 MCP 工具'),
              desc: t('本机 Agent 检查环境、找出连不上的原因，在右侧预览修复后的配置，确认再应用'),
              intro: t('说说遇到的问题，或者直接让它排查。'),
              placeholder: t('补充你知道的情况'),
              empty: t('修复后的配置会显示在这里'),
              button: t('应用修复'),
            }
          : kind === 'agent'
            ? {
                create: t('用 AI 创建角色'),
                desc: t('本机 Agent 按固定格式生成角色，校验通过后在右侧预览，确认再应用'),
                intro: t('描述你想要的角色，越具体越好。可以从下面的例子开始：'),
                placeholder: t('描述你想要的角色'),
                empty: t('生成的角色会显示在这里'),
                button: t('创建角色'),
              }
            : kind === 'params'
              ? {
                  create: t('AI 配置参数'),
                  desc: t('在项目目录里只读分析代码，按项目情况给出参数值；确认后才填进表单'),
                  intro: t('说说你的要求，或者直接让它按项目情况填。'),
                  placeholder: t('补充要求，例如「端到端测试在 WSL 里跑」'),
                  empty: t('参数值会显示在这里'),
                  button: t('填进表单'),
                }
              : kind === 'lessons'
                ? {
                    create: t('提取全局教训'),
                    desc: t('从这个项目的教训里挑出换个项目也适用的，合进全局教训；逐条确认后才写入'),
                    intro: t('直接让它提取，或者说说你的要求。'),
                    placeholder: t('补充要求，例如「只看角色自己记的」'),
                    empty: t('提取出的全局教训会显示在这里'),
                    button: t('确认写入全局教训'),
                  }
                : kind === 'project'
                  ? {
                      create: t('AI 初始化项目'),
                      desc: t(
                        '在项目目录里写好 AGENTS.md 和文档框架，评估工作流、推荐项目设置；推荐项回到项目设置里逐项或整体应用',
                      ),
                      intro: t('直接让它初始化，或者说说你的要求。'),
                      placeholder: t('补充要求，例如「文档放在 Docs/ 下」'),
                      empty: t('初始化的结果会显示在这里'),
                      button: t('查看推荐并应用'),
                    }
                  : kind === 'teststeps'
                    ? {
                        create: t('AI 生成测试步骤'),
                        desc: t('在项目目录里只读分析，按实际的脚本和命令生成测试步骤；确认后才填进表单'),
                        intro: t('说说你的要求，或者直接让它按项目情况生成。'),
                        placeholder: t('补充要求，例如「编译要放在单元测试前面」'),
                        empty: t('测试步骤会显示在这里'),
                        button: t('填进表单'),
                      }
                    : {
                        create: t('用 AI 创建工作流'),
                        desc: t('本机 Agent 按固定格式生成工作流，校验通过后在右侧预览，确认再应用'),
                        intro: t('描述你想要的工作流，越具体越好。可以从下面的例子开始：'),
                        placeholder: t('描述你想要的工作流'),
                        empty: t('生成的工作流会显示在这里'),
                        button: t('创建工作流'),
                      }

  useEffect(() => {
    if (!open) return
    setTurns([])
    setText('')
    setJob(null)
    // 每次打开都是新对话：「提问」开关回到设置里的默认值
    setAskUser(askUserDefault())
    // 没单独指定时用设置里的默认 CLI
    const pref = settings?.assist.cli || (settings ? defaultCli(settings) : '')
    pickCli(usable.find((c) => c.id === pref)?.id ?? usable[0]?.id ?? pref ?? CLIS[0].id)
    // 打开时按当时的设置选一次 CLI，之后用户自己选的不被覆盖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 打开后自动发第一句；等选好 CLI 再发
  const started = useRef(false)
  useEffect(() => {
    if (!open) started.current = false
    else if (autoStart && cli && !started.current) {
      started.current = true
      void send(autoStart)
    }
    // 只在打开、选好 CLI 时发一次，send 每次渲染都是新的函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cli])

  // 生成中轮询
  useEffect(() => {
    // 只在换了任务或运行状态变化时重新开始轮询
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    if (!job || job.status !== 'running') return
    // 一次请求回来再发下一次；卸载或任务结束后到达的旧响应直接丢掉，不会重复追加或把结束的任务恢复成进行中
    let alive = true
    let t: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const j = await api.assistJob(job.id)
        if (!alive) return
        if (j.status === 'running') {
          setJob(j)
          t = setTimeout(poll, 600)
          return
        }
        alive = false
        setTurns((ts) => [
          ...ts,
          {
            role: 'assistant',
            text: j.text + (j.raw ? `\n\n\`\`\`json\n${j.raw}\n\`\`\`` : ''),
            proposal: j.proposal,
            error: j.error,
            msgs: j.messages,
          },
        ])
        setJob(null)
      } catch (e) {
        if (!alive) return
        alive = false
        toast.error((e as Error).message)
        setJob(null)
      }
    }
    t = setTimeout(poll, 600)
    return () => {
      alive = false
      clearTimeout(t)
    }
    // 依赖写成「是否在运行」：状态从 running 变成别的时停掉轮询
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status === 'running'])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, job?.text, job?.messages?.length, job?.outChars])

  const latest = useMemo(() => [...turns].reverse().find((t) => t.proposal)?.proposal, [turns])
  // 全局教训：每次出了新结果默认全选，用户取消勾选不要的
  const [picked, setPicked] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (latest?.kind === 'lessons') setPicked(new Set(latest.changes.map((_, i) => i)))
  }, [latest])
  const running = !!job
  // 最小化：窗口收成右下角的悬浮按钮，生成照常进行，点按钮再展开
  const [minimized, setMinimized] = useState(false)
  // 左边对话、右边预览之间可以拖：宽度记在本机。两边各至少留 360，预览窄了看不清差异
  const split = useRef<HTMLDivElement>(null)
  const chatPane = usePaneWidth('assist-chat', 540, 360, () => (split.current?.clientWidth ?? 1100) - 360)
  // 最小化期间生成完了：悬浮按钮上提示一下
  const [unseen, setUnseen] = useState(false)
  useEffect(() => {
    if (!open) setMinimized(false)
  }, [open])
  useEffect(() => {
    if (minimized && turns.length) setUnseen(true)
    // 只在有新回复时提示
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length])
  // 关闭就终止：生成中也能关，关掉时停掉还在跑的 CLI
  const jobRef = useRef(job)
  jobRef.current = job
  const doClose = () => {
    if (jobRef.current) {
      void api.stopAssist(jobRef.current.id).catch(() => {})
      // 关掉窗口就停掉这次生成：明确告诉用户已经停了，不留一个看不见的任务在后台跑
      toast.info(t('已停止生成'))
    }
    setJob(null)
    onOpenChange(false)
  }
  // 关闭就是直接关并停止（不再先弹确认）：要留着看进度就点最小化
  const close = () => doClose()
  // 所在页面被关掉（例如换了一个 Agent）时，也不留下没人看的生成
  useEffect(
    () => () => {
      if (jobRef.current) void api.stopAssist(jobRef.current.id).catch(() => {})
    },
    [],
  )

  const send = async (msg = text) => {
    if (!msg.trim() || running) return
    const next: Turn[] = [...turns, { role: 'user', text: msg.trim() }]
    setTurns(next)
    setText('')
    try {
      setJob(
        await api.assist({
          kind,
          targetId: target?.id ?? '',
          subject: { ...(subject ?? {}), ...(paramAgentId ? { agentId: paramAgentId } : {}) },
          cli,
          model,
          effort,
          messages: next.map(({ role, text }) => ({ role, text })),
          askUser,
          projectId: projectId ?? '',
        }),
      )
    } catch (e) {
      setTurns((ts) => [...ts, { role: 'assistant', text: '', error: (e as Error).message }])
    }
  }

  const stop = async () => {
    if (job) await api.stopAssist(job.id).catch(toastError)
  }
  // 生成中说的话：AI 创建一次生成完一份配置，不能中途补充，排队等这一轮结束再发
  const [queue, setQueue] = useState<string[]>([])
  const files = useAttachments()
  const enqueue = () => {
    if (!text.trim()) return
    setQueue((q) => [...q, text.trim()])
    setText('')
  }
  // 正在发出一条（还没拿到生成任务）：别接着发下一条
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    if (running || starting || !queue.length) return
    const [next, ...rest] = queue
    setQueue(rest)
    setStarting(true)
    void send(next).finally(() => setStarting(false))
    // 只在这一轮结束、队列变化时发下一条
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [running, starting, queue])

  const apply = async () => {
    if (!latest) return
    setApplying(true)
    try {
      if (latest.kind === 'lessons') {
        await onApply?.({ ...latest, changes: latest.changes.filter((_, i) => picked.has(i)) })
        onOpenChange(false)
        return
      }
      if (
        latest.kind === 'skill' ||
        latest.kind === 'command' ||
        latest.kind === 'mcp' ||
        latest.kind === 'params' ||
        latest.kind === 'teststeps' ||
        latest.kind === 'project'
      ) {
        await onApply?.(latest)
        onOpenChange(false)
        return
      }
      const r = await applyProposal(latest, {
        categories: categories.filter((c) => c.scope !== 'workflow'),
        createCategory: (name) => api.createCategory(name),
        createAgent: (a) => api.createAgent(a),
      })
      if (r.categories.length) setCategories((cs) => [...cs, ...r.categories])
      if (r.created.length) setAgents((as) => [...as, ...r.created])
      if (r.agent) {
        const a = target ? await api.updateAgent(target.id, r.agent) : await api.createAgent(r.agent)
        setAgents((as) => (target ? as.map((x) => (x.id === a.id ? a : x)) : [...as, a]))
        toast.success(target ? t('已更新「{name}」', { name: a.name }) : t('已创建「{name}」', { name: a.name }))
        onApplied?.({ agent: a })
      } else if (r.workflow) {
        const w = target ? await api.updateWorkflow(target.id, r.workflow) : await api.createWorkflow(r.workflow)
        setWorkflows((ws) => (target ? ws.map((x) => (x.id === w.id ? w : x)) : [...ws, w]))
        toast.success(
          (target ? t('已更新「{name}」', { name: w.name }) : t('已创建「{name}」', { name: w.name })) +
            (r.created.length ? t('，并新建了 {n} 个角色', { n: r.created.length }) : ''),
        )
        onApplied?.({ workflow: w })
      }
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      {open && minimized && (
        <MinimizedChat
          id="assist"
          label={shown ? (kind === 'mcp' ? L.create : t('用 AI 优化「{name}」', { name: shown })) : L.create}
          state={running ? 'running' : unseen ? 'done' : 'idle'}
          unseen={unseen}
          onExpand={() => {
            setMinimized(false)
            setUnseen(false)
          }}
          onClose={() => close()}
        />
      )}
      <Modal
        open={open && !minimized}
        // 按 Esc 或点窗口外面：生成中先收起来，免得误触终止；没在生成就直接关
        onOpenChange={(o) => {
          if (o) return
          if (running) setMinimized(true)
          else close()
        }}
        // 标题跟着优化对象变，D.Title 和说明放在下面自己画的标题栏里
        title={null}
        // 不铺满屏幕（用户嫌太宽）：用 xl 档 1100，和差异、文件查看器一样宽；左边对话 540、右边预览 560，
        // 整篇 SKILL.md、角色设定都放得下。高度固定，生成过程中窗口不跟着内容一会儿高一会儿矮
        size="xl"
        bare
        closeOnOutside
        className="h-[min(860px,calc(100dvh-3.75rem))]"
      >
        <ModalHeader
          icon={shown ? Wand2 : Sparkles}
          title={shown ? (kind === 'mcp' ? L.create : t('用 AI 优化「{name}」', { name: shown })) : L.create}
          meta={<D.Description className="hidden truncate md:inline">{L.desc}</D.Description>}
          close={false}
          actions={
            <>
              <ModalButton icon={Minus} label={t('最小化')} onClick={() => setMinimized(true)} />
              <ModalButton
                icon={X}
                label={running ? t('关闭并终止生成') : t('关闭')}
                className="[&>svg]:h-[1.125rem] [&>svg]:w-[1.125rem]"
                onClick={close}
              />
            </>
          }
        />

        <div ref={split} className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* 对话：窄屏上下排，宽屏左右排、宽度跟着拖动条 */}
          <section
            style={{ '--chat-w': `${chatPane.width}px` } as React.CSSProperties}
            className={cn(
              'relative flex min-h-0 flex-1 flex-col border-b md:w-(--chat-w) md:flex-none md:border-r md:border-b-0',
              !chatPane.dragging && 'transition-[width] duration-(--dur-fast)',
            )}
          >
            <ResizeHandle
              pane={chatPane}
              side="right"
              label={t('拖动调整对话和预览的宽度')}
              className="hidden md:block"
            />
            <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2.5">
              <span className="mr-1 text-xs text-subtle">{t('使用')}</span>
              <ChipGroup
                label={t('使用哪个 Agent')}
                size="sm"
                value={cli}
                onChange={pickCli}
                options={orderClis(
                  CLIS,
                  settings?.cliOrder ?? [],
                  (c) => !!clis.find((x) => x.id === c.id)?.enabled,
                ).flatMap((c) => {
                  const st = clis.find((x) => x.id === c.id)
                  const ok = !!st?.installed && st.enabled
                  // 停用或没安装的不显示；正选着的照常显示（不能再点，悬停说明原因）
                  if (st && !ok && cli !== c.id) return []
                  return [
                    {
                      id: c.id,
                      label: c.name,
                      disabled: running || !ok,
                      title: ok ? st?.version : t('未安装或已停用'),
                      icon: <span className="h-1.5 w-1.5 rounded-full" style={{ background: cliColor(c.id) }} />,
                    },
                  ]
                })}
              />
            </div>
            <div
              ref={scroller}
              className="flex min-h-[200px] flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-4 py-4"
            >
              {turns.length === 0 && !running && (
                <div className="flex flex-col gap-2">
                  <p className="text-body text-muted">
                    {shown
                      ? kind === 'skill'
                        ? t('说说想怎么改，例如「步骤再具体一些」「description 写清楚什么时候用」。')
                        : kind === 'command'
                          ? t('说说想怎么改，例如「参数为空时审查全部改动」「做完列出改了哪些文件」。')
                          : kind === 'mcp'
                            ? L.intro
                            : t('说说想怎么改，例如「角色设定再具体一些」「加一个代码审查阶段」。')
                      : L.intro}
                  </p>
                  {!shown &&
                    EXAMPLES[kind].map((e) => (
                      <button
                        key={e}
                        onClick={() => send(e)}
                        className="cursor-pointer rounded-lg bg-card px-3 py-2 text-left text-body text-muted shadow-card transition-colors hover:bg-sel/60 hover:text-fg"
                      >
                        {e}
                      </button>
                    ))}
                </div>
              )}
              {turns.map((turn, i) =>
                turn.role === 'user' ? (
                  <UserMessage key={i} size="sm" text={turn.text} />
                ) : (
                  <div key={i} className="flex flex-col gap-2 text-body leading-relaxed">
                    {turn.msgs?.length ? (
                      <ChatReply msgs={turn.msgs} teamNames={teamNames} author={author} />
                    ) : (
                      turn.text && <p className="whitespace-pre-wrap">{turn.text.split('```')[0].trim()}</p>
                    )}
                    {turn.proposal && (
                      <span className="flex items-center gap-1.5 text-xs text-success">
                        <Check className="h-3.5 w-3.5" />
                        {t('格式校验通过，右侧是预览')}
                      </span>
                    )}
                    {turn.error && (
                      <span className="flex items-start gap-1.5 text-xs text-danger whitespace-pre-wrap">
                        <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                        {turn.error}
                      </span>
                    )}
                  </div>
                ),
              )}
              {job && (
                <JobProgress
                  job={job}
                  cliName={CLIS.find((c) => c.id === cli)?.name ?? cli}
                  author={author}
                  teamNames={teamNames}
                />
              )}
            </div>
            <div className="p-3">
              {job && <ScopeRequests scope={`assist:${job.id}`} active={running} />}
              {queue.length > 0 && (
                <p className="mb-2 truncate rounded-lg bg-field px-3 py-1.5 text-footnote text-muted">
                  {t('排队中，这一轮结束后发送：{text}', { text: queue.join(' / ') })}
                </p>
              )}
              <ChatComposer
                size="sm"
                value={text}
                onChange={setText}
                onSubmit={() => (running ? enqueue() : void send())}
                files={files}
                attach={false}
                running={running}
                onStop={() => void stop()}
                onQueue={enqueue}
                canSend={!!text.trim()}
                label={t('描述')}
                placeholder={latest ? t('继续说要改的地方') : L.placeholder}
                tools={
                  <>
                    <AskToggle
                      value={askUser}
                      onChange={(v) => {
                        setAskUser(v)
                        if (job) void api.setAskUser(`assist:${job.id}`, v).catch(toastError)
                      }}
                    />
                    {settings && cliDef && (
                      <RunPicker
                        def={cliDef}
                        settings={settings}
                        model={model}
                        effort={effort}
                        onModel={setModel}
                        onEffort={setEffort}
                        disabled={running}
                      />
                    )}
                  </>
                }
              />
            </div>
          </section>

          {/* 预览 */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
            <div className="flex-1 overflow-y-auto p-5">
              {latest ? (
                latest.kind === 'skill' ? (
                  <SkillPreview name={latest.name} content={latest.content} before={subject?.content} />
                ) : latest.kind === 'command' ? (
                  <SkillPreview name={latest.name} content={latest.content} before={subject?.content} command />
                ) : latest.kind === 'mcp' ? (
                  <McpPreview
                    server={latest.server}
                    before={subject?.server ? (JSON.parse(subject.server) as McpServer) : undefined}
                  />
                ) : latest.kind === 'params' ? (
                  <ParamPreview values={latest.values} spec={paramSpec ?? []} />
                ) : latest.kind === 'teststeps' ? (
                  <TestStepsPreview steps={latest.steps} />
                ) : latest.kind === 'project' ? (
                  <ProjectPreview p={latest} />
                ) : latest.kind === 'lessons' ? (
                  <LessonChangesPreview
                    changes={latest.changes}
                    globals={globalLessons ?? []}
                    picked={picked}
                    onPick={(i, on) =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (on) n.add(i)
                        else n.delete(i)
                        return n
                      })
                    }
                  />
                ) : latest.kind === 'agent' ? (
                  <AgentPreview
                    agent={latest.agent}
                    before={target as Agent | undefined}
                    newCategory={latest.newCategory}
                  />
                ) : (
                  <WorkflowPreview p={latest} />
                )
              ) : (
                <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-subtle">
                  <Sparkles className="h-6 w-6" />
                  <p className="text-body">{L.empty}</p>
                </div>
              )}
            </div>
            <footer className="flex items-center gap-2 border-t px-5 py-3">
              <span className="text-xs text-subtle">
                {latest
                  ? latest.kind === 'lessons'
                    ? t('已选 {n} 条，可以继续对话让它改', { n: picked.size })
                    : latest.kind === 'project'
                      ? t('文件已经写好，推荐的设置回到项目设置里应用')
                      : shown
                        ? t('应用后会覆盖当前内容')
                        : t('可以继续对话修改，满意后再创建')
                  : ''}
              </span>
              <Button
                className="ml-auto"
                disabled={!latest || running || applying || (latest.kind === 'lessons' && !picked.size)}
                onClick={apply}
              >
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {shown && kind !== 'mcp' && kind !== 'project' ? t('应用修改') : L.button}
              </Button>
            </footer>
          </section>
        </div>
      </Modal>
    </>
  )
}
