import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { AlertTriangle, ExternalLink, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { CLIS } from '@shared/clis'
import { api, type UserClis } from '@/lib/api'
import { cliColor } from '@/lib/cli-style'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Group } from './parts'
import { t } from '@shared/i18n'

const DOCS = 'https://github.com/fixcode-h/agent-panel/blob/main/docs/cli-config.md'

/**
 * 「添加其他 CLI」：用户把 CLI 配置（JSON）放进数据目录的 config/clis/，重新读取后就能用，不用改代码。
 * 这里显示目录、读到了哪些、哪些读不进来
 */
export function CustomClis({ demo }: { demo?: boolean }) {
  const [info, setInfo] = useState<UserClis | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api
      .cliSpecs()
      .then(setInfo)
      .catch(() => {})
  }, [])
  const user = CLIS.filter((c) => c.user)

  const reload = async () => {
    setBusy(true)
    try {
      const r = await api.reloadCliSpecs()
      setInfo(r)
      if (r.errors.length) toast.error(t('有 {n} 份配置读不进来', { n: r.errors.length }))
      // 设置页的草稿、列表都是按打开时的 CLI 建的，刷新一下最省事
      else location.reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group title={t('添加其他 Agent')}>
      <div className="flex flex-col gap-3 py-3">
        <p className="text-body leading-relaxed text-muted">
          {t(
            '面板按配置文件调用 Agent：命令和参数怎么拼、输出怎么解析、Skill 和说明文件在哪。按格式写一份 JSON 放进下面的目录，点「重新读取」就能用，不用改代码。',
          )}{' '}
          <a
            href={DOCS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-accent-text hover:underline"
          >
            {t('配置格式')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-field px-2.5 py-1.5 font-mono text-footnote text-muted">
            {info?.dir ?? '…'}
          </code>
          {!demo && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                api
                  .revealCliSpecs()
                  .then((r) => toast.success(t('已在文件夹中打开：{dir}', { dir: r.dir })))
                  .catch((e) => toast.error((e as Error).message))
              }
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t('打开目录')}
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={busy || demo} onClick={() => void reload()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('重新读取')}
          </Button>
        </div>
        {user.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {user.map((c) => (
              <Badge key={c.id} className="gap-1.5 px-2.5 py-1 text-footnote text-fg">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: cliColor(c.id) }} />
                {c.name}
                <span className="font-mono text-caption text-subtle">{c.id}</span>
              </Badge>
            ))}
          </div>
        )}
        {!!info?.errors.length && (
          <div className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-footnote leading-relaxed text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
              {info.errors.map((e) => (
                <span key={e} className="break-all">
                  {e}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Group>
  )
}
