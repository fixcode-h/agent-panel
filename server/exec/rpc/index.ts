import type { BuildOptions, CliDefinition } from '../../../shared/clis.ts'
import { RpcSpec } from '../../../shared/cli-spec.ts'
import { t } from '../../../shared/i18n.ts'
import { parserFor, type CliEvent } from '../parsers.ts'
import { claudeAdapter } from './claude.ts'
import { codexAdapter } from './codex.ts'
import { createRpcSession, type RpcSession } from './session.ts'
import { createSpecAdapter } from './spec.ts'

export interface RpcRunOptions {
  cwd: string
  input: string
  images?: string[]
  build: BuildOptions
  onEvent: (e: CliEvent) => void
  /** 保活：一轮结束后留住进程等用户下一句（返回下一句，null 表示结束进程） */
  hold?: () => boolean
  next?: () => Promise<string | null>
  /** 模型这一轮已经自己等过下一句了：结束时不再保活 */
  waited?: () => boolean
}

/** 按 CLI 定义里的 rpc 配置选适配器；传输、请求配对和收尾由同一个会话引擎负责 */
export function rpcSessionFor(def: CliDefinition, o: RpcRunOptions): RpcSession {
  const rpc = def.rpc ? RpcSpec.parse(def.rpc) : undefined
  if (!rpc) throw new Error(t('{cli} 没有配置 RPC 协议', { cli: def.name }))
  const parser = parserFor(def.id, o.cwd)
  const adapter =
    rpc.kind === 'codex'
      ? codexAdapter({ ...o.build, cwd: o.cwd, input: o.input, images: o.images })
      : rpc.kind === 'claude'
        ? claudeAdapter({ cwd: o.cwd, input: o.input, images: o.images, parse: parser })
        : createSpecAdapter(rpc, {
            parser,
            cwd: o.cwd,
            input: o.input,
            model: o.build.model,
            effort: o.build.effort,
            maxTurns: (o.build.maxTurns ?? rpc.defaultMaxTurns) || undefined,
            resume: o.build.resume,
            fork: !!o.build.fork,
            images: o.images,
          })
  return createRpcSession({
    adapter,
    cwd: o.cwd,
    input: o.input,
    images: o.images,
    onEvent: o.onEvent,
    hold: o.hold,
    next: o.next,
    waited: o.waited,
  })
}
