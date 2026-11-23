/**
 * 后台作业的 HTTP 接口（契约在 shared/api-contract/bg-jobs.ts）：侧栏底部的作业列表
 */
import { Hono } from 'hono'
import { bgJobsContract as C } from '../../shared/api-contract/bg-jobs.ts'
import { t } from '../../shared/i18n.ts'
import { cancelJob, clearEnded, jobLog, listJobs } from './registry.ts'

const why = (code: string) =>
  ({
    'not-found': t('没有这条作业（可能面板重启过）'),
    ended: t('这条作业已经结束了'),
    'not-cancelable': t('这条作业不能取消'),
  })[code] ?? code

export function bgJobsApi() {
  const app = new Hono()
  app.get(C.list.path, (c) => c.json({ jobs: listJobs() }))
  app.get(C.log.path, (c) => {
    const r = jobLog(c.req.param('id'), Number(c.req.query('from') ?? 0) || 0)
    return r ? c.json(r) : c.json({ error: why('not-found') }, 404)
  })
  app.post(C.cancel.path, async (c) => {
    const r = await cancelJob(c.req.param('id'))
    return c.json(r.ok ? r : { ok: false, info: why(r.info) })
  })
  app.post(C.clear.path, (c) => {
    clearEnded()
    return c.json({ jobs: listJobs() })
  })
  return app
}
