import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS } from '../../shared/clis.ts'
import { trustDirs } from '../../shared/cli/trust.ts'

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

/**
 * 项目信任的提示（ADR 0050）：项目里有没有「CLI 只在信任后才读」的文件。
 * markers 只看项目目录；upMarkers 往上找到仓库根目录（有 .git 的那层）为止，主目录不算（那是用户级的，不用信任）。
 * 返回 CLI id → 找到的标记（项目目录里的写相对路径，上级目录里的写全），没找到的 CLI 不列
 */
export async function trustMarkers(dir: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  if (!dir || !(await exists(dir))) return out
  const root = path.resolve(dir)
  const home = path.resolve(homedir())
  const up: string[] = []
  for (const d of trustDirs(root)) {
    if (d === home) break
    up.push(d)
    if (await exists(path.join(d, '.git'))) break
  }
  for (const def of CLIS) {
    if (!def.trust) continue
    const found: string[] = []
    for (const m of def.trust.markers) if (await exists(path.join(root, m))) found.push(m)
    for (const d of up)
      for (const m of def.trust.upMarkers)
        if (await exists(path.join(d, m))) found.push(d === root ? m : path.join(d, m))
    if (found.length) out[def.id] = found
  }
  return out
}

export function trustApi(deps: { projectPath: (id: string) => Promise<string> }) {
  return new Hono().get('/:id', async (c) => c.json(await trustMarkers(await deps.projectPath(c.req.param('id')))))
}
