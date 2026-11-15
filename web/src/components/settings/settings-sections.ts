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
  /** 旧名或常用叫法（中文原文）：设置搜索按它也能命中这一页，改名后搜旧名不落空 */
  aliases?: string[]
}

// 左栏按分组列出，组内顺序就是这里的顺序。
// 2026-11-15 重新分组（用户觉得名称和分类不合理）：外观三页单独成组，记忆、经验、教训归到「记忆与经验」；
// 改过名的页把旧名写进 aliases，搜旧名照样能找到这一页
export const sectionsFor = (clis: CliDefinition[], plugins: Section[], mcp: Section[] = []): Section[] => [
  { id: 'general', label: t('常规'), icon: Settings2, group: t('通用') },
  { id: 'shortcuts', label: t('快捷键'), icon: Keyboard, group: t('通用') },
  { id: 'speech', label: t('语音输入'), icon: Mic, group: t('通用') },
  { id: 'read-aloud', label: t('语音朗读'), icon: Volume2, group: t('通用') },
  { id: 'fonts', label: t('主题与字体'), icon: Type, group: t('外观'), aliases: ['外观', '配色'] },
  { id: 'markdown', label: t('正文排版'), icon: Heading, group: t('外观'), aliases: ['Markdown 样式', 'Markdown'] },
  { id: 'components', label: t('控件样式'), icon: Component, group: t('外观'), aliases: ['组件'] },
  { id: 'models', label: t('默认 Agent'), icon: Cpu, group: t('Agent 与 AI') },
  // 部署和 API 也是 CLI 的事（写全局说明、放技能；各 CLI 用哪个 API），放在 CLI 二级列表里默认 CLI 下面
  { id: 'deploy', label: t('说明与技能'), icon: Rocket, aliases: ['部署', '全局说明'] },
  { id: 'apis', label: t('API 配置'), icon: KeyRound },
  ...clis.map((c) => ({ id: `cli:${c.id}`, label: c.name, cli: c })),
  // 面板自己的 AI 功能（AI 创建角色 / 工作流、AI 补全模型、AI 处理装环境等）用哪个 Agent
  { id: 'assist', label: t('AI 辅助'), icon: Sparkles, group: t('Agent 与 AI'), aliases: ['AI 创建'] },
  { id: 'hooks', label: t('钩子'), icon: Webhook, group: t('Agent 与 AI') },
  // 面板和插件给 Agent 的 MCP 能力：左栏一项，二级列表里是各来源（web/src/components/settings/mcp/McpNav.tsx）
  { id: 'mcp', label: 'MCP', icon: Plug, group: t('Agent 与 AI') },
  ...mcp,
  { id: 'chat-memory', label: t('关于我'), icon: Brain, group: t('记忆与经验'), aliases: ['关于我与记忆', '记忆'] },
  { id: 'experience', label: t('经验'), icon: Lightbulb, group: t('记忆与经验') },
  { id: 'global-lessons', label: t('教训'), icon: GraduationCap, group: t('记忆与经验'), aliases: ['全局教训'] },
  { id: 'categories', label: t('项目分类'), icon: Layers, group: t('项目') },
  { id: 'tags', label: t('标签'), icon: TagIcon, group: t('项目') },
  { id: 'local-image', label: t('本机生图'), icon: ImageIcon, group: t('生图') },
  { id: 'styles', label: t('风格库'), icon: Palette, group: t('生图') },
  { id: 'remote', label: t('外部访问'), icon: Globe, group: t('连接') },
  { id: 'network', label: t('网络与代理'), icon: Network, group: t('连接') },
  // 外部 CLI 的授权（GitHub CLI 等），以后加新的授权工具只加定义
  { id: 'integrations', label: t('账号授权'), icon: ShieldCheck, group: t('连接'), aliases: ['授权'] },
  { id: 'notify-channels', label: t('通知渠道'), icon: BellRing, group: t('连接') },
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
