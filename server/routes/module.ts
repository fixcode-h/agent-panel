import type { Hono } from 'hono'

/**
 * 一组接口的导出约定：挂在 prefix 下的 Hono 子应用（server/index.ts 的 app 已经带着 /api 前缀）。
 * 新接口写成返回 Hono 的工厂，在 server/routes/modules.ts 的清单里按位置登记一行，不在 server/index.ts 里直接 app.route。
 * 同一个 prefix 可以有好几组（/clis、/tasks、/app）：Hono 按登记顺序匹配，清单的顺序就是挂载顺序，不能随手调换
 */
export interface ApiModule {
  prefix: string
  // oxlint-disable-next-line typescript/no-explicit-any -- 各组子应用带着各自的环境类型，这里只管挂载
  app: Hono<any, any, any>
}

/** 按清单顺序挂上每一组接口 */
// oxlint-disable-next-line typescript/no-explicit-any -- 主应用的 Hono 带着 basePath 的类型参数
export function mountModules(app: Hono<any, any, any>, modules: readonly ApiModule[]) {
  for (const m of modules) app.route(m.prefix, m.app)
}
