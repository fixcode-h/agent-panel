import { Gamepad2, Lightbulb, Sparkles, Table2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { popoverPanel } from '@/components/ui/menu'
import { MenuSearch } from '@/components/ui/menu-search'
import { StatusPill } from '@/components/ui/status-pill'
import {
  ProjectRunning,
  SIDEBAR_GROUP_LABEL,
  SidebarCount,
  SidebarTaskRowBody,
  TaskRowStatus,
  sidebarTaskRowClass,
} from '@/components/ui/sidebar'
import {
  AddFirstProject,
  ProjectBackButton,
  ProjectNewRow,
  ProjectPickerGroup,
  ProjectPickerRow,
  ProjectSwitcherButton,
  ProjectToolRow,
  ProjectToolsHeader,
} from '@/components/ui/project-switcher'
import { ProjectCard } from '@/components/ui/project-card'

/**
 * 设置 → 组件里方案 B 侧栏的样例：项目切换器、项目工具、展开的项目下拉、全部项目页的卡片、没有项目时的大按钮。
 * 和侧栏用同一套部件，调「导航行」「卡片」时这里跟着变。示例数据不翻译
 */
export function ProjectSidebarSpecimen() {
  return (
    <div className="flex w-full flex-wrap items-start gap-4">
      <div className="flex w-64 flex-col gap-1.5 rounded-lg bg-rail px-2.5 py-2.5">
        <ProjectSwitcherButton name="客户端主工程" meta="游戏 · 1 个执行中" alert="其他项目有对话在等你处理" />
        <ProjectToolsHeader onSettings={() => {}} />
        <ProjectToolRow icon={Table2} label="表格" meta="312 张" on />
        <ProjectToolRow icon={Gamepad2} label="UE" dot="本次日志有错误" />
        <ProjectToolRow icon={Sparkles} label={t('技能与 MCP')} meta="4 + 9" />
        <ProjectToolRow icon={Lightbulb} label={t('经验与文档')} />
        {/* 当前项目的对话：进行中、最近两组，行尾状态做轻，选中是 bg-sel */}
        <p className={cn('px-2.5 pt-2', SIDEBAR_GROUP_LABEL)}>{t('进行中')}</p>
        <div className={cn(sidebarTaskRowClass(true, false), 'px-2.5')}>
          <SidebarTaskRowBody active title="复查当前编译是否仍报错" status={<TaskRowStatus kids={1} running />} />
        </div>
        <div className={cn(sidebarTaskRowClass(false, false), 'px-2.5')}>
          <SidebarTaskRowBody title="接入 Pi CLI 输出" status={<TaskRowStatus needs />} />
        </div>
        <p className={cn('px-2.5 pt-2', SIDEBAR_GROUP_LABEL)}>{t('最近')}</p>
        <div className={cn(sidebarTaskRowClass(false, false), 'px-2.5')}>
          <SidebarTaskRowBody workflow title="修复设置弹窗闪动" status={<TaskRowStatus unread />} />
        </div>
        <div className={cn(sidebarTaskRowClass(false, false), 'px-2.5')}>
          <SidebarTaskRowBody
            title="状态弹窗日志贴到最新"
            status={<TaskRowStatus left={{ done: 3, total: 7, stuck: true }} />}
          />
        </div>
        <div className={cn(sidebarTaskRowClass(false, false), 'px-2.5')}>
          <SidebarTaskRowBody title="清理已合并的分支" time="11/6" />
        </div>
      </div>
      <div className={cn(popoverPanel, 'relative w-72')}>
        <MenuSearch value="" onChange={() => {}} placeholder={t('搜索项目')} autoFocus={false} />
        <ProjectNewRow hint={t('选目录、选能力')} className="mb-1" />
        <ProjectPickerGroup label="网页" />
        <ProjectPickerRow
          name="商城前台"
          status={
            <StatusPill tone="wait" className="h-[18px] px-[7px] text-caption font-medium">
              {t('等你处理')}
            </StatusPill>
          }
        />
        <ProjectPickerRow name="运营后台" status={<SidebarCount n={1} />} />
        <ProjectPickerGroup label="游戏" />
        <ProjectPickerRow name="客户端主工程" on status={<ProjectRunning n={1} />} />
      </div>
      <div className="flex w-72 flex-col gap-3">
        <ProjectCard
          name="客户端主工程"
          path="D:/Work/TPSProject"
          category="游戏"
          status={<ProjectRunning n={1} />}
          recent={['复查当前编译是否仍报错', 'AI 分析表格风格：UI 配置表', '修复编译报错']}
          onOpen={() => {}}
        />
        <AddFirstProject onClick={() => {}} />
        {/* 盖住侧栏的项目工具页（UE、表格）导航栏顶上的项目卡片：点一下回到项目对话 */}
        <div className="flex flex-col gap-1.5 rounded-lg bg-rail px-2.5 py-2.5">
          <ProjectBackButton icon={Gamepad2} name="UnLua · TPSProject" meta="UE 5.4 · C++ · Git" />
          <ProjectBackButton name="客户端主工程" meta="D:/Work/TPSProject" />
        </div>
      </div>
    </div>
  )
}
