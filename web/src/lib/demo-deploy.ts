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
import { resolveSkills } from '@shared/skill-guide'
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

/**
 * 界面检查用：这里列出的技能当作「已部署、内容和这一版自带的不同」（重新部署一次后清掉）。
 * 演示里没有本机目录，只能靠这个钩子造出「部署那份有差异」的场景，同 demo-slow-messages
 */
const OUTDATED_KEY = 'demo-deploy-outdated'
function readOutdated(): Set<string> {
  try {
    return new Set((globalThis.localStorage?.getItem(OUTDATED_KEY) ?? '').split(',').filter(Boolean))
  } catch {
    return new Set<string>()
  }
}
function writeOutdated(names: Set<string>) {
  try {
    if (names.size) globalThis.localStorage?.setItem(OUTDATED_KEY, [...names].join(','))
    else globalThis.localStorage?.removeItem(OUTDATED_KEY)
  } catch {}
}

function state(active: string[]): DeployState {
  const list = skills()
  const stale = readOutdated()
  const content = composeAgentsMd(
    config.agentsMd,
    list.filter((s) => config.skills.includes(s.name)),
  )
  return {
    config,
    template: deployTemplate(),
    skillRoot: home(SKILL_TARGET),
    skills: list.map((s) => ({
      ...s,
      status: stale.has(s.name) ? 'changed' : deployed.has(s.name) ? 'same' : 'missing',
    })),
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
  // 演示里装的都是这一版的自带技能；界面检查用 localStorage 造出「和自带的不同」的情形。
  // 不按 config.skills 再过滤：钩子本身就是「已部署的那份」，演示没有真实目录可判（正式后端按勾选过滤）
  if (sub === 'updates') return { shared: [], deployed: [...readOutdated()] }
  if (sub === 'optimize') return startDemoGlobalDocJob(body as { content?: string; request?: string })
  if (sub === 'run') {
    const run = DeployRun.parse(body)
    config = DeployConfig.parse(run)
    // 和正式部署一样（server/deploy.ts 的 deploy）：选了特化技能把它扩展的通用技能一起算
    const picked = resolveSkills(run.skills)
    const out: DeployResult = { skills: [], kept: [], removed: [], docs: [] }
    for (const s of skills()) {
      if (picked.includes(s.name) && !deployed.has(s.name)) {
        deployed.add(s.name)
        out.skills.push(s.name)
      } else if (!picked.includes(s.name) && deployed.delete(s.name)) out.removed.push(s.name)
    }
    const content = composeAgentsMd(
      run.agentsMd,
      skills().filter((s) => picked.includes(s.name)),
    )
    // 部署一次就算覆盖成这一版的内容：界面检查里「重新部署后提醒点消失」靠这一句
    const stale = readOutdated()
    for (const name of picked) stale.delete(name)
    writeOutdated(stale)
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
