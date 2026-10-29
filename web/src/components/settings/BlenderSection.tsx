import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Group, Row } from './parts'

type Status = Awaited<ReturnType<typeof api.blenderStatus>>

/**
 * 模型设计用的 Blender（docs/adr/0025-model-design-blender.md）：留空时面板自己在 PATH 和常见安装位置里找。
 * 路径改了要等设置存下来才查得准，所以输入停一会儿再重新检测
 */
export function BlenderSection({ path, onPath }: { path: string; onPath: (p: string) => void }) {
  const [st, setSt] = useState<Status>()
  const [busy, setBusy] = useState(false)
  const detect = () => {
    setBusy(true)
    api
      .blenderStatus()
      .then(setSt)
      .catch((e: Error) => setSt({ path: '', version: '', error: e.message }))
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    const timer = setTimeout(detect, 1200)
    return () => clearTimeout(timer)
    // 只跟着路径重新检测：detect 每次渲染都是新函数，放进依赖会一直重查
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  return (
    <>
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t('模型对话里 Agent 用 Blender 建模，网页右侧实时预览。面板在后台起一个 Blender，不弹窗口。')}
      </p>
      <Group>
        <Row title={t('Blender 路径')} desc={t('留空时自动在 PATH 和常见安装位置里找')} stack>
          <Input
            aria-label={t('Blender 路径')}
            value={path}
            placeholder="C:/Program Files/Blender Foundation/Blender 4.5/blender.exe"
            onChange={(e) => onPath(e.target.value)}
            className="font-mono"
          />
        </Row>
        <Row
          title={t('检测结果')}
          desc={
            st?.error ? (
              <span className="text-danger">{st.error}</span>
            ) : st ? (
              <span className="break-all">{st.path}</span>
            ) : undefined
          }
        >
          <div className="flex items-center gap-2">
            <span className={cn('text-[0.8125rem]', st?.error ? 'text-subtle' : 'font-medium text-fg')}>
              {!st ? t('检测中…') : st.error ? t('没有找到') : `Blender ${st.version}`}
            </span>
            <Button size="sm" variant="ghost" onClick={detect} disabled={busy} title={t('重新检测')}>
              <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
            </Button>
          </div>
        </Row>
      </Group>
    </>
  )
}
