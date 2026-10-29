import {
  Bot,
  Brain,
  Bug,
  Code2,
  Database,
  Eye,
  FileText,
  Languages,
  Layout,
  Palette,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  FlaskConical,
  Wand2,
  Wrench,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

import { AGENT_ICON_IDS } from '@shared/icons'

const ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  brain: Brain,
  workflow: Workflow,
  code: Code2,
  layout: Layout,
  database: Database,
  palette: Palette,
  test: FlaskConical,
  bug: Bug,
  shield: ShieldCheck,
  search: Search,
  doc: FileText,
  wrench: Wrench,
  rocket: Rocket,
  wand: Wand2,
  sparkles: Sparkles,
  eye: Eye,
  languages: Languages,
}

/** Agent 可选图标；想加新图标先在 shared/icons.ts 登记 id，再在上面配图标组件 */
export const AGENT_ICONS: { id: string; label: string; icon: LucideIcon }[] = AGENT_ICON_IDS.map(([id, label]) => ({
  id,
  label,
  icon: ICONS[id] ?? Bot,
}))

export const agentIcon = (id: string) => ICONS[id] ?? Bot
