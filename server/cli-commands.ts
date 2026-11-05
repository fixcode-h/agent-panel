import { homedir } from 'node:os'
import type { CommandsQuery } from '../shared/cli-commands-query.ts'
import { buildFromRules } from '../shared/cli-spec.ts'
import { getCli } from '../shared/clis.ts'
import type { TrustChoice } from '../shared/cli-trust.ts'
import { t } from '../shared/i18n.ts'
import type { SlashCommand } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { childEnv } from './exec/process.ts'
import { rpcQuery } from './exec/rpc/query.ts'
import { getSettings } from './settings.ts'

/**
 * 从 CLI 自己问出的「/」命令（ADR 0050 第四期，定义里的 rpc.commandsQuery）：插件注册的命令、
 * 插件包里带的提示词模板和 Skill。面板扫目录只看得到用户目录和项目目录里的，插件里的要问 CLI。
 * path 是命令文件或 SKILL.md 的位置（面板照常展开）；native 是只有 CLI 自己能执行的命令（插件命令），原样交给它
 */
export interface QueriedCommand extends SlashCommand {
  path: string
  native?: boolean
}

const getPath = (obj: unknown, path: string): unknown =>
  path ? path.split('.').reduce<any>((x, k) => (x == null ? undefined : x[k]), obj) : undefined

/** 回复里的命令列表换成面板的条目（纯函数）：不认识的种类、没有名字的不要；模板和 Skill 没有文件路径的也不要（面板展开不了） */
export function parseQueried(q: CommandsQuery, reply: unknown): QueriedCommand[] {
  const list = getPath(reply, q.list)
  if (!Array.isArray(list)) return []
  return list.flatMap((x): QueriedCommand[] => {
    const raw = String(getPath(x, q.kind) ?? '')
    const kind = q.kinds[raw]
    const prefix = q.namePrefix[raw] ?? ''
    let name = String(getPath(x, q.name) ?? '').trim()
    if (!kind || !name) return []
    if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length)
    const path = q.path ? String(getPath(x, q.path) ?? '') : ''
    if (kind !== 'native' && !path) return []
    return [
      {
        name,
        description: String(getPath(x, q.description) ?? ''),
        kind: kind === 'skill' ? 'skill' : 'command',
        source: kind === 'native' ? t('插件命令') : t('插件'),
        path,
        ...(kind === 'native' ? { native: true } : {}),
      },
    ]
  })
}

// 问一次要起一个 CLI 进程（Pi 还要加载插件，几秒）：同一个目录、同样的信任选择 5 分钟内用上次的；装删插件后清掉
const cache = new Map<string, { at: number; list: Promise<QueriedCommand[]> }>()
const TTL = 5 * 60_000
export const clearQueriedCommands = () => cache.clear()

/** 问 CLI：没写 commandsQuery 的 CLI、起不来、超时都当没有（「/」菜单照常列扫到的） */
export async function queryCliCommands(cli: string, cwd: string, trust?: TrustChoice): Promise<QueriedCommand[]> {
  const key = `${cli}\n${cwd}\n${trust ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.list
  const list = ask(cli, cwd, trust)
  cache.set(key, { at: Date.now(), list })
  list.catch(() => cache.delete(key))
  return list
}

async function ask(cli: string, cwd: string, trust?: TrustChoice): Promise<QueriedCommand[]> {
  const def = getCli(cli)
  const q = def?.rpc?.commandsQuery as CommandsQuery | undefined
  if (!def || !q) return []
  const s = cliSettings(await getSettings(), cli)
  const args = buildFromRules(q.args, { model: '', permission: '', extraArgs: [], trust, options: s.options })
  const r = await rpcQuery({
    command: s.command,
    args,
    cwd: cwd || homedir(),
    env: childEnv(s.env),
    handshake: [],
    requests: [{ ...q.request, timeoutMs: q.timeoutMs }],
    timeoutMs: q.timeoutMs,
  })
  return parseQueried(q, r[0])
}
