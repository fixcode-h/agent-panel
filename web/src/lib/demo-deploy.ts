import { CLIS } from '@shared/clis'
import {
  composeAgentsMd,
  DeployConfig,
  DeployRun,
  deployTemplate,
  SKILL_TARGET,
  type DeployResult,
  type DeployState,
} from '@shared/deploy'
import { frontField } from '@shared/library'
import { startDemoGlobalDocJob } from './demo-docs'

/**
 * 在线演示里的「部署」：没有本机目录，部署了什么记在页面内存里
 */
const BUNDLED = import.meta.glob('../../../skills/*/*/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const skills = () =>
  Object.entries(BUNDLED)
    .map(([file, text]) => {
      const [category, name] = file.split('/skills/')[1].split('/')
      return { name, category, description: frontField(text, 'description'), files: 0 }
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))

let config: DeployConfig = { agentsMd: deployTemplate(), skills: [], clis: ['claude', 'codex'] }
const deployed = new Set<string>()
const docs = new Map<string, string>()
const home = (p: string) => p.replace(/\$\{\w+:-([^}]*)\}/g, '$1').replace(/^~/, '/Users/demo')

function state(active: string[]): DeployState {
  const list = skills()
  const content = composeAgentsMd(
    config.agentsMd,
    list.filter((s) => config.skills.includes(s.name)),
  )
  return {
    config,
    template: deployTemplate(),
    skillRoot: home(SKILL_TARGET),
    skills: list.map((s) => ({ ...s, status: deployed.has(s.name) ? 'same' : 'missing' })),
    targets: CLIS.filter((d) => d.globalDoc && active.includes(d.id)).map((d) => {
      const cur = docs.get(d.id)
      return {
        cli: d.id,
        name: d.name,
        path: home(d.globalDoc!),
        status: cur === undefined ? 'missing' : cur === content ? 'same' : 'changed',
      }
    }),
  }
}

export function demoDeploy(method: string, sub: string | undefined, body: unknown, active: string[]): unknown {
  // 演示里装的都是这一版的自带技能，没有要更新的
  if (sub === 'updates') return { shared: [], deployed: [] }
  if (sub === 'optimize') return startDemoGlobalDocJob(body as { content?: string; request?: string })
  if (sub === 'run') {
    const run = DeployRun.parse(body)
    config = DeployConfig.parse(run)
    const out: DeployResult = { skills: [], kept: [], removed: [], docs: [] }
    for (const s of skills()) {
      if (run.skills.includes(s.name) && !deployed.has(s.name)) {
        deployed.add(s.name)
        out.skills.push(s.name)
      } else if (!run.skills.includes(s.name) && deployed.delete(s.name)) out.removed.push(s.name)
    }
    const content = composeAgentsMd(
      run.agentsMd,
      skills().filter((s) => run.skills.includes(s.name)),
    )
    for (const d of CLIS.filter((x) => x.globalDoc && run.clis.includes(x.id) && active.includes(x.id))) {
      const cur = docs.get(d.id)
      docs.set(d.id, content)
      out.docs.push({
        cli: d.id,
        path: home(d.globalDoc!),
        result: cur === undefined ? 'created' : cur === content ? 'same' : 'updated',
      })
    }
    return { result: out, state: state(active) }
  }
  if (method === 'PUT') config = DeployConfig.parse(body)
  return state(active)
}
