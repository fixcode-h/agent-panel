/**
 * 演示：本机程序没装的提醒（输入框上方的「安装 / 拒绝」卡片）。演示里电脑上什么都有，平时不弹；
 * 地址里带 missing=rg（例如 ?missing=rg#/chat/…）时假装没装 rg，点安装照真的开一条后台作业，走两步后装好、卡片消失
 */
import { localProgram, type ProgramOffer } from '@shared/local-programs/defs'
import { DEMO_LOCAL_PROGRAMS_EVENT } from '@/lib/live/local-programs'
import { demoStartJob } from './demo-bg-jobs'
import { fail } from './demo-http'

let offers: ProgramOffer[] | undefined // 模块状态：演示的提醒只在这一页里

const emit = () =>
  window.dispatchEvent(new CustomEvent(DEMO_LOCAL_PROGRAMS_EVENT, { detail: { offers: offers ?? [] } }))

function initial(): ProgramOffer[] {
  const want = new URLSearchParams(window.location.search).getAll('missing')
  return want.flatMap((id) => {
    const def = localProgram(id)
    if (!def) return []
    return [{ id, name: def.name, why: def.why, installHint: def.install.win32 ?? '', canInstall: true }]
  })
}

export function demoLocalPrograms(method: string, id: string | undefined, sub: string | undefined) {
  offers ??= initial()
  if (method === 'GET') return { offers }
  const o = offers.find((x) => x.id === id)
  if (!o) return fail('没有这个程序', 404)
  if (sub === 'decline') offers = offers.filter((x) => x.id !== id)
  if (sub === 'install') {
    const job = demoStartJob({ id: `demo-install-${o.id}`, source: 'panel', kind: 'install', title: `安装 ${o.name}` })
    o.jobId = `demo-install-${o.id}`
    delete o.error
    job.step('winget install --id BurntSushi.ripgrep.MSVC -e --silent')
    setTimeout(() => job.step('刷新 PATH，确认 rg 能用'), 1500)
    setTimeout(() => {
      job.end(true)
      offers = (offers ?? []).filter((x) => x.id !== id)
      emit()
    }, 3000)
  }
  emit()
  return { offers }
}
