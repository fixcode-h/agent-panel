import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { registerCliSpecs } from '../shared/clis.ts'
import { t } from '../shared/i18n.ts'

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
  const files: string[] = []
  const errors: string[] = []
  // 读不进来的文件跳过，其他照常注册；原因带上文件名，用户知道去改哪一份
  const skip = (f: string, why: string) => errors.push(t('{f} 已跳过：{why}', { f, why }))
  if (existsSync(CLI_CONFIG_DIR))
    for (const f of readdirSync(CLI_CONFIG_DIR)
      .filter((x) => x.endsWith('.json'))
      .sort()) {
      try {
        specs.push(JSON.parse(readFileSync(path.join(CLI_CONFIG_DIR, f), 'utf8')))
        files.push(f)
      } catch (e) {
        skip(f, (e as Error).message)
      }
    }
  const bad = registerCliSpecs(specs)
  for (const b of bad) skip(files[b.index], b.error)
  // 加不进来的不交给页面，免得页面上注册出一个坏的
  const ok = specs.filter((_, i) => !bad.some((b) => b.index === i))
  loaded = { specs: ok, errors }
  if (errors.length) console.warn(`${t('CLI 配置有问题')}（${CLI_CONFIG_DIR}）：\n${errors.join('\n')}`)
  return loaded
}

export const userClis = () => ({ ...loaded, dir: CLI_CONFIG_DIR })

loadUserClis()
