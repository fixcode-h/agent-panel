import { Lightbulb, Sparkles } from 'lucide-react'
import type { Project } from '@shared/schema'
import { t } from '@shared/i18n'
import { pluginOnFor } from '@shared/projects/capabilities'
import { useNav } from '@/lib/data'
import { usePluginPages, usePlugins } from '@/plugins/registry'
import type { PluginPage } from '@/plugins/sdk'
import { ProjectToolRow, ProjectToolsHeader } from '@/components/ui/project-switcher'
import { useProjectCapsCount } from '@/components/projects/caps/use-caps-data'

type OwnedPage = PluginPage & { plugin: string }

/**
 * 这个项目能用的项目工具页：插件页声明 scope = 'project'（插件接口 9），并且插件在这个项目里生效
 * （清单 activation = project 的要在项目「能力」里打开；旧插件、global 插件对所有项目生效）
 */
export function useProjectPages(project: Project | undefined): OwnedPage[] {
  const pages = usePluginPages()
  const { rows } = usePlugins()
  if (!project) return []
  return pages.filter(
    (p) =>
      p.scope === 'project' &&
      pluginOnFor(project, p.plugin, rows.find((r) => r.manifest.id === p.plugin)?.manifest.activation),
  )
}

/**
 * 侧栏「项目工具」（方案 B，效果图 B 标 ③）：先列这个项目打开了的插件工具页（表格、UE……），
 * 再是「技能与 MCP」「经验与文档」；标题右边的齿轮打开项目设置。
 * 打开工具页时会话侧栏不让开，选中的那一行亮着，地址带上项目
 */
export function ProjectTools({ project }: { project: Project }) {
  const { route, go, openProject } = useNav()
  const pages = useProjectPages(project)
  // 行尾的数字：项目自己的 + 从全局继承的（效果图 B 的「4 + 继承 9」），读不出来时不写
  const caps = useProjectCapsCount(project)
  const here = (page: OwnedPage) =>
    route.page === 'plugin' && route.project === project.id && route.id === page.plugin && route.sub === page.id
  return (
    <section aria-label={t('项目工具')} className="flex flex-col gap-0.5">
      <ProjectToolsHeader onSettings={() => openProject(project.id)} />
      {pages.map((p) => (
        <PluginToolRow
          key={`${p.plugin}/${p.id}`}
          page={p}
          on={here(p)}
          // 插件自己的子位置约定以项目 id 开头（表格 <项目>/<文件>#<表>、UE <项目>/<分区>），从项目那一层打开
          onClick={() => go({ page: 'plugin', project: project.id, id: p.plugin, sub: p.id, msg: project.id })}
        />
      ))}
      {/* 「技能与 MCP」项目页（效果图 B3）：#/projects/<项目>/capabilities，页面本身由项目能力那一块做 */}
      <ProjectToolRow
        icon={Sparkles}
        label={t('技能与 MCP')}
        meta={caps && t('{own} + 继承 {n}', { own: caps.own, n: caps.inherited })}
        on={route.page === 'projects' && route.id === project.id && route.sub === 'capabilities'}
        onClick={() => go({ page: 'projects', id: project.id, sub: 'capabilities' })}
      />
      <ProjectToolRow icon={Lightbulb} label={t('经验与文档')} onClick={() => openProject(project.id, 'experience')} />
    </section>
  )
}

/** 插件工具页的一行：提示点由插件自己的 hook 给（例如 UE 的「本次日志有错误」），和图标栏的格子一样 */
function PluginToolRow({ page, on, onClick }: { page: OwnedPage; on: boolean; onClick: () => void }) {
  const dot = page.useDot?.()
  return <ProjectToolRow icon={page.icon} label={page.label} on={on} dot={dot || undefined} onClick={onClick} />
}
