import type { CliEvent } from '../parsers.ts'

/** 进程的 stdin：写一行 JSON，或者关掉让它退出 */
export interface RpcIo {
  write: (s: string) => void
  end: () => void
}

export interface RpcRequestOptions {
  /** 等多久没有回复算失败；不写用默认值 */
  timeoutMs?: number
  /** 请求 id 放在哪个字段（Claude Code 用 request_id） */
  idField?: string
  /** 指定 id；不写时自动编号 */
  id?: string | number
}

/** 适配器能用的东西：发消息、发请求、出事件、结束这一轮 */
export interface RpcContext {
  readonly cwd: string
  readonly input: string
  readonly images: string[]
  readonly finished: boolean
  /** 发一条记录，不关心回复 */
  send: (record: Record<string, unknown>) => void
  /** 发一条请求并等对应的回复；回复里的 error 原样返回给调用方判断 */
  request: (record: Record<string, unknown>, options?: RpcRequestOptions) => Promise<any>
  /** 交给面板的事件 */
  emit: (event: CliEvent | CliEvent[]) => void
  /**
   * 这一轮结束：先给面板结果，再关 stdin 让 CLI 退出。
   * 面板还可能接着用这个进程（保活）时不关，返回 true；这时别再发退出消息
   */
  finish: (ok: boolean, error?: string, delayMs?: number) => Promise<boolean>
  /** 取消已经排好的关闭（例如插话后 CLI 还在接着输出） */
  hold: () => void
}

/**
 * 各家 CLI 的差异都在这里：握手和开一轮怎么写、收到什么算结束、插话和中断发什么。
 * 传输、请求/回复配对、超时和收尾由统一的会话引擎负责。
 */
export interface RpcAdapter {
  /** 进程起来后：握手、开会话、把任务交给它 */
  start: (ctx: RpcContext) => void | Promise<void>
  /** 不是回复、也不是服务端请求的记录（事件、通知） */
  message: (ctx: RpcContext, msg: any) => void
  /** 服务端发来的请求（例如审批）；不实现时回「不支持」 */
  request?: (ctx: RpcContext, msg: any) => void
  /**
   * 在同一个进程里开下一轮。面板保活时，用户的下一条消息直接交给它，不用重启 CLI 再 --resume。
   * 不实现的 CLI 一轮结束后进程就退出（保活对它们不生效）
   */
  next?: (ctx: RpcContext, input: string) => void | Promise<void>
  /** 让 CLI 结束会话、退出进程；不实现时由会话引擎关 stdin */
  exit?: (ctx: RpcContext) => void
  /** 执行中插话；返回是否交给了 CLI */
  steer: (ctx: RpcContext, text: string) => Promise<boolean>
  /**
   * 插话还排着、命令跑太久时让 CLI 马上处理：停下正在执行的命令，把排着的插话作为新的一句交给它（前面加上 note）。
   * 返回是否这样做了；插话已经被取走、或 CLI 没有这种办法时返回 false
   */
  redirect?: (ctx: RpcContext, note: string) => Promise<boolean>
  /** 中断这一轮；返回是否发出去了 */
  interrupt: (ctx: RpcContext) => boolean
  /** 进程结束前的清理 */
  close?: (ctx: RpcContext) => void
  /** 回复和请求的 id 怎么取；默认 msg.id */
  correlate?: (msg: any) => string | number | undefined
  /** 是不是服务端发来的请求；默认有 id 和 method */
  isRequest?: (msg: any) => boolean
}
