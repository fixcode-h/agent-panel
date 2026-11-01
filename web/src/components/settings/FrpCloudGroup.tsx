import { useState } from 'react'
import { t } from '@shared/i18n'
import type { RemoteAccess } from '@shared/schema'
import type { FrpDeployStatus, RemoteAccessStatus } from '@shared/remote'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Advanced, Group, Row } from './parts'

const STEP_TEXT: Record<FrpDeployStatus['step'], string> = {
  connect: t('正在登录服务器'),
  download: t('正在下载 frps'),
  upload: t('正在上传到服务器'),
  install: t('正在安装服务'),
  done: t('配置完成'),
}

const port = (v: string, fallback: number) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}

/**
 * 「云服务器（frp）」：填服务器 IP、SSH 用户和密码，一键在服务器上装好 frps，
 * 本机自动跑 frpc。密码只随这次请求发给本机服务，不保存。
 */
export function FrpCloudGroup({
  value,
  onChange,
  status,
  onStatus,
}: {
  value: RemoteAccess
  onChange: (v: RemoteAccess) => void
  status: RemoteAccessStatus | null
  onStatus: (s: RemoteAccessStatus) => void
}) {
  const f = value.frp
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch: Partial<RemoteAccess['frp']>) => onChange({ ...value, frp: { ...f, ...patch } })
  const deploy = status?.deploy
  const running = busy || !!deploy?.running

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await api.remoteDeploy({
        server: f.server,
        sshPort: f.sshPort,
        sshUser: f.sshUser,
        password,
        bindPort: f.bindPort,
        remotePort: f.remotePort,
        rangeStart: f.rangeStart,
        rangeEnd: f.rangeEnd,
      })
      // 服务端已经保存了设置（含生成的 frp 令牌）：页面上的这份换成它，免得自动保存时用旧值盖回去
      onChange(r.remoteAccess)
      onStatus(r.status)
      setPassword('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const progress =
    deploy?.running &&
    (deploy.step === 'download' && deploy.percent >= 0
      ? `${STEP_TEXT.download} ${deploy.percent}%`
      : STEP_TEXT[deploy.step])

  return (
    <Group title={t('云服务器')}>
      <Row
        title={t('服务器 IP')}
        desc={t('阿里云 ECS 的公网 IP')}
        hint={t(
          '面板通过 SSH 登录这台服务器，装好 frps 并注册成系统服务；本机自动运行 frpc。目前支持装了 systemd 的 Linux。',
        )}
      >
        <Input
          value={f.server}
          onChange={(e) => set({ server: e.target.value.trim() })}
          placeholder="47.100.1.2"
          spellCheck={false}
          className="w-[220px] font-mono text-body"
          aria-label={t('服务器 IP')}
        />
      </Row>
      <Row title={t('SSH 用户')} desc={t('一般是 root')}>
        <div className="flex items-center gap-2">
          <Input
            value={f.sshUser}
            onChange={(e) => set({ sshUser: e.target.value.trim() })}
            placeholder="root"
            spellCheck={false}
            className="w-[140px] font-mono text-body"
            aria-label={t('SSH 用户')}
          />
          <Input
            value={String(f.sshPort)}
            onChange={(e) => set({ sshPort: port(e.target.value, f.sshPort) })}
            inputMode="numeric"
            className="w-[72px] font-mono text-body"
            aria-label={t('SSH 端口')}
          />
        </div>
      </Row>
      <Row
        title={t('SSH 密码')}
        desc={t('只用这一次，不保存')}
        hint={t('非 root 用户需要有 sudo 权限，sudo 也用这个密码。')}
      >
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          className="w-[220px] font-mono text-body"
          aria-label={t('SSH 密码')}
        />
      </Row>
      <Advanced label={t('端口')}>
        <Row title={t('frp 端口')} desc={t('frpc 连服务器用')}>
          <Input
            value={String(f.bindPort)}
            onChange={(e) => set({ bindPort: port(e.target.value, f.bindPort) })}
            inputMode="numeric"
            className="w-[96px] font-mono text-body"
            aria-label={t('frp 端口')}
          />
        </Row>
        <Row title={t('面板端口')} desc={t('外网用 http://IP:端口 打开面板')}>
          <Input
            value={String(f.remotePort)}
            onChange={(e) => set({ remotePort: port(e.target.value, f.remotePort) })}
            inputMode="numeric"
            className="w-[96px] font-mono text-body"
            aria-label={t('面板端口')}
          />
        </Row>
        <Row
          title={t('端口映射范围')}
          desc={t('SSH、远程桌面等映射用的服务器端口')}
          hint={t('一键配置时放行这一段，之后增删映射不用再登录服务器。改了范围要重新配置。')}
        >
          <div className="flex items-center gap-2 text-body text-muted">
            <Input
              value={String(f.rangeStart)}
              onChange={(e) => set({ rangeStart: port(e.target.value, f.rangeStart) })}
              inputMode="numeric"
              className="w-[84px] font-mono text-body"
              aria-label={t('起始端口')}
            />
            –
            <Input
              value={String(f.rangeEnd)}
              onChange={(e) => set({ rangeEnd: port(e.target.value, f.rangeEnd) })}
              inputMode="numeric"
              className="w-[84px] font-mono text-body"
              aria-label={t('结束端口')}
            />
          </div>
        </Row>
      </Advanced>
      <Row
        title={t('一键配置')}
        desc={t('先在阿里云控制台「安全组 → 入方向」放行 TCP {ssh}、{bind}、{remote}，用端口映射时再放行 {range}', {
          ssh: String(f.sshPort),
          bind: String(f.bindPort),
          remote: String(f.remotePort),
          range: `${f.rangeStart}-${f.rangeEnd}`,
        })}
        hint={t(
          '浏览器到服务器这一段是 http，令牌在网络上是明文；对安全要求高时请用「固定域名」配 HTTPS。系统防火墙（firewalld、ufw）会自动放行，阿里云的安全组需要你在控制台里放行。',
        )}
        stack
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={run} disabled={running || !f.server || !f.sshUser || !password}>
              {running ? t('配置中…') : f.token ? t('重新配置') : t('一键配置')}
            </Button>
            {progress && <span className="text-body text-muted">{progress}</span>}
            {!running && deploy?.step === 'done' && !error && (
              <span className="text-body text-success">{STEP_TEXT.done}</span>
            )}
          </div>
          {(error || deploy?.error) && (
            <p className="text-footnote leading-relaxed whitespace-pre-wrap text-danger">{error || deploy?.error}</p>
          )}
        </div>
      </Row>
    </Group>
  )
}
