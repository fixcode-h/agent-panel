import { Globe, Pencil, RefreshCw, Sparkles, Terminal, Trash2, Wand2, Wrench } from 'lucide-react'
import type { ProjectSkill } from '@shared/projects/skills'
import type { ProjectMcpDetected } from '@shared/projects/mcp'
import { CLIS } from '@shared/clis'
import { t } from '@shared/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { CapabilityBlockHeader, CapabilityItem, CapabilityItemList } from '@/components/ui/capability-item'
import { ScanBadge, ScanFindings } from '@/components/ui/scan-findings'
import { configScanApi } from '@/lib/api-config-scan'
import type { OwnMcp } from './use-own-mcp'
import type { OwnSkills } from './use-own-skills'

const cliNames = (ids: string[]) => ids.map((id) => CLIS.find((c) => c.id === id)?.name ?? id).join(t('、'))

/**
 * 「技能与 MCP」页的「项目自己的」：项目目录里的技能和识别到的 MCP 配置，跟着仓库走。
 * 原来分在「项目技能」「项目 MCP」两个页签里的新建、编辑、AI 修复 / 优化、导入、安全扫描都在这一块的行上，
 * 行的样子和「从全局继承」一样用能力条目（CapabilityItem），上面只留一排「全部 / 技能 / MCP」筛选（用户 2026-11-17 定）。
 * skills / mcp 是筛选后要显示的条目，计数用全部的
 */
