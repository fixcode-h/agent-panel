import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { TrustChoice } from '@shared/cli-trust'
import { t } from '@shared/i18n'
import { cliMoreApi } from '@/lib/api-cli-more'
import { Segmented } from '@/components/ui/segmented'

type Pick3 = 'follow' | TrustChoice

/**
 * 项目设置里 CLI 分页的「项目配置」（ADR 0050）：有的 CLI 只在信任过项目后才读项目里的配置、扩展和 Skill，
 * 面板里跑时不会弹窗问，默认按不信任跳过。这里按项目选跟随 / 信任 / 不信任；
 * 选「跟随」而项目里有这类文件时，下面写清楚找到了哪些、它们现在不会加载
 */
export function ProjectCliTrust({
  cli,
  name,
  projectId,
  value,
  onChange,
}: {
  cli: string
  name: string
  projectId?: string
  value: TrustChoice | undefined
  onChange: (v: TrustChoice | undefined) => void
}) {
  const [found, setFound] = useState<string[]>([])
  useEffect(() => {
    setFound([])
    if (!projectId) return
    // 读不出来（项目目录不在了）就当没有，不影响选择
    cliMoreApi
      .projectTrust(projectId)
      .then((r) => setFound(r[cli] ?? []))
      .catch(() => setFound([]))
  }, [projectId, cli])
  const cur: Pick3 = value ?? 'follow'
  return (
    <section className="flex flex-col gap-2 pt-6">
      <h3 className="text-body font-medium">{t('项目配置')}</h3>
      <p className="text-footnote text-muted">
        {t(
          '{cli} 只在信任过这个项目后才读项目里的配置、扩展和 Skill；面板里运行时不会弹窗问，没有保存过决定就当不信任。选「信任」后项目里的扩展代码会在 {cli} 里执行，下次启动生效',
          { cli: name },
        )}
      </p>
      <Segmented<Pick3>
        label={t('{cli} 项目配置', { cli: name })}
        value={cur}
        onChange={(v) => onChange(v === 'follow' ? undefined : v)}
        options={[
          { id: 'follow', label: t('跟随 {cli}', { cli: name }) },
          { id: 'approve', label: t('信任') },
          { id: 'deny', label: t('不信任') },
        ]}
        className="self-start"
      />
      {cur === 'follow' && found.length > 0 && (
        <p className="flex items-start gap-1.5 text-footnote text-warning">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t('这个项目里有 {cli} 的项目配置：{files}。没在终端里信任过这个目录时，面板里运行的 {cli} 不会加载它们', {
              cli: name,
              files: found.join('、'),
            })}
          </span>
        </p>
      )}
    </section>
  )
}
