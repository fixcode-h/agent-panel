/**
 * 面板自带的技能进「/」菜单（ADR 0083）：自带技能不再装进 ~/.agents/skills，CLI 自己列不出来了，由面板列、面板展开，
 * 用户打「/lua-code-style 改一下日志」照旧能点名用它（展开时带上 SKILL.md 正文，server/slash.ts）。
 * 路径指向面板数据目录里装的那份（用户改过就是改过的）；还没装的展开前补装
 */
import path from 'node:path'
import { frontField } from '../../shared/library.ts'
import { t } from '../../shared/i18n.ts'
import { bundledStore, entries } from '../bundled-skills.ts'

export async function coreSkillCommands() {
  return (await entries())
    .filter((e) => !e.plugin)
    .map((e) => ({
      name: e.name,
      description: frontField(e.files.get('SKILL.md')!.toString('utf8'), 'description')
        .replace(/\s+/g, ' ')
        .slice(0, 200),
      kind: 'skill' as const,
      source: t('面板自带'),
      path: path.join(bundledStore(), e.name, 'SKILL.md'),
    }))
}
