import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { registerCliSpecs } from '../shared/clis.ts'

/**
 * 用户自己加的 CLI：数据目录 config/clis/ 下每个 .json 是一份 CLI 配置（格式见 docs/cli-config.md），
 * 启动时读进注册表，不用改代码。server/index.ts 在语言之后、其他模块之前引入这里，后面用到 CLI 列表的地方都看得到。
 */
export const CLI_CONFIG_DIR = path.join(
  process.env.AGENT_PANEL_DATA ?? path.join(homedir(), '.agent-panel'),
  'config',
  'clis',
)

/** 读到的配置原文（页面也要注册一遍）和读不进来的原因 */
let loaded: { specs: unknown[]; errors: string[] } = { specs: [], errors: [] }

export function loadUserClis() {
  const specs: unknown[] = []
  const errors: string[] = []
  if (existsSync(CLI_CONFIG_DIR))
    for (const f of readdirSync(CLI_CONFIG_DIR)
      .filter((x) => x.endsWith('.json'))
      .sort()) {
      try {
        specs.push(JSON.parse(readFileSync(path.join(CLI_CONFIG_DIR, f), 'utf8')))
      } catch (e) {
        errors.push(`${f}：${(e as Error).message}`)
      }
    }
  const bad = registerCliSpecs(specs)
  // 加不进来的不交给页面，免得页面上注册出一个坏的
  const ok = specs.filter((s) => !bad.some((b) => b.startsWith(`${(s as { id?: string })?.id ?? '?'}：`)))
  loaded = { specs: ok, errors: [...errors, ...bad] }
  if (loaded.errors.length) console.error(`读取 CLI 配置出错：\n${loaded.errors.join('\n')}`)
  return loaded
}

export const userClis = () => ({ ...loaded, dir: CLI_CONFIG_DIR })

loadUserClis()
