import { useEffect, useState } from 'react'
import { Eraser } from 'lucide-react'
import { memoContract as C, type MemoOverview } from '@shared/api-contract/memo'
import { t } from '@shared/i18n'
import { call } from '@/lib/api/call'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * 设置 →「数据」里的「缓存」（ADR 0074）：面板和插件算出来记住的东西（类表、头文件、UnLua 识别……）每份一行、各几项，
 * 依赖的文件改了会自己重算；看着不对时可以单独清空或全部清空，下次用到重算。只在内存里，不占磁盘
 */
export function MemoData() {
  const [data, setData] = useState<MemoOverview>()
  useEffect(() => {
    call(C.overview)
      .then(setData)
      .catch((e) => toast.error((e as Error).message))
  }, [])

  const clear = async (name?: string) => {
    try {
      setData(await call(C.clear, { body: name ? { name } : {} }))
      toast.success(name ? t('已清空，下次用到时重算') : t('已清空全部缓存，下次用到时重算'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!data?.caches.length) return null
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-body font-semibold">{t('内存缓存')}</h3>
        <span className="text-xs text-subtle">
          {t('{n} 份，盯着 {w} 个目录；依赖的文件改了会自己重算', { n: data.caches.length, w: data.watches })}
        </span>
        <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={() => clear()}>
          <Eraser className="h-3.5 w-3.5" />
          {t('全部清空')}
        </Button>
      </div>
      <Card className="overflow-hidden">
        {data.caches.map((m) => (
          <div key={m.name} className="flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0">
            <span className="min-w-0 flex-1 truncate font-mono text-footnote">{m.name}</span>
            <span className="shrink-0 text-xs text-subtle">{t('{n} 项', { n: m.size })}</span>
            <Button variant="secondary" size="sm" className="shrink-0" disabled={!m.size} onClick={() => clear(m.name)}>
              {t('清空')}
            </Button>
          </div>
        ))}
      </Card>
    </section>
  )
}
