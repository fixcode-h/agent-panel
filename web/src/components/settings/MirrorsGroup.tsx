import { t } from '@shared/i18n'
import { MIRRORS } from '@shared/mirrors/registry'
import { Group, Row } from './parts'

/**
 * 设置「网络与代理」里的「国内镜像」：GitHub 以外的下载（npm、Hugging Face、PyPI、ffmpeg）各自的官方站和镜像站，
 * 列表来自注册表（shared/mirrors/registry.ts）。用不用镜像由各功能自己的开关决定（语音输入、本机生图、视频的 FFmpeg），
 * 这里只把地址列在一处，用户知道会往哪些站发请求
 */
export function MirrorsGroup() {
  return (
    <Group title={t('国内镜像')}>
      {MIRRORS.map((m) => (
        <Row
          key={m.id}
          title={m.label}
          desc={m.usedBy()}
          hint={t('开了「用国内镜像」的功能先从镜像站取，取不到再回官方站；没开的只从官方站取。')}
        >
          <div className="min-w-0 text-right font-mono text-caption text-subtle">
            <div className="truncate" title={m.mirror}>
              {m.mirror.replace(/^https?:\/\//, '')}
            </div>
            <div className="truncate text-muted" title={m.official}>
              {t('官方')} {m.official.replace(/^https?:\/\//, '')}
            </div>
          </div>
        </Row>
      ))}
    </Group>
  )
}
