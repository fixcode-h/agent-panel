import {
  Bot, Brain, Bug, Code2, Database, FileText, Layout, Palette, Rocket, Search,
  ShieldCheck, Sparkles, FlaskConical, Wand2, Wrench, Workflow, type LucideIcon,
} from 'lucide-react'

/** Agent 可选图标；想加新图标在这里登记即可 */
export const AGENT_ICONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'bot', label: '通用', icon: Bot },
  { id: 'brain', label: '规划', icon: Brain },
  { id: 'workflow', label: '调度', icon: Workflow },
  { id: 'code', label: '编码', icon: Code2 },
  { id: 'layout', label: '前端', icon: Layout },
  { id: 'database', label: '后端', icon: Database },
  { id: 'palette', label: '设计', icon: Palette },
  { id: 'test', label: '测试', icon: FlaskConical },
  { id: 'bug', label: '排错', icon: Bug },
  { id: 'shield', label: '审查', icon: ShieldCheck },
  { id: 'search', label: '调研', icon: Search },
  { id: 'doc', label: '文档', icon: FileText },
  { id: 'wrench', label: '运维', icon: Wrench },
  { id: 'rocket', label: '发布', icon: Rocket },
  { id: 'wand', label: '优化', icon: Wand2 },
  { id: 'sparkles', label: '创意', icon: Sparkles },
]

export const agentIcon = (id: string) => AGENT_ICONS.find((i) => i.id === id)?.icon ?? Bot
