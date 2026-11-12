import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { rgConfigLines } from '../../shared/search-exclude.ts'
import { log } from '../log.ts'
import { CACHE_DIR, writeFileOnce } from '../store.ts'
import type { RealContext } from './real-context.ts'

/**
 * 搜索排除交给 rg 自己执行：大项目（尤其 P4 这种没有 .gitignore 的）只靠提示词时，
 * Agent 跑的 rg 照样扫进 Intermediate、Saved 这些产物目录，一次搜几分钟。
 * 写一份 ripgrep 配置、用 RIPGREP_CONFIG_PATH 指过去；用户本来设了的，把原来的内容放在前面一起带上。
 * 新版 Claude Code（原生安装）没有单独的搜索工具，搜索走命令行里的 rg（它自带的那份也读这个配置，2.1.322 实测）；
 * 它自己的 grep（ugrep）、find（bfs）不读，所以提示词和长命令守卫让它用 rg（shared/engine/prompt-parts.ts、shared/wide-search.ts）
 */
export async function searchExcludeEnv(ctx: RealContext): Promise<{ key: string; value: string }[]> {
  const lines = rgConfigLines(ctx.project, { onlyProject: ctx.isGit })
  const own = process.env.RIPGREP_CONFIG_PATH
  const prev = own ? await readFile(own, 'utf8').catch(() => '') : ''
  const body = [prev.trimEnd(), ...lines].filter(Boolean).join('\n') + '\n'
  // 按内容起名、已有就不再写：并行的几个 Agent 同时启动时，rg 不会读到写了一半的文件
  const file = path.join(CACHE_DIR, 'rg', `${createHash('sha1').update(body).digest('hex').slice(0, 16)}.rc`)
  try {
    await writeFileOnce(file, body)
  } catch (e) {
    log.warn('agent', '写搜索排除配置失败', e)
    return []
  }
  return [{ key: 'RIPGREP_CONFIG_PATH', value: file }]
}
