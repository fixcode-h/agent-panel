/**
 * 面板要用的本机程序没装时的提醒（server/local-programs/offers.ts）：先取一次，之后跟着推送的 local-programs 事件走，不轮询。
 * 演示版没有推送通道：演示后端在页面里发同名的窗口事件（web/src/lib/demo/demo-local-programs.ts）
 */
import { useEffect, useState } from 'react'
import { localProgramsContract as C } from '@shared/api-contract/local-programs'
import type { ProgramOffer } from '@shared/local-programs/defs'
import { call } from '@/lib/api/call'
import { openPageStream } from './page-stream'

const demo = !!import.meta.env.VITE_DEMO
export const DEMO_LOCAL_PROGRAMS_EVENT = 'agent-panel:local-programs'

export function useProgramOffers() {
  const [offers, setOffers] = useState<ProgramOffer[]>([])
  useEffect(() => {
    let alive = true
    const take = (list: ProgramOffer[]) => alive && setOffers(list)
    call(C.offers)
      .then((r) => take(r.offers))
      .catch(() => undefined)
    if (demo) {
      const h = (e: Event) => take((e as CustomEvent<{ offers: ProgramOffer[] }>).detail.offers)
      window.addEventListener(DEMO_LOCAL_PROGRAMS_EVENT, h)
      return () => {
        alive = false
        window.removeEventListener(DEMO_LOCAL_PROGRAMS_EVENT, h)
      }
    }
    const stream = openPageStream()
    stream.on('local-programs', (e) => {
      try {
        take((JSON.parse(e.data) as { offers: ProgramOffer[] }).offers)
      } catch {
        // 坏的一条推送不影响下一条
      }
    })
    return () => {
      alive = false
      stream.close()
    }
  }, [])
  return [offers, setOffers] as const
}
