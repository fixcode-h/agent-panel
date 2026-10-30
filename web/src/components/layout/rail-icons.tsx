import type { ReactNode, SVGProps } from 'react'

/**
 * 图标栏和功能页入口用的一套图标：lucide 里这几个（机器人、两个方块、带钟的日历）粗细、圆角、繁简不一，
 * 并排放在图标栏里很乱。这里在同一张 24 格网格上重画：同样的圆角（3.5）、同样的线宽、圆头圆角，
 * 每个图标的「主体」另画一层 .rail-fill，平时透明，选中（aria-current="page"）时填上浅色，
 * 和 Claude 应用里选中图标变实心是同一个意思（样式见 index.css 的 .rail-fill）
 */
export type NavIcon = (p: { className?: string; strokeWidth?: number }) => ReactNode

function icon(fill: ReactNode, line: ReactNode): NavIcon {
  return function RailIcon({ className, strokeWidth = 1.7 }) {
    const p: SVGProps<SVGSVGElement> = {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className,
      'aria-hidden': true,
    }
    return (
      <svg {...p}>
        <g className="rail-fill" stroke="none" fill="currentColor">
          {fill}
        </g>
        {line}
      </svg>
    )
  }
}

/** 对话总览：三行列表，每行前一个状态点 */
export const OverviewIcon = icon(
  <rect x="3.5" y="4" width="17" height="16" rx="3.5" />,
  <>
    <rect x="3.5" y="4" width="17" height="16" rx="3.5" />
    <path d="M10 9h6.5M10 12h6.5M10 15h4" />
    <g stroke="none" fill="currentColor">
      <circle cx="7.25" cy="9" r="1.1" />
      <circle cx="7.25" cy="12" r="1.1" />
      <circle cx="7.25" cy="15" r="1.1" />
    </g>
  </>,
)

/** 工作总结：一页报告 */
export const SummaryIcon = icon(
  <rect x="5" y="3" width="14" height="18" rx="3.5" />,
  <>
    <rect x="5" y="3" width="14" height="18" rx="3.5" />
    <path d="M9 8.5h6M9 12h6M9 15.5h3.5" />
  </>,
)

/** 计划：日历，表头一条实心 */
export const ScheduleIcon = icon(
  <path d="M3.5 8.5A3.5 3.5 0 0 1 7 5h10a3.5 3.5 0 0 1 3.5 3.5V10h-17z" />,
  <>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <g stroke="none" fill="currentColor">
      <circle cx="8" cy="15.25" r="1.1" />
      <circle cx="12" cy="15.25" r="1.1" />
      <circle cx="16" cy="15.25" r="1.1" />
    </g>
  </>,
)

/** 角色：半身像 */
export const RoleIcon = icon(
  <>
    <circle cx="12" cy="8.25" r="3.75" />
    <path d="M4.75 20.25c.6-3.7 3.5-6 7.25-6s6.65 2.3 7.25 6z" />
  </>,
  <>
    <circle cx="12" cy="8.25" r="3.75" />
    <path d="M4.75 20.25c.6-3.7 3.5-6 7.25-6s6.65 2.3 7.25 6" />
  </>,
)

/** 工作流：两个节点一条连线 */
export const WorkflowIcon = icon(
  <>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2.25" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2.25" />
  </>,
  <>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2.25" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2.25" />
    <path d="M7 10.5V13a4 4 0 0 0 4 4h2.5" />
  </>,
)

const STAR = 'M11 5.5c.6 4.7 2.3 6.5 7.5 7.5-5.2 1-6.9 2.8-7.5 7.5-.6-4.7-2.3-6.5-7.5-7.5 5.2-1 6.9-2.8 7.5-7.5z'
/** Skills：一大一小两颗星 */
export const SkillIcon = icon(
  <path d={STAR} />,
  <>
    <path d={STAR} />
    <path d="M18 3c.25 1.4.9 2.15 2.5 2.5-1.6.35-2.25 1.1-2.5 2.5-.25-1.4-.9-2.15-2.5-2.5 1.6-.35 2.25-1.1 2.5-2.5z" />
  </>,
)

const PLUG = 'M6 7.5h12v2.75a6 6 0 0 1-12 0z'
/** MCP 工具：插头 */
export const McpIcon = icon(
  <path d={PLUG} />,
  <>
    <path d={PLUG} />
    <path d="M9 3.5v4M15 3.5v4M12 16.25v4.25" />
  </>,
)

/** 收起 / 展开会话侧栏：左边一栏实心 */
export const PanelIcon = icon(
  <path d="M7 4.5h2.5v15H7A3.5 3.5 0 0 1 3.5 16V8A3.5 3.5 0 0 1 7 4.5z" />,
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
    <path d="M9.5 4.5v15" />
  </>,
)

/** 回到主页 */
export const HomeIcon = icon(
  <path d="M4 10.5 12 4l8 6.5V17a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 17z" />,
  <>
    <path d="M4 10.5 12 4l8 6.5V17a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 17z" />
    <path d="M10 20.5v-4.25a2 2 0 0 1 4 0v4.25" />
  </>,
)

/** ComfyUI 工作流：上面两个节点汇到下面一个（照设计稿 ComfyUI 画板） */
export const ComfyIcon = icon(
  <rect x="8.5" y="14" width="7" height="6.5" rx="2.25" />,
  <>
    <rect x="2.5" y="3.5" width="7" height="6.5" rx="2.25" />
    <rect x="14.5" y="3.5" width="7" height="6.5" rx="2.25" />
    <rect x="8.5" y="14" width="7" height="6.5" rx="2.25" />
    <path d="M6 10v1.5a2.5 2.5 0 0 0 2.5 2.5M18 10v1.5a2.5 2.5 0 0 1-2.5 2.5" />
  </>,
)
