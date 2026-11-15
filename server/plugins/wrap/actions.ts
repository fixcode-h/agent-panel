import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WrapAction } from '../../../shared/plugins/wrap/recipe.ts'
import { childEnv, exitReason, runProcess, stderrTail } from '../../exec/process.ts'
import { readZip, safeRel } from '../zip.ts'
import { downloadAsset } from './fetch.ts'

/**
 * 安装动作白名单的执行（ADR 0068，设计稿 7.2 第 3 条）：用户在预览里点了「包装并安装」之后，
 * 在插件包的临时目录里（还没换上去）依次做。只有这几种，配方写不出别的；任何一步失败整个安装作废，旧版本不受影响。
 * 子进程用 childEnv（不带面板设置里的变量），工作目录限定在包目录里。
 */

const TIMEOUT_MS = 10 * 60_000
const isWin = process.platform === 'win32'

async function run(command: string, args: string[], cwd: string, extra: Record<string, string> = {}) {
  const env = childEnv(Object.entries(extra).map(([key, value]) => ({ key, value })))
  const r = await runProcess({ command, args, cwd, env, timeoutMs: TIMEOUT_MS })
  if (r.spawnError) throw new Error(`没能运行 ${command}：${r.spawnError}（要先装好它）`)
  if (r.code !== 0)
    throw new Error(
      `${[command, ...args].join(' ')} 失败（${exitReason(r)}）：${stderrTail(r.stderr, 8) || '没有输出'}`,
    )
}

/** 包目录里的子目录：配方里的路径已经校验过，这里再防一次越界 */
function inside(root: string, rel: string) {
  if (rel === '.') return root
  if (!safeRel(rel)) throw new Error(`安装动作的目录不对：${rel}`)
  return path.join(root, ...rel.split('/'))
}

/** npm 装依赖：有锁文件用 ci（版本完全按锁文件），没有用 install；都不跑上游的安装钩子 */
async function npmDeps(dir: string) {
  const lock = existsSync(path.join(dir, 'package-lock.json')) || existsSync(path.join(dir, 'npm-shrinkwrap.json'))
  await run('npm', [lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], dir)
}

/** Release 附件：zip 解开，tar 包交给系统的 tar（Windows 10 起自带），其余当单个可执行文件 */
async function placeAsset(buf: Buffer, name: string, dest: string) {
  await mkdir(dest, { recursive: true })
  if (/\.zip$/i.test(name)) {
    for (const f of readZip(buf)) {
      if (!safeRel(f.name)) continue
      const full = path.join(dest, ...f.name.split('/'))
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, f.data, { mode: 0o755 })
    }
    return
  }
  if (/\.(?:tar\.gz|tgz|tar\.xz|tar)$/i.test(name)) {
    const tmp = path.join(dest, `.download-${Date.now()}`)
    await writeFile(tmp, buf)
    await run('tar', ['-xf', tmp, '-C', dest], dest)
    await rm(tmp, { force: true })
    // 解出来的单个顶层目录里的可执行文件挪不挪交给 PATH：配方的 path 写到具体子目录
    return
  }
  const file = path.join(dest, name.replace(/[\\/]/g, '_'))
  await writeFile(file, buf)
  if (!isWin) await chmod(file, 0o755)
}

/** 依次执行安装动作；repo 用来下载 Release 附件 */
export async function runActions(dir: string, repo: string, actions: WrapAction[]) {
  for (const a of actions) {
    if (a.kind === 'npm-ci') await npmDeps(inside(dir, a.dir))
    else if (a.kind === 'npm-package') await npmDeps(inside(dir, 'cli'))
    else if (a.kind === 'uv-tool') {
      const tools = path.join(dir, '.tools')
      await run('uv', ['tool', 'install', `${a.package}==${a.version}`], dir, {
        UV_TOOL_DIR: tools,
        UV_TOOL_BIN_DIR: path.join(tools, 'bin'),
      })
    } else if (a.kind === 'release-asset')
      await placeAsset(await downloadAsset(repo, a.tag, a.asset, a.sha256), a.asset, inside(dir, a.to))
    else await run('npm', ['run', a.script], inside(dir, a.dir))
  }
}
