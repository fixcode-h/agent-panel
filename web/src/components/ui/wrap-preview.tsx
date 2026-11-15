import type { ReactNode } from 'react'
import {
  AppWindow,
  Download,
  ExternalLink,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Package,
  Play,
  Plug,
  Puzzle,
  Scale,
  Server,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { WrapInfo } from '@shared/api-contract/plugin-wrap'
import type { WrapCandidate, WrapKind, WrapStep } from '@shared/plugins/wrap/recipe'
import { cn } from '@/lib/utils'
import { Badge } from './badge'
import { Checkbox } from './checkbox'
import { Segmented } from './segmented'

/**
 * 从 GitHub 链接包装插件的预览（ADR 0068，效果图 5）：头部（名字、仓库、固定的提交、许可、来源分级）、
 * 识别出的内容（能勾选）、装上后会做什么、生效范围、更新时多出来的权限。安全扫描由调用方放在 children 里。
 * 纯展示，数据都从 props 来：设置 →「组件」里的样例和插件页的弹窗用同一个
 */

const KIND: Record<WrapKind, { icon: LucideIcon; label: () => string }> = {
  skills: { icon: Sparkles, label: () => t('技能') },
  'claude-plugin': { icon: Puzzle, label: () => t('Claude Code 插件') },
  mcp: { icon: Plug, label: () => t('MCP 服务') },
  cli: { icon: SquareTerminal, label: () => t('命令行') },
  'web-app': { icon: AppWindow, label: () => t('网页') },
}

const STEP: Record<WrapStep['icon'], LucideIcon> = {
  copy: Folder,
  env: SlidersHorizontal,
  path: SquareTerminal,
  mcp: Plug,
  install: Download,
  run: Play,
  web: Globe,
  service: Server,
}

/** 标题右上角的来源分级（设计稿 7.2 第 5 条） */
function TrustBadge({ info }: { info: Pick<WrapInfo, 'trust' | 'origin'> }) {
  if (info.trust === 'official' || info.trust === 'community')
    return <Badge tone="accent">{info.trust === 'official' ? t('官方配方') : t('社区配方 · 插件市场审核过')}</Badge>
  return (
    <Badge tone="warning">
      <TriangleAlert className="h-3 w-3" />
      {info.origin === 'ai' ? t('AI 写的配方 · 未经市场审核') : t('任意链接 · 未经市场审核')}
    </Badge>
  )
}

function CandidateRow({
  c,
  on,
  editable,
  onToggle,
}: {
  c: WrapCandidate
  on: boolean
  editable: boolean
  onToggle?: (on: boolean) => void
}) {
  const k = KIND[c.kind]
  return (
    <div
      className={cn('flex items-start gap-3 rounded-lg bg-field p-3', c.skip && !on && 'opacity-70')}
      data-wrap-candidate={c.key}
    >
      <Checkbox
        checked={on}
        onChange={(v) => onToggle?.(v)}
        disabled={!editable || !onToggle}
        ariaLabel={t('包装 {kind} {path}', { kind: k.label(), path: c.path })}
        className="mt-1"
      />
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-sel/70 text-muted">
        <k.icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-body font-medium text-fg">{k.label()}</span>
          <span className="truncate font-mono text-xs text-subtle">{c.path}</span>
          {c.skip ? <Badge>{t('跳过：{why}', { why: c.skip })}</Badge> : c.tag && <Badge>{c.tag}</Badge>}
        </div>
        <p className="text-body leading-relaxed text-muted">{c.reason}</p>
      </div>
    </div>
  )
}

const day = (iso: string) => (iso ? iso.slice(5, 10) : '')

export function WrapPreviewBody({
  info,
  name,
  version,
  description,
  icon: Icon = Package,
  onToggle,
  onActivation,
  busy,
  children,
}: {
  info: WrapInfo
  name?: string
  version?: string
  description?: string
  icon?: LucideIcon
  /** 改勾选（只有识别器出的配方能改） */
  onToggle?: (key: string, on: boolean) => void
  onActivation?: (a: 'global' | 'project') => void
  /** 正在按新的勾选重新生成 */
  busy?: boolean
  /** 安全扫描 */
  children?: ReactNode
}) {
  const repoUrl = `https://github.com/${info.repo}`
  return (
    <div className={cn('flex flex-col gap-4', busy && 'pointer-events-none opacity-70')} data-wrap-preview={info.repo}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-prose font-semibold">
              {name ?? info.repo.split('/')[1]}{' '}
              {version && <span className="text-body font-normal text-subtle">v{version}</span>}
            </p>
            <TrustBadge info={info} />
          </div>
          {(description || info.description) && (
            <p className="text-body leading-relaxed text-muted">{description || info.description}</p>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle">
            <span className="inline-flex items-center gap-1 font-mono">
              <GitBranch className="h-3 w-3" />
              {info.repo} · {info.ref}
            </span>
            {info.commit && (
              <span className="inline-flex items-center gap-1 font-mono">
                <GitCommitHorizontal className="h-3 w-3" />
                {t('固定在 {sha}', { sha: info.commit.slice(0, 7) })}
                {info.date && ` (${day(info.date)})`}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Scale className="h-3 w-3" />
              {info.license || t('没有许可证：作者没给授权，只建议自己用')}
            </span>
          </p>
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            {t('在网页里看仓库')}
          </a>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2 text-xs text-subtle">
          <span>{t('识别出的内容')}</span>
          <span className="truncate font-mono">
            {info.origin === 'recipe' && info.recipeFile
              ? t('按配方 {file}', { file: info.recipeFile })
              : info.origin === 'ai'
                ? t('按 AI 写的配方')
                : t('自动识别，可以改勾选')}
          </span>
        </div>
        {info.candidates.length ? (
          info.candidates.map((c) => (
            <CandidateRow
              key={c.key}
              c={c}
              on={info.picks.includes(c.key)}
              editable={info.editable}
              onToggle={onToggle && ((on) => onToggle(c.key, on))}
            />
          ))
        ) : (
          <p className="rounded-lg bg-field p-3 text-body text-subtle">{t('没认出能装进面板的东西。')}</p>
        )}
      </section>

      {!!info.steps.length && (
        <section className="flex flex-col gap-1.5">
          <span className="text-xs text-subtle">{t('装上后会做什么')}</span>
          {info.steps.map((s, i) => {
            const S = STEP[s.icon]
            return (
              <p
                key={i}
                className={cn('flex items-start gap-2 text-body', s.advanced ? 'text-warning' : 'text-fg')}
                data-wrap-step={s.icon}
              >
                <S className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                <span>{s.text}</span>
              </p>
            )
          })}
        </section>
      )}

      {!info.unrecognized && (
        <section className="flex flex-col gap-1.5">
          <span className="text-xs text-subtle">{t('生效范围')}</span>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={info.activation}
              label={t('生效范围')}
              onChange={(v) => onActivation?.(v)}
              options={[
                { id: 'global', label: t('全局') },
                { id: 'project', label: t('按项目') },
              ]}
            />
            <span className="text-xs text-subtle">
              {info.suggested === 'project'
                ? t('带 MCP、托管进程或命令行，建议只在打开了它的项目里生效')
                : t('只有技能和环境变量，不起进程、不挂 MCP，全局也只是多一个技能')}
            </span>
          </div>
        </section>
      )}

      {info.update && (
        <section className="flex flex-col gap-1 rounded-lg bg-field p-3 text-body" data-wrap-update>
          <span className="text-xs text-subtle">{t('和装着的 v{v} 比', { v: info.update.from })}</span>
          {info.update.permChanges.length ? (
            info.update.permChanges.map((p) => (
              <span key={p} className="text-warning">
                {t('新增权限：{what}', { what: p })}
              </span>
            ))
          ) : (
            <span className="text-muted">{t('权限没有变化')}</span>
          )}
          <span className="text-muted">
            {info.update.newFindings.length
              ? t('新增 {n} 处扫描发现（列在下面）', { n: info.update.newFindings.length })
              : t('没有新增扫描发现')}
          </span>
        </section>
      )}

      {children}
    </div>
  )
}
