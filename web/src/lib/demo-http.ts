/** 演示后端的报错和入参校验：和正式后端一样带状态码（409 表示「现在不能做」），demo-*.ts 共用 */
import { z } from 'zod'

class HttpError extends Error {
  constructor(
    message: string,
    /** 状态码：正式后端用 409 表示「现在不能做」，界面按它区分提示（见 api.ts 的 err.status） */
    readonly status = 400,
  ) {
    super(message)
  }
}
export const fail = (msg: string, status = 400): never => {
  throw new HttpError(msg, status)
}

export function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const p = schema.safeParse(body)
  if (!p.success) fail(z.prettifyError(p.error))
  return p.data as z.infer<S>
}
