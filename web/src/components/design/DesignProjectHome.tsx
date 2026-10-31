import { useState } from 'react'
import { ChevronRight, Gamepad2, Globe, Palette, Plus, Settings2 } from 'lucide-react'
import type { DesignMeta, DesignProject, DesignKind } from '@shared/design'
import { timeAgo } from '@shared/task'
import { useData, useNav } from '@/lib/data'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { DesignProjectDialog, type DesignProjectSection } from '@/components/design/DesignProjectDialog'
import { designKind, groupByKind, kindLabel, projectDesigns, projectSummary } from '@/lib/design-projects'
import { t } from '@shared/i18n'

/** 分类的图标：和侧栏用同一套，新增一种界面类型时在这里加一行 */
const KIND_ICON: Record<DesignKind, typeof Gamepad2> = { game: Gamepad2, web: Globe }

/**
 * UI 项目主页：参考 Agent 的项目主页（上面是项目名和概况，下面是这个项目里的东西）。
 * 这里列的是这个项目里的各个界面，点一行进设计器；新建设计先回主页，进了设计器再点。
 */
export function DesignProjectHome({ projectId }: { projectId: string }) {
  const { designProjects, designProjectsLoaded, designs } = useData()
  const { go } = useNav()
  const [editing, setEditing] = useState<DesignProject>()
  const [section, setSection] = useState<DesignProjectSection>('general')
  const project = designProjects.find((p) => p.id === projectId)
  const list = projectDesigns(designs, projectId)
  const groups = groupByKind(list)
  // 有正在跑的设计时每秒刷新，「N 分钟前」跟着走
  const now = useNow(list.some((d) => d.running))

  // 列表还没取回来时不能当成「项目被删了」：直接从地址进主页会先遇到空列表（data.tsx 的初值是 []），
  // 先渲染一个空壳，取回来再判。取失败时 designProjectsLoaded 也置真，不会一直停在这里
  if (!project && !designProjectsLoaded) return <main className="flex-1" data-design-home={projectId} />
  if (!project) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center text-[0.8125rem] text-muted">
        <div>
          <p>{t('这个 UI 项目已经不在了。')}</p>
          <Button variant="ghost" className="mt-3" onClick={() => go({ page: 'design' })}>
            {t('返回')}
          </Button>
        </div>
      </div>
    )
  }
  const summary = projectSummary(list, list[0]?.updatedAt ?? null)
  const openSettings = (s: DesignProjectSection) => {
    setSection(s)
    setEditing(project)
  }
  const newDesign = () => go({ page: 'design', id: 'new', sub: project.id })

  return (
    <main data-design-home={project.id} className="flex min-w-0 flex-1 flex-col md:h-full">
      <div className="flex flex-1 flex-col md:min-h-0 md:overflow-y-auto">
        <header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
          <Button variant="ghost" size="sm" className="ml-auto" onClick={newDesign}>
            <Plus className="h-4 w-4" />
            {t('新建设计')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openSettings('general')}>
            <Settings2 className="h-4 w-4" />
            {t('项目设置')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openSettings('prompts')}>
            <Palette className="h-4 w-4" />
            {t('美术提示词')}
          </Button>
        </header>
        <div className="mx-auto flex w-full max-w-(--content-w) flex-col gap-8 px-4 pt-6 pb-10 md:px-6 md:pt-12">
          <div className="flex flex-col gap-2">
            <h1 className="flex items-center gap-3 font-serif text-[1.75rem] leading-tight font-semibold tracking-tight">
              <Palette className="h-7 w-7 shrink-0 text-accent-text" strokeWidth={2} />
              <span className="min-w-0 truncate">{project.name}</span>
            </h1>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-subtle">
              <span>{t('{n} 个界面', { n: summary.total })}</span>
              {summary.games > 0 && (
                <span className="flex items-center gap-1">
                  <Gamepad2 className="h-3.5 w-3.5" />
                  {t('游戏 UI {n} 个', { n: summary.games })}
                </span>
              )}
              {summary.webs > 0 && (
                <span className="flex items-center gap-1">
                  <Globe className="h-3.5 w-3.5" />
                  {t('网页 UI {n} 个', { n: summary.webs })}
                </span>
              )}
              {summary.lastEdit && <span>{t('最近改动：{time}', { time: timeAgo(summary.lastEdit, now) })}</span>}
              {project.path && <span className="max-w-full truncate font-mono">{project.path}</span>}
            </p>
          </div>

          {groups.length === 0 ? (
            <section className="flex flex-col">
              <h2 className="mb-2 flex px-1 text-xs font-medium text-subtle">
                <span className="flex-1">{t('界面 · {n}', { n: 0 })}</span>
              </h2>
              <EmptyPanel as="div">
                <p>{t('这个项目里还没有界面。')}</p>
                <Button className="mt-3" size="sm" onClick={newDesign}>
                  <Plus className="h-4 w-4" />
                  {t('新建设计')}
                </Button>
              </EmptyPanel>
            </section>
          ) : (
            groups.map((g) => {
              const Icon = KIND_ICON[g.kind]
              return (
                <section key={g.kind} className="flex flex-col">
                  <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-subtle">
                    <Icon className="h-3.5 w-3.5" />
                    <span>{kindLabel(g.kind)}</span>
                    <span className="font-normal">· {g.items.length}</span>
                  </h2>
                  <ul className="flex flex-col divide-y overflow-hidden rounded-xl bg-card shadow-card">
                    {g.items.map((d) => (
                      <DesignRow key={d.id} design={d} now={now} onOpen={() => go({ page: 'design', id: d.id })} />
                    ))}
                  </ul>
                </section>
              )
            })
          )}
        </div>
      </div>
      <DesignProjectDialog
        open={editing !== undefined}
        onOpenChange={(o) => !o && setEditing(undefined)}
        project={editing}
        section={section}
        // 在主页里改完项目不回新建页：留在主页看这个名字下的界面
        onSaved={() => setEditing(undefined)}
      />
    </main>
  )
}

/** 界面列表里的一行：名字、类型、最近改动时间；点开进设计器 */
function DesignRow({ design, now, onOpen }: { design: DesignMeta; now: number; onOpen: () => void }) {
  const kind = designKind(design)
  const Icon = KIND_ICON[kind]
  return (
    <li className="flex items-center transition-colors hover:bg-sel/60">
      <button onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-3 text-left">
        <Icon className="h-4 w-4 shrink-0 text-subtle" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[0.875rem]">{design.title}</span>
          <span className="truncate text-xs text-subtle">
            {kind === 'web' ? t('网页 UI') : t('游戏 UI（UE5 UMG）')}
          </span>
        </span>
        <span className={cn('hidden shrink-0 text-xs sm:block', design.running ? 'text-accent-text' : 'text-subtle')}>
          {design.asking ? t('等你处理') : design.running ? t('执行中') : timeAgo(design.updatedAt, now)}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-subtle" />
      </button>
    </li>
  )
}
