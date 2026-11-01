import type { ContextBreakdown, ContextKey } from '@shared/context-breakdown'
import { t } from '@shared/i18n'
import { fmtTokens } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { SessionDisclosure, SessionDisclosureItem } from './SessionCard'

/**
 * 各块的名字、色块和悬停说明（照 Claude Code 的 /context）：
 * 消息、系统工具、MCP 工具三种主色，其余用灰阶由深到浅，空闲只画轮廓
 */
const META: Record<ContextKey, { label: () => string; swatch: string; tip: () => string }> = {
  messages: {
    label: () => t('消息'),
    swatch: 'bg-ctx-messages',
    tip: () => t('对话内容、工具调用和结果'),
  },
  systemTools: {
    label: () => t('系统工具'),
    swatch: 'bg-ctx-tools',
    tip: () => t('Agent 自带的读写文件、执行命令等工具的定义'),
  },
  mcpTools: {
    label: () => t('MCP 工具'),
    swatch: 'bg-ctx-mcp',
    tip: () => t('MCP 服务提供的工具（含面板交给 Agent 的派子任务、提问、计划……）的定义'),
  },
  mcpInstructions: {
    label: () => t('MCP 服务说明'),
    swatch: 'bg-ctx-mcp/55',
    tip: () => t('MCP 服务连上时给的使用说明，Agent 放进系统提示词'),
  },
  systemPrompt: {
    label: () => t('系统提示词'),
    swatch: 'bg-muted',
    tip: () => t('Agent 自己的系统提示词加上面板追加的角色设定'),
  },
  agents: {
    label: () => t('自定义 Agent'),
    swatch: 'bg-muted/90',
    tip: () => t('能派出去的子 Agent 的名字和用途说明'),
  },
  skills: {
    label: () => t('Skill'),
    swatch: 'bg-muted/80',
    tip: () => t('可用 Skill 的名字和描述：正文用到时才读'),
  },
  memory: {
    label: () => t('记忆文件'),
    swatch: 'bg-muted/65',
    tip: () => t('Agent 启动时读的说明文件（AGENTS.md、CLAUDE.md 等）'),
  },
  since: {
    label: () => t('上次细分以来'),
    swatch: 'bg-ctx-messages/45',
    tip: () => t('Agent 上次报细分之后新增的内容（多是这一轮的消息）：这一轮结束时再细分'),
  },
  buffer: {
    label: () => t('自动压缩余量'),
    swatch: 'bg-subtle/60',
    tip: () => t('占用到这里之前会自动压缩：留给压缩本身和模型输出'),
  },
  free: { label: () => t('空闲空间'), swatch: 'bg-line', tip: () => t('还能用的上下文') },
  mcpDeferred: {
    label: () => t('MCP 工具（按需）'),
    swatch: 'bg-subtle/60',
    tip: () => t('用到时才加载用法的 MCP 工具：不占上下文'),
  },
  systemDeferred: {
    label: () => t('系统工具（按需）'),
    swatch: 'bg-subtle/60',
    tip: () => t('Agent 自带、用到时才加载用法的工具：不占上下文'),
  },
}

const pct = (n: number, of: number) => {
  if (!of) return '0%'
  const p = (n / of) * 100
  return `${p > 0 && p < 0.1 ? '<0.1' : p.toFixed(1)}%`
}

/** 总占用和分色条：「已使用 41%」「413.2k / 1M」，下面一根按块分色的细条（空闲不画） */
export function ContextHead({ data, caption }: { data: ContextBreakdown; caption?: string }) {
  const p = data.percent
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className={cn('text-prose font-semibold tabular-nums', p > 80 ? 'text-warning' : 'text-fg')}>
          {t('已使用 {n}%', { n: p < 10 ? p.toFixed(1) : Math.round(p) })}
        </span>
        <span className="ml-auto font-mono text-xs text-muted tabular-nums" title={caption}>
          {fmtTokens(data.used)} / {fmtTokens(data.window)}
        </span>
      </div>
      <div
        role="img"
        aria-label={t('上下文已用 {n}%', { n: Math.round(p) })}
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-line"
      >
        {data.rows
          .filter((r) => r.key !== 'free' && r.tokens > 0)
          .map((r) => (
            <span
              key={r.key}
              className={cn('h-full shrink-0', META[r.key].swatch)}
              style={{ width: `${(r.tokens / data.window) * 100}%` }}
            />
          ))}
      </div>
    </div>
  )
}

/** 一块一行：色块、名字（虚线下划线的悬停有说明）、token 数、占窗口的比例；按需取用的不占窗口，比例写「—」 */
function ContextLegendRow({
  k,
  tokens,
  of,
  estimated,
}: {
  k: ContextKey
  tokens: number
  of?: number
  estimated?: boolean
}) {
  const m = META[k]
  const tip = estimated ? `${m.tip()}\n${t('估计值：Agent 没有报这一块，按版本的量级估的')}` : m.tip()
  return (
    <li className="flex h-6 items-center gap-2.5 text-body">
      <span
        className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', k === 'free' ? 'border border-line-strong' : m.swatch)}
      />
      <span
        className="min-w-0 flex-1 truncate text-muted underline decoration-line-strong decoration-dotted underline-offset-4"
        title={tip}
      >
        {m.label()}
      </span>
      <span className="w-14 shrink-0 text-right font-mono text-xs text-muted tabular-nums">
        {estimated ? '~' : ''}
        {fmtTokens(tokens)}
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-xs font-medium text-fg tabular-nums">
        {of === undefined ? '—' : pct(tokens, of)}
      </span>
    </li>
  )
}

/** 细分：按窗口画的各块，按需取用的工具另起一组，最后是可展开的 MCP 工具、记忆文件、自定义 Agent 和 Skill 列表 */
export function ContextLegend({ data }: { data: ContextBreakdown }) {
  return (
    <div className="flex flex-col gap-2.5">
      <ul className="flex flex-col">
        {data.rows.map((r) => (
          <ContextLegendRow key={r.key} k={r.key} tokens={r.tokens} of={data.window} estimated={r.estimated} />
        ))}
      </ul>
      {data.deferred.length > 0 && (
        <ul className="flex flex-col">
          {data.deferred.map((r) => (
            <ContextLegendRow key={r.key} k={r.key} tokens={r.tokens} />
          ))}
        </ul>
      )}
      <div className="flex flex-col">
        <SessionDisclosure label={t('MCP 工具')} count={data.tools.length + data.deferredTools.length}>
          {[...data.tools, ...data.deferredTools].map((x) => (
            <SessionDisclosureItem
              key={x.name}
              name={x.name}
              value={data.deferredTools.includes(x) ? t('按需') : fmtTokens(x.tokens)}
            />
          ))}
        </SessionDisclosure>
        <SessionDisclosure label={t('记忆文件')} count={data.memory.length}>
          {data.memory.map((x) => (
            <SessionDisclosureItem key={x.path} name={x.path} value={fmtTokens(x.tokens)} />
          ))}
        </SessionDisclosure>
        {data.agents.length > 0 && (
          <SessionDisclosure label={t('自定义 Agent')} count={data.agents.length}>
            {data.agents.map((x) => (
              <SessionDisclosureItem key={x.name} name={x.name} value={fmtTokens(x.tokens)} />
            ))}
          </SessionDisclosure>
        )}
        <SessionDisclosure label={t('Skill')} count={data.skills.length}>
          {data.skills.map((x) => (
            <SessionDisclosureItem key={x.name} name={x.name} value={fmtTokens(x.tokens)} />
          ))}
        </SessionDisclosure>
      </div>
    </div>
  )
}
