import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChevronsLeft, ChevronsRight, Moon, Settings, Sun } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { useAppUpdate } from '@/lib/app-update'
import { deployedUpdateHint, sharedUpdateHint, useSkillUpdates } from '@/lib/skill-updates'
import { HomeIcon, PanelIcon, type NavIcon } from './rail-icons'
import { toggleActivityBar, useActivityBarWide } from './rail-expanded'
import { usePluginPages } from '@/plugins/registry'
import type { PluginPage } from '@/plugins/sdk'
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
 * 图标栏里的一格：收起时只有图标，名字在悬停提示和读屏名里；展开（分析稿 U4）时图标右边写名字。
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
  const wide = useActivityBarWide()
  const hint = typeof dot === 'string' ? dot : ''
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={hint ? hintId : undefined}
      aria-current={on ? 'page' : undefined}
      // 展开后名字已经写在格子里，悬停只补小点的说明
      title={wide ? hint || undefined : hint ? `${label}\n${hint}` : label}
      onClick={onClick}
      className={cn(
        'rail-item press relative h-10 shrink-0 cursor-pointer rounded-xl',
        wide ? 'flex w-full items-center gap-2.5 px-2 text-left' : 'grid w-10 place-items-center',
        on ? 'bg-active text-fg' : 'text-subtle hover:bg-hover hover:text-fg',
      )}
    >
      {/* 24px、线宽 1.75：32px 把格子撑满、像一排贴纸（用户反馈「很丑」），20px 又偏小；
          留出 8px 的底色边，选中 / 悬停的底才看得出是一块按钮。
          小点跟着图标走（压在图标右上角），展开、收起都在同一个位置 */}
      <span className="relative grid h-6 w-6 shrink-0 place-items-center">
        <Icon className="h-6 w-6" strokeWidth={1.75} />
        {/* 圆点描一圈图标栏的底色，压在图标角上也分得开 */}
        {dot && (
          <span aria-hidden className="activity-dot absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent" />
        )}
      </span>
      {wide && (
        <span aria-hidden className="min-w-0 truncate text-body">
          {label}
        </span>
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
  const pages = usePluginPages()
  const wide = useActivityBarWide()
  // 分隔线：收起时是格子下面居中的一小段，展开时横贯整栏（左右留一点边）
  const sep = cn('activity-sep my-1 h-px shrink-0', wide ? 'mx-2 self-stretch' : 'w-5')
  return (
    <nav
      aria-label={t('功能栏')}
      data-activity-bar
      data-wide={wide ? '' : undefined}
      className={cn(
        'activity-bar hidden shrink-0 flex-col gap-1 py-2.5 md:flex',
        wide ? 'w-44 items-stretch px-2' : 'w-14 items-center',
      )}
    >
      {tool ? (
        <Item icon={HomeIcon} label={t('回到主页')} onClick={() => go(homeRoute(route.page))} />
      ) : (
        <Item icon={PanelIcon} label={collapsed ? t('展开侧栏') : t('收起侧栏')} onClick={toggleSidebar} />
      )}
      {/* 会话侧栏让开时（功能页、收起）模式切换跟着到图标栏来：不然从功能页切不了 Agent / Chat / 设计 */}
      {(tool || collapsed) && (
        <div className={cn('mt-1', wide && 'px-0.5')}>
          {/* 展开后横着放得下三个模式，和会话侧栏顶上那一排一样 */}
          <ModeSwitch narrow={!wide} />
        </div>
      )}
      <span aria-hidden className={sep} />
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
      {/* 插件的整页（插件接口 2）：和通用功能页隔开另起一组，插件关掉或删掉后这一组就没了 */}
      {pages.length > 0 && <span aria-hidden className={sep} />}
      {pages.map((p) => (
        <PluginItem key={`${p.plugin}/${p.id}`} page={p} />
      ))}
      {/* 设计模式自己的功能页（ComfyUI 工作流）：只在设计模式下出现，和上面的通用功能页隔开 */}
      {isDesignPage(route.page) && (
        <>
          <span aria-hidden className={sep} />
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
      <Item
        icon={wide ? ChevronsLeft : ChevronsRight}
        label={wide ? t('只显示图标') : t('图标旁显示名字')}
        onClick={toggleActivityBar}
      />
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

/** 插件整页的一格：小点由插件自己的 hook 给（例如 UE 插件的「本次日志有错误」） */
function PluginItem({ page }: { page: PluginPage & { plugin: string } }) {
  const { route, go } = useNav()
  const dot = page.useDot?.()
  return (
    <Item
      icon={page.icon}
      label={page.label}
      on={route.page === 'plugin' && route.id === page.plugin && route.sub === page.id}
      dot={dot || undefined}
      onClick={() => go({ page: 'plugin', id: page.plugin, sub: page.id })}
    />
  )
}