export function OwnBlock({
  s,
  m,
  skills,
  mcp,
  total,
}: {
  s: OwnSkills
  m: OwnMcp
  skills: ProjectSkill[]
  mcp: ProjectMcpDetected[]
  total: number | undefined
}) {
  const error = s.error || m.error
  const loading = s.loading || m.loading
  const repos = s.view?.repos ?? []
  return (
    <section className="flex flex-col gap-3">
      <CapabilityBlockHeader
        title={t('项目自己的')}
        meta={total === undefined ? t('正在读取…') : t('{n} 项 · 在项目目录里', { n: total })}
        action={
          <>
            {m.todo.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => m.askImport(m.todo.map((d) => ({ file: d.file, name: d.name })))}
              >
                {t('全部导入 MCP（{n}）', { n: m.todo.length })}
              </Button>
            )}
            <IconButton
              icon={Wand2}
              size="sm"
              label={t('用 AI 排查项目的 MCP 配置')}
              onClick={() => void m.diagnose()}
            />
            <IconButton
              icon={RefreshCw}
              size="sm"
              label={t('重新识别')}
              className={loading ? '[&_svg]:animate-spin' : undefined}
              disabled={loading}
              onClick={() => {
                void s.load()
                m.load()
              }}
            />
          </>
        }
      />
      {error && <p className="text-footnote break-all text-warning">{t('读取失败：{error}', { error })}</p>}
      {total !== undefined &&
        (skills.length || mcp.length ? (
          <CapabilityItemList footer={<Where repos={repos} />}>
            {skills.map((x) => (
              <SkillRow key={x.dir} x={x} s={s} />
            ))}
            {mcp.map((d) => (
              <McpRow key={`${d.file}#${d.name}`} d={d} m={m} />
            ))}
          </CapabilityItemList>
        ) : (
          <EmptyPanel size="md" className="flex flex-col items-center gap-1.5">
            <span>{total ? t('没有符合筛选的条目。') : t('项目目录里还没有技能和 MCP 配置。')}</span>
            {!total && <Where repos={repos} />}
          </EmptyPanel>
        ))}
      {!!m.data?.errors.length && (
        <ul className="flex flex-col gap-1 rounded-lg bg-warning/10 px-3 py-2 text-footnote">
          {m.data.errors.map((e) => (
            <li key={e.file} className="flex gap-2">
              <span className="shrink-0 font-mono">{e.file}</span>
              <span className="min-w-0 flex-1 text-muted">{e.error}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 列表底下一行：项目技能放在哪些目录、认哪些 MCP 配置文件，空的时候也知道往哪放 */
function Where({ repos }: { repos: { dir: string; exists: boolean }[] }) {
  return (
    <div className="flex flex-col gap-0.5 text-caption text-subtle">
      {repos.length > 0 && (
        <p>
          {t('技能目录：')}
          {repos.map((r, i) => (
            <span key={r.dir} className="font-mono">
              {i > 0 && t('、')}
              {r.dir}
              {!r.exists && <span className="text-subtle/70">{t('（还没有）')}</span>}
            </span>
          ))}
        </p>
      )}
      <p>{t('MCP 配置：.mcp.json、.claude/settings*.json、.cursor/mcp.json、.vscode/mcp.json、.codex/config.toml')}</p>
    </div>
  )
}

function SkillRow({ x, s }: { x: ProjectSkill; s: OwnSkills }) {
  return (
    <div>
      <CapabilityItem
        icon={Sparkles}
        name={x.name}
        kind={t('技能')}
        description={x.description || t('没写 description：Agent 不知道什么时候该用它')}
        where={x.source}
        whereNote={x.clis.length ? t('{clis} 能读到', { clis: cliNames(x.clis) }) : ''}
        trailing={
          <>
            {x.scan && <ScanBadge summary={x.scan} />}
            {x.issues.length > 0 && (
              <Badge tone="warning" title={x.issues.join('\n')}>
                {t('{n} 个问题', { n: x.issues.length })}
              </Badge>
            )}
            {x.issues.length > 0 && (
              <IconButton
                icon={Wrench}
                size="sm"
                label={t('把 SKILL.md 和问题一起交给 AI 排查并修好')}
                onClick={() => s.fix(x)}
              />
            )}
            <IconButton
              icon={Wand2}
              size="sm"
              label={t('让 AI 改写 SKILL.md：说明和触发条件写清楚，看完再决定用不用')}
              onClick={() => void s.optimize(x)}
            />
            <IconButton
              icon={Pencil}
              size="sm"
              label={t('编辑 {name}', { name: x.name })}
              onClick={() => void s.open(x)}
            />
            <IconButton
              icon={Trash2}
              size="sm"
              label={t('删除 {name}', { name: x.name })}
              onClick={() => s.remove(x)}
            />
          </>
        }
      />
    </div>
  )
}

const STATUS = {
  new: { label: t('还没导入'), tone: 'warning' },
  same: { label: t('已导入'), tone: 'neutral' },
  different: { label: t('和面板里的不同'), tone: 'warning' },
} as const

function McpRow({ d, m }: { d: ProjectMcpDetected; m: OwnMcp }) {
  const entry = d.status === 'new' ? undefined : m.entryOf(d.name)
  const on = d.status === 'same' ? m.onHere(d.name) : undefined
  const global = d.status === 'same' && entry?.activation === 'global'
  return (
    <div className="flex flex-col">
      <CapabilityItem
        icon={d.server.transport === 'http' ? Globe : Terminal}
        name={d.name}
        kind="MCP"
        description={m.summary(d.server) || t('（没有填命令或地址）')}
        where={d.file}
        whereNote={d.source}
        trailing={
          <>
            <ScanBadge findings={d.scan} />
            {global ? (
              // 项目里也有、却装成了全局（老版本导入或别的工具写进各 Agent 全局配置的）：照实标出来，给一键改回按项目
              <Badge tone="warning" title={t('写在各 Agent 的全局配置里，所有项目的对话都会带上')}>
                {t('全局生效')}
              </Badge>
            ) : on === undefined ? (
              <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
            ) : (
              // 导入成按项目生效的：写明本项目开没开，开关在右上角「管理能力」
              <Badge tone={on ? 'accent' : 'neutral'}>{on ? t('本项目已打开') : t('本项目已关闭')}</Badge>
            )}
            {global && d.status === 'same' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => m.askImport([{ file: d.file, name: d.name, toProject: true }])}
              >
                {t('改为只在本项目')}
              </Button>
            )}
            {d.status !== 'same' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => m.askImport([{ file: d.file, name: d.name }])}
                disabled={!d.nameOk}
                title={!d.nameOk ? t('名字里有空格或特殊字符，导入前要在项目文件里改名') : undefined}
              >
                {d.status === 'different' ? t('覆盖已有配置') : t('导入')}
              </Button>
            )}
            <IconButton icon={Wand2} size="sm" label={t('用 AI 排查这条')} onClick={() => m.diagnoseDetected(d)} />
            {entry && <IconButton icon={Pencil} size="sm" label={t('编辑')} onClick={() => m.edit(entry)} />}
            {entry && <IconButton icon={Trash2} size="sm" label={t('删除')} onClick={() => m.remove(entry)} />}
          </>
        }
      />
      {!!d.scan?.length && (
        <ScanFindings
          className="mx-2.5 mb-2"
          findings={d.scan}
          onIgnore={async (f) => {
            await configScanApi.ignore(f, d.scanScope ?? '')
            m.load()
          }}
        />
      )}
    </div>
  )
}
