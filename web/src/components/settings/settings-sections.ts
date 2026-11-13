import {
  ArrowUpCircle,
  SlidersHorizontal,
  Cpu,
  ImageIcon,
  Settings2,
  Palette,
  Sparkles,
  type LucideIcon,
  Layers,
  HardDrive,
  KeyRound,
  Tag as TagIcon,
  Rocket,
  Type,
  Globe,
  Network,
  ShieldCheck,
  Webhook,
  GraduationCap,
  Lightbulb,
  Gauge,
  Keyboard,
  Brain,
  Mic,
  Volume2,
  Component,
  Puzzle,
  Heading,
  BellRing,
  Plug,
} from 'lucide-react'
import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import * as pp from '@/plugins/PluginParamsNav'

/** 设置弹窗左栏的一页（从 pages/SettingsPage.tsx 挪出：左栏、二级列表和搜索都按它走） */
export interface Section {
  id: string
  label: string
  icon?: LucideIcon
  cli?: CliDefinition
  /** 左栏里的分组（CLI 二级列表里的页不用） */
  group?: string
}

// 左栏按分组列出，组内顺序就是这里的顺序
export const sectionsFor = (clis: CliDefinition[], plugins: Section[], mcp: Section[] = []): Section[] => [
  { id: 'general', label: t('常规'), icon: Settings2, group: t('通用') },
  { id: 'shortcuts', label: t('快捷键'), icon: Keyboard, group: t('通用') },
  { id: 'chat-memory', label: t('关于我与记忆'), icon: Brain, group: t('通用') },
  { id: 'speech', label: t('语音输入'), icon: Mic, group: t('通用') },
  { id: 'read-aloud', label: t('语音朗读'), icon: Volume2, group: t('通用') },
  { id: 'fonts', label: t('外观'), icon: Type, group: t('通用') },
  { id: 'markdown', label: t('Markdown 样式'), icon: Heading, group: t('通用') },
  { id: 'components', label: t('组件'), icon: Component, group: t('通用') },
  { id: 'categories', label: t('项目分类'), icon: Layers, group: t('项目') },
  { id: 'tags', label: t('标签'), icon: TagIcon, group: t('项目') },
  { id: 'global-lessons', label: t('全局教训'), icon: GraduationCap, group: t('项目') },
  { id: 'experience', label: t('经验'), icon: Lightbulb, group: t('项目') },
  { id: 'models', label: t('默认 Agent'), icon: Cpu, group: t('Agent 与 AI') },
  // 部署和 API 也是 CLI 的事（写全局说明、放技能；各 CLI 用哪个 API），放在 CLI 二级列表里默认 CLI 下面
  { id: 'deploy', label: t('部署'), icon: Rocket },
  { id: 'apis', label: t('API 配置'), icon: KeyRound },
  ...clis.map((c) => ({ id: `cli:${c.id}`, label: c.name, cli: c })),
  { id: 'assist', label: t('AI 创建'), icon: Sparkles, group: t('Agent 与 AI') },
  { id: 'hooks', label: t('钩子'), icon: Webhook, group: t('Agent 与 AI') },
  // 面板和插件给 Agent 的 MCP 能力：左栏一项，二级列表里是各来源（web/src/components/settings/mcp/McpNav.tsx）
  { id: 'mcp', label: 'MCP', icon: Plug, group: t('Agent 与 AI') },
  ...mcp,
  // 外部 CLI 的授权（GitHub CLI 等），以后加新的授权工具只加定义
  { id: 'integrations', label: t('授权'), icon: ShieldCheck, group: t('连接') },
  { id: 'remote', label: t('外部访问'), icon: Globe, group: t('连接') },
  { id: 'notify-channels', label: t('通知渠道'), icon: BellRing, group: t('连接') },
  { id: 'network', label: t('网络与代理'), icon: Network, group: t('连接') },
  { id: 'local-image', label: t('本机生图'), icon: ImageIcon, group: t('生图') },
  { id: 'styles', label: t('风格库'), icon: Palette, group: t('生图') },
  { id: 'plugins', label: t('插件'), icon: Puzzle, group: t('扩展') },
  // 开着的插件各占一页，和 Agent 一样左栏一项、二级列表分开展示（PluginParamsNav.tsx）
  { id: pp.PLUGIN_PARAMS, label: t('插件参数'), icon: SlidersHorizontal, group: t('扩展') },
  ...plugins,
  { id: 'data', label: t('数据'), icon: HardDrive, group: t('系统') },
  { id: 'usage', label: t('用量统计'), icon: Gauge, group: t('系统') },
  { id: 'update', label: t('版本更新'), icon: ArrowUpCircle, group: t('系统') },
]

/** CLI 相关的几页（默认 Agent、部署、API 和各个 CLI）：左栏合成一项「Agent」，右边多一列二级列表 */
export const cliPage = (s: Section) => s.id === 'models' || s.id === 'deploy' || s.id === 'apis' || !!s.cli
