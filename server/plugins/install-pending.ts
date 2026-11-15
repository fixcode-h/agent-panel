import { randomUUID } from 'node:crypto'
import type { ConfigFinding } from '../../shared/config-scan/index.ts'
import type { PluginManifest, PluginSource } from '../../shared/plugins/types.ts'
import { scanBuffers, scanPath, visibleFindings } from '../config-scan.ts'
import { findInstalled } from './manager.ts'
import { requiresPlan } from './requires-install.ts'
import type { ZipEntry } from './zip.ts'

/**
 * 等用户确认的安装（ADR 0059）：预览时下载好、校验过，确认后直接写盘；十分钟没确认就丢掉。
 * 市场、压缩包、本机目录、GitHub 链接包装（wrap/）四种来源共用这一处，确认都走 /api/plugins/install/confirm
 */
export interface Pending {
  manifest: PluginManifest
  source: PluginSource
  files?: ZipEntry[]
  root?: string
  /** 链接本机目录 */
  dir?: string
  /** 写进临时目录后、换上去之前要做的事（包装插件的安装动作）；失败整个安装作废 */
  prepare?: (dir: string) => Promise<void>
  at: number
}
const pending = new Map<string, Pending>() // 模块状态：会话，跟着进程或连接一起没
const PENDING_MS = 10 * 60_000

/** 取出并删掉等确认的安装；过期或不存在返回 undefined */
export function takePending(token: string | undefined) {
  const p = token ? pending.get(token) : undefined
  if (p) pending.delete(token!)
  return p
}

/**
 * 记下等确认的安装，返回给弹窗的预览。顺便做配置安全扫描（借鉴 ECC 的 AgentShield）：包里的技能、钩子脚本、
 * 服务端代码有没有提示注入、外传、危险命令、密钥；弹窗里列出来，有高级的要用户勾选「我看过了」才能装。
 * extraFindings：来源自己的扫描（包装专用规则），和通用扫描合在一起、同样能点「这条没问题」
 */
export async function stash(p: Omit<Pending, 'at'>, extraFindings: ConfigFinding[] = []) {
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k)
  const token = randomUUID()
  pending.set(token, { ...p, at: Date.now() })
  const cur = findInstalled(p.manifest.id)
  const scope = `plugin:${p.manifest.id}`
  const scan = p.dir
    ? await scanPath(p.dir, scope)
    : await visibleFindings(
        [
          ...scanBuffers(
            (p.files ?? [])
              .filter((f) => f.name.startsWith(p.root ?? '') && !f.name.endsWith('/'))
              .map((f) => ({ rel: f.name.slice((p.root ?? '').length), data: f.data })),
          ),
          ...extraFindings,
        ],
        scope,
      )
  return {
    token,
    // 要一起装的依赖插件（插件接口 10）：市场里找不到、版本不够时这里就报错，不等用户点确认
    requires: await requiresPlan(p.manifest, p.source),
    manifest: p.manifest,
    hasCode: !!(p.manifest.server || p.manifest.web || p.manifest.hooks.some((h) => h.script)),
    installed: cur ? { version: cur.manifest.version, source: cur.source } : null,
    scan,
    scanScope: scope,
  }
}
