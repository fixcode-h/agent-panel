import { readdirSync } from 'node:fs'
import path from 'node:path'
import { checkOutput, type HookDef, type HookInput, type HooksData } from '../../shared/hook-defs.ts'
import { t } from '../../shared/i18n.ts'
import { pluginEnabled } from '../../shared/plugins/index.ts'
import { pluginItemId, setProjectProbe } from '../../shared/plugins/contrib.ts'
import { matchesGlob } from '../../shared/test-steps.ts'
import { runCommand, type HookRun } from '../hooks/run.ts'
import { installedList } from './manager.ts'
import { runningPlugin } from './runtime.ts'

/**
 * 插件清单的钩子、测试步骤、「/」命令接进面板（插件接口 3，格式见 shared/plugins/contrib-schema.ts）。
 * 都按「现在开着的插件」现取：关掉、删除插件后下一次取就没有了，不用另外撤。
 * 测试步骤的现取在 shared/plugins/contrib.ts（前后端共用），这里只注入「项目根有没有这类文件」的探测
 */

/** 包里的相对路径换成绝对路径；跑出包外的（../、绝对路径）不认 */
function inPackage(dir: string, rel: string) {
  const abs = path.resolve(dir, rel)
  const r = path.relative(dir, abs)
  return !r || r.startsWith('..') || path.isAbsolute(r) ? '' : abs
}

// 项目根目录的文件名：每轮拼提示词、每次守卫都会问，同一个目录 30 秒内用上次读的
const rootNames = new Map<string, { at: number; names: string[] }>()
setProjectProbe((dir, globs) => {
  let hit = rootNames.get(dir)
  if (!hit || Date.now() - hit.at > 30_000) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      // 目录读不到（被删、没权限）：当作没有，插件步骤不往这个项目里加
    }
    hit = { at: Date.now(), names }
    rootNames.set(dir, hit)
  }
  return hit.names.some((n) => globs.some((g) => matchesGlob(n, g)))
})

/** 插件钩子：用户钩子的形状加上它从哪个插件来、跑包里哪个脚本（空 = 交给服务端入口的 hook()） */
export interface PluginHookDef extends HookDef {
  plugin: { id: string; name: string; localId: string; file: string }
}
export const isPluginHook = (h: HookDef): h is PluginHookDef => 'plugin' in h

/**
 * 开着的插件带的钩子，换成用户钩子的形状交给 dispatch：范围不限（项目、角色、CLI 全部），
 * 开关记在 hooks.json 的 builtins 里（键是 plugin:<插件>:<钩子>，默认开，只记关掉的）
 */
export function activePluginHooks(data: Pick<HooksData, 'builtins'>): PluginHookDef[] {
  return installedList()
    .filter((p) => pluginEnabled(p.manifest.id))
    .flatMap((p) =>
      p.manifest.hooks.map((h): PluginHookDef => {
        const id = pluginItemId(p.manifest.id, h.id)
        return {
          id,
          name: h.name,
          description: h.description,
          event: h.event,
          scope: { projects: [], agents: [], clis: [] },
          match: h.match,
          // 形状上要有 action：插件钩子不走 runHook，这里的值不会被用到
          action: { type: 'command', script: '' },
          timeoutSec: h.timeoutSec,
          onError: h.onError,
          enabled: data.builtins[id] ?? true,
          createdBy: 'user',
          updatedAt: '',
          plugin: {
            id: p.manifest.id,
            name: p.manifest.name,
            localId: h.id,
            file: h.script ? inPackage(p.dir, h.script) || '-' : '',
          },
        }
      }),
    )
}

/** 跑一个插件钩子：包里的脚本和用户脚本钩子一样跑；没有脚本的调服务端入口的 hook()，超时按钩子写的秒数 */
export async function runPluginHook(def: PluginHookDef, input: HookInput, cwd: string): Promise<HookRun> {
  const t0 = Date.now()
  const timeoutMs = def.timeoutSec * 1000
  let r: { text: string; error?: string }
  if (def.plugin.file === '-') r = { text: '', error: t('脚本不在插件包里') }
  else if (def.plugin.file) r = await runCommand(def.plugin.file, input, cwd, timeoutMs)
  else {
    const fn = runningPlugin(def.plugin.id)?.hook
    if (!fn) r = { text: '', error: t('插件没在运行，或者服务端入口没有 hook()') }
    else {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const out = await Promise.race([
          Promise.resolve(fn(def.plugin.localId, input)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(t('超过 {n} 秒没跑完', { n: def.timeoutSec }))), timeoutMs)
          }),
        ])
        r = { text: out === undefined || out === null ? '' : JSON.stringify(out) }
      } catch (e) {
        r = { text: '', error: (e as Error).message }
      } finally {
        clearTimeout(timer)
      }
    }
  }
  const ms = Date.now() - t0
  if (r.error) return { error: r.error, ms }
  let parsed: unknown
  try {
    parsed = r.text.trim() ? JSON.parse(r.text) : undefined
  } catch {
    return { error: t('输出不是 JSON：{text}', { text: r.text.slice(0, 200) }), ms }
  }
  const c = checkOutput(def.event, parsed)
  return 'error' in c ? { error: c.error, ms } : { out: c.out, ms }
}

/** 开着的插件带的「/」命令：md 在包里，对所有 CLI 都由面板展开（和「所有 Agent」的命令一样） */
export function pluginCommands() {
  return installedList()
    .filter((p) => pluginEnabled(p.manifest.id))
    .flatMap((p) =>
      p.manifest.commands.flatMap((c) => {
        const file = inPackage(p.dir, c.file)
        if (!file) return []
        return [
          {
            name: c.name,
            description: c.description ? t(c.description) : '',
            kind: 'command' as const,
            source: t('插件 · {name}', { name: p.manifest.name }),
            ...(c.hint ? { hint: t(c.hint) } : {}),
            path: file,
          },
        ]
      }),
    )
}
