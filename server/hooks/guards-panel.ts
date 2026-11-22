import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HookFacts } from '../../shared/hooks/index.ts'
import { DATA_DIR } from '../store.ts'

/**
 * 面板自己的文件守卫：Agent 读写面板的源码、数据目录里的设置和对话记录时拦下。
 * 实跑 2026-11-22（DeepSeek V4.1 Flash）：交修复被面板拒了一次，它没有结束这一轮，而是翻了 25 分钟面板源码、
 * 读数据目录里的任务 JSON 去推面板怎么核对；数据目录的 settings.json 里还存着接口密钥。
 * 面板的行为以工具返回的说明为准，Agent 用不着读面板实现。项目本身就是面板仓库（拿面板开发面板）时不拦
 */

declare const __APP_VERSION__: string | undefined
/** 面板程序目录：开发时是仓库根，出包后是解压目录（server.mjs 所在），和 server/log.ts 的 programDir 一样认 */
const PANEL_ROOT =
  process.env.AGENT_PANEL_APP_DIR ??
  (typeof __APP_VERSION__ === 'string'
    ? path.dirname(fileURLToPath(import.meta.url))
    : path.resolve(import.meta.dirname, '..', '..'))
/** 程序目录里算「面板实现」的部分：Skill、插件这些是交给 Agent 读的，不拦 */
const PANEL_CODE = ['server', 'shared', 'web', 'scripts', 'server.mjs']
/**
 * 数据目录里不该让 Agent 碰的：设置（含接口密钥）、令牌、配置、对话和项目记录、备份。
 * 独立分支（worktrees）、对话目录（tasks/files）、交接文件（tasks/handoff）、运行时 Skill 是给 Agent 用的，不在这里
 */
const DATA_PRIVATE = [
  'settings.json',
  'access-token',
  'bridge-token',
  'config',
  'projects',
  'tasks/projects',
  'tasks/tasks.json',
  'chats',
  'backup',
  'trash',
]

const inside = (dir: string, p: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(p))
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
const slash = (p: string) => p.replace(/\\/g, '/').toLowerCase()

export interface PanelRoots {
  panel: string
  data: string
}
const ROOTS: PanelRoots = { panel: PANEL_ROOT, data: DATA_DIR }

/** 这个路径是不是面板自己的（实现或私有数据）；不是返回空串，是返回给模型看的说法。code 为假时不看源码 */
function panelKind(p: string, roots: PanelRoots, code: boolean): string {
  if (code && PANEL_CODE.some((x) => inside(path.join(roots.panel, x), p))) return '面板的源码'
  if (DATA_PRIVATE.some((x) => inside(path.join(roots.data, x), p))) return '面板数据目录里的设置和对话记录'
  return ''
}

/** 命令里写到的面板路径：按绝对路径前缀找（斜杠、大小写都不论），找到返回那一类 */
function shellKind(command: string, roots: PanelRoots, code: boolean): string {
  const cmd = slash(command)
  const hit = (base: string, list: string[]) => list.some((x) => cmd.includes(slash(path.join(base, x))))
  if (code && hit(roots.panel, PANEL_CODE)) return '面板的源码'
  if (hit(roots.data, DATA_PRIVATE)) return '面板数据目录里的设置和对话记录'
  return ''
}

export function panelFilesDeny(
  c: { cwd: string; projectPath?: string },
  facts: HookFacts,
  roots: PanelRoots = ROOTS,
): string {
  const tool = facts.tool
  if (!tool) return ''
  // 拿面板开发面板：项目和程序目录互相包含时，源码就是项目文件，只拦数据目录
  const proj = c.projectPath || c.cwd
  const code = !(inside(roots.panel, proj) || inside(proj, roots.panel))
  let kind = ''
  if (tool.kind === 'shell') kind = shellKind(String(tool.input.command ?? ''), roots, code)
  else if (tool.kind === 'read' || tool.kind === 'edit') {
    const paths = (tool.paths.length ? tool.paths : [tool.path]).filter(Boolean)
    for (const p of paths) {
      kind = panelKind(path.resolve(c.cwd, p), roots, code)
      if (kind) break
    }
  }
  if (!kind) return ''
  return `【面板】这是${kind}，不是这个项目的文件，不要读也不要改。面板怎么核对、为什么拒绝，以工具返回的说明为准：照返回里写的下一步做；看不懂或做不到就结束这一轮，把情况告诉用户。`
}
