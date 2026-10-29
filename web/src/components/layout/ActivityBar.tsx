import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Moon, Settings, Sun } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { useAppUpdate } from '@/lib/app-update'
import { deployedUpdateHint, sharedUpdateHint, useSkillUpdates } from '@/lib/skill-updates'
import { HomeIcon, PanelIcon, type NavIcon } from './rail-icons'
import {
  DESIGN_NAV,
  ModeSwitch,
  NAV,
  homeRoute,
  isDesignPage,
  isToolPage,
  toggleSidebar,
  useSidebarCollapsed,
} from './Sidebar'

/**
 * 图标栏里的一格：只有图标，名字在悬停提示和读屏名里。
 * 选中的那格浅底 + 前景色，图标主体填实（.rail-fill）；按下时轻微缩一下，点了有反馈
 */
function Item({
  icon: Icon,
  label,
  on,
  dot,
  onClick,
}: {
  icon: LucideIcon | NavIcon
  label: string
  on?: boolean
  /** 右上角的小点：有更新、有新内容；给文字时也写进悬停提示 */
  dot?: string | boolean
  onClick: () => void
}) {
  // 提示挂在 aria-describedby 上：放进名字里会让按名字找「设置」找不到（和侧栏的行一样）
  const hintId = useId()
  const hint = typeof dot === 'string' ? dot : ''
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={hint ? hintId : undefined}
      aria-current={on ? 'page' : undefined}
      title={typeof dot === 'string' ? `${label}\n${dot}` : label}
      onClick={onClick}
      className={cn(
        'rail-item relative grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-[10px] transition-[background-color,color,transform] duration-150 active:scale-[0.94]',
        on ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
      )}
    >
      <Icon className="h-5 w-5" strokeWidth={1.6} />
      {/* 圆点描一圈图标栏的底色，压在图标角上也分得开 */}
      {dot && (
        <span aria-hidden className="activity-dot absolute top-[7px] right-[7px] h-2 w-2 rounded-full bg-accent" />
      )}
      {hint && (
        <span id={hintId} hidden>
          {hint}
        </span>
      )}
    </button>
  )
}

/**
 * 最左边的图标栏（照 Proma）：工作总结、计划、角色、工作流、Skills、MCP 这些功能页一格一个，底下是主题和设置；
 * 设计模式下再多一组只属于设计的（ComfyUI 工作流）。
 * 最上面一格看在哪：会话页（任务、项目、聊天、设计）是收起 / 展开会话侧栏；
 * 功能页上会话侧栏让开了，这一格换成「回到主页」，回到最近看的那个会话页。
 * 只在宽屏显示，手机上这些入口在抽屉菜单里
 */
export function ActivityBar({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { route, go, openSettings } = useNav()
  const collapsed = useSidebarCollapsed()
  const tool = isToolPage(route.page)
  const appUpdate = useAppUpdate().data
  const update = !import.meta.env.VITE_DEMO && appUpdate?.packaged ? appUpdate.update : undefined
  const skillUpd = useSkillUpdates()
  return (
    <nav
      aria-label={t('功能栏')}
      data-activity-bar
      className="activity-bar hidden w-14 shrink-0 flex-col items-center gap-1.5 py-2.5 md:flex"
    >
      {tool ? (
        <Item icon={HomeIcon} label={t('回到主页')} onClick={() => go(homeRoute(route.page))} />
      ) : (
        <Item icon={PanelIcon} label={collapsed ? t('展开侧栏') : t('收起侧栏')} onClick={toggleSidebar} />
      )}
      {/* 会话侧栏让开时（功能页、收起）模式切换跟着到图标栏来：不然从功能页切不了 Agent / Chat / 设计 */}
      {(tool || collapsed) && (
        <div className="mt-1">
          <ModeSwitch narrow />
        </div>
      )}
      <span aria-hidden className="activity-sep my-1 h-px w-5 shrink-0" />
      {NAV.map((n) => (
        <Item
          key={n.id}
          icon={n.icon}
          label={n.label}
          on={route.page === n.id}
          dot={n.id === 'library' ? sharedUpdateHint(skillUpd) : undefined}
          onClick={() => go({ page: n.id })}
        />
      ))}
      {/* 设计模式自己的功能页（ComfyUI 工作流）：只在设计模式下出现，和上面的通用功能页隔开 */}
      {isDesignPage(route.page) && (
        <>
          <span aria-hidden className="activity-sep my-1 h-px w-5 shrink-0" />
          {DESIGN_NAV.map((n) => (
            <Item
              key={n.id}
              icon={n.icon}
              label={n.label}
              on={route.page === n.id}
              onClick={() => go({ page: n.id })}
            />
          ))}
        </>
      )}
      <span className="flex-1" />
      <Item icon={dark ? Sun : Moon} label={dark ? t('切换到浅色') : t('切换到深色')} onClick={onToggleTheme} />
      <Item
        icon={Settings}
        label={t('设置')}
        dot={update ? t('有新版本') : deployedUpdateHint(skillUpd)}
        onClick={() => openSettings(update ? 'update' : undefined)}
      />
    </nav>
  )
}
