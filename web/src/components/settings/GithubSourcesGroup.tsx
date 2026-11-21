import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Plus, Radar, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import {
  MIRROR_SOURCE,
  normalizePrefix,
  resolveSources,
  sourceLabel,
  toSettingList,
  type GithubSourceSetting,
  type ResolvedSource,
} from '@shared/github-sources/registry'
import { netContract as N, type GithubAuth, type GithubSourceTest } from '@shared/api-contract/net'
import { call } from '@/lib/api/call'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Group, Row } from './parts'

/**
 * 设置「网络与代理」里的「GitHub 下载来源」：原地址取不到时按这里的顺序换来源（server/github-sources）。
 * 列表来自注册表（shared/github-sources/registry.ts），加了新来源这里自动多一行；镜像前缀由用户自己加。
 * 「检测」按页面上当前的列表逐个来源取一次样例文件，结果标在每一行上。
 */
export function GithubSourcesGroup({
  value,
  onChange,
}: {
  value: GithubSourceSetting[]
  onChange: (v: GithubSourceSetting[]) => void
}) {
  const list = resolveSources(value)
  const [draft, setDraft] = useState('')
  const [testing, setTesting] = useState(false)
  const [results, setResults] = useState<Record<string, GithubSourceTest>>({})
  // GitHub API 带的是哪个令牌：只问本机（环境变量或 gh），不访问 GitHub，打开时问一次
  const [auth, setAuth] = useState<GithubAuth>()
  useEffect(() => {
    call(N.githubAuth)
      .then(setAuth)
      .catch(() => setAuth(undefined))
  }, [])
  /** 「GitHub API」那一行的说明：登录了就写清用的哪个账号、配额多少 */
  const descOf = (s: ResolvedSource) => {
    if (s.def.id !== 'api' || !auth || auth.source === 'none') return s.def.desc()
    if (auth.source === 'env') return t('经 api.github.com 取仓库文件；用环境变量里的令牌，每小时 5000 次')
    return auth.account
      ? t('经 api.github.com 取仓库文件；已用 {tool} 登录（{account}），每小时 5000 次', {
          tool: auth.tool ?? '',
          account: auth.account,
        })
      : t('经 api.github.com 取仓库文件；已用 {tool} 登录，每小时 5000 次', { tool: auth.tool ?? '' })
  }

  const save = (next: ResolvedSource[]) => onChange(toSettingList(next))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    save(next)
  }
  const prefix = normalizePrefix(draft)
  const dup = !!prefix && list.some((s) => s.prefix === prefix)
  const addMirror = () => {
    if (!prefix || dup) return
    save([...list, { key: `mirror:${prefix}`, def: MIRROR_SOURCE, enabled: true, prefix }])
    setDraft('')
  }

  const test = async () => {
    setTesting(true)
    setResults({})
    try {
      const { results: rows } = await call(N.testGithubSources, { body: { sources: toSettingList(list) } })
      setResults(Object.fromEntries(rows.map((r) => [r.key, r])))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Group title={t('GitHub 下载来源')}>
      <Row
        title={t('换来源下载')}
        desc={t('原地址取不到时，按下面的顺序换来源再取')}
        hint={t(
          '插件目录、插件升级包、面板更新这类从 GitHub 取的文件，都先按原地址取（经过上面的代理设置）；连不上、服务器出错或被限流时，依次换下面打开的来源。仓库里的文件能换 GitHub API、GitHub 网页、jsDelivr；Release 附件和源码包只能换镜像前缀。哪个来源成功了，接下来 10 分钟先用它。全都失败时，错误里会列出每个来源的原因。',
        )}
      >
        <Button
          variant="secondary"
          size="sm"
          className="h-9"
          title={t('逐个来源取一次样例文件，看通不通')}
          disabled={testing}
          onClick={() => void test()}
        >
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
          {t('检测')}
        </Button>
      </Row>
      <ol className="flex flex-col gap-1 pb-3">
        {list.map((s, i) => {
          const r = results[s.key]
          return (
            <li
              key={s.key}
              data-source={s.key}
              className={cn('flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-sel/40', !s.enabled && 'opacity-60')}
            >
              <span className="w-4 shrink-0 text-center font-mono text-caption text-muted">{i + 1}</span>
              <Switch
                aria-label={sourceLabel(s)}
                checked={s.enabled}
                onCheckedChange={(v) => save(list.map((x) => (x.key === s.key ? { ...x, enabled: v } : x)))}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2 text-body font-medium">
                  <span className="truncate">{s.prefix ? s.prefix : s.def.label()}</span>
                  {r?.ok && <StatusPill tone="ok">{t('可用 · {ms} 毫秒', { ms: String(r.ms ?? 0) })}</StatusPill>}
                  {r && !r.ok && !r.skipped && (
                    <StatusPill tone="err" title={r.error}>
                      {t('不通')}
                    </StatusPill>
                  )}
                </span>
                <span className="truncate text-caption text-subtle" title={r && !r.ok ? r.error : undefined}>
                  {r && !r.ok && r.error ? r.error : descOf(s)}
                </span>
              </div>
              <div className="flex shrink-0 items-center">
                <IconButton
                  icon={ChevronUp}
                  size="sm"
                  label={t('上移')}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                />
                <IconButton
                  icon={ChevronDown}
                  size="sm"
                  label={t('下移')}
                  disabled={i === list.length - 1}
                  onClick={() => move(i, 1)}
                />
                {s.prefix && (
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    label={t('删除这个镜像')}
                    onClick={() => save(list.filter((x) => x.key !== s.key))}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <Row
        title={t('加镜像前缀')}
        desc={
          draft.trim() && !prefix ? (
            <span className="text-warning">{t('要写成 http(s):// 开头的地址')}</span>
          ) : dup ? (
            <span className="text-warning">{t('已经加过这个镜像')}</span>
          ) : (
            t('第三方加速站，原地址前面加上它再取')
          )
        }
        hint={t(
          '填镜像站给的前缀，例如 https://mirror.example.com/ ，取文件时用「前缀 + 原地址」。镜像是第三方服务，面板不内置任何一个，请只填信得过的站点。',
        )}
      >
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addMirror()}
            placeholder="https://mirror.example.com/"
            className="font-mono text-body"
            spellCheck={false}
            aria-label={t('镜像前缀')}
          />
          <Button variant="secondary" size="sm" className="h-9 shrink-0" disabled={!prefix || dup} onClick={addMirror}>
            <Plus className="h-4 w-4" />
            {t('添加')}
          </Button>
        </div>
      </Row>
    </Group>
  )
}
