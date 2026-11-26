/**
 * 本机程序提醒的 HTTP 接口（契约 shared/api-contract/local-programs.ts）：输入框上方的「安装 / 拒绝」卡片
 */
import { Hono } from 'hono'
import { localProgramsContract as C } from '../../shared/api-contract/local-programs.ts'
import { installProgram } from './install.ts'
import { declineOffer, listOffers } from './offers.ts'

export function localProgramsApi() {
  const app = new Hono()
  app.get(C.offers.path, (c) => c.json({ offers: listOffers() }))
  app.post(C.install.path, (c) => {
    const error = installProgram(c.req.param('id'))
    return error ? c.json({ error }, 400) : c.json({ offers: listOffers() })
  })
  app.post(C.decline.path, (c) => {
    declineOffer(c.req.param('id'))
    return c.json({ offers: listOffers() })
  })
  return app
}
