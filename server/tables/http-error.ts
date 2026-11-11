/** 表格接口的错误：带 HTTP 状态码，信息直接给用户看 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}
