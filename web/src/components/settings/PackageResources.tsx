import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { cliMoreApi } from '@/lib/api-cli-more'
import { toast } from '@/lib/toast'
import { Switch } from '@/components/ui/switch'

/**
 * 一个已装插件里按类型开关资源（ADR 0050 第四期）：例如只要它的扩展、不要它带的 Skill。
 * 改了马上写进 CLI 的配置（对象写法），下一轮对话生效；包里没有的类型不列
 */
export function PackageResources({ cli, source }: { cli: string; source: string }) {
  const [list, setList] = useState<{ type: string; label: string; on: boolean }[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    setList(null)
    cliMoreApi
      .packageResources(cli, source)
      .then(setList)
      .catch((e) => setError((e as Error).message))
  }, [cli, source])
  const toggle = async (type: string, on: boolean) => {
    setBusy(type)
    try {
      await cliMoreApi.setPackageResource(cli, source, type, on)
      setList((l) => l?.map((x) => (x.type === type ? { ...x, on } : x)) ?? l)
    } catch (e) {
      toast.error(t('没有改成：{error}', { error: (e as Error).message }))
    } finally {
      setBusy('')
    }
  }
  if (error) return <p className="px-3 pb-2 text-footnote text-warning">{t('读取失败：{error}', { error })}</p>
  if (!list)
    return (
      <p className="flex items-center gap-1.5 px-3 pb-2 text-footnote text-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('读取中…')}
      </p>
    )
  if (!list.length) return <p className="px-3 pb-2 text-footnote text-subtle">{t('看不出这个插件里有哪些资源')}</p>
  return (
    <div className="mx-3 mb-2 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-field px-3 py-2">
      <span className="text-footnote text-subtle">{t('加载这个插件里的：')}</span>
      {list.map((x) => (
        <label key={x.type} className="flex items-center gap-2 text-footnote">
          <Switch
            checked={x.on}
            disabled={busy === x.type}
            onCheckedChange={(v) => void toggle(x.type, v)}
            aria-label={t('{name} 的{type}', { name: source, type: x.label })}
          />
          {x.label}
        </label>
      ))}
    </div>
  )
}
