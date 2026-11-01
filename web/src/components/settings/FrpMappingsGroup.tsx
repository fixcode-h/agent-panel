import { useState } from 'react'
import { Check, Copy, Plus, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { FrpMapping, type RemoteAccess } from '@shared/schema'
import { frpMappingError, frpVisitorConfig, type RemoteAccessStatus } from '@shared/remote'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { DirPicker, useDirInfo } from '@/components/projects/DirPicker'
import { copyText } from '@/lib/copy-text'
import { CopyText, Group, Row } from './parts'

/** 常用服务：本机端口固定，服务器端口从范围里挑一个空的 */
const PRESETS = [
  { key: 'ssh', name: 'SSH', localPort: 22, type: 'tcp' },
  { key: 'rdp', name: t('Windows 远程桌面'), localPort: 3389, type: 'tcp' },
  { key: 'vnc', name: t('VNC / macOS 屏幕共享'), localPort: 5900, type: 'tcp' },
  { key: 'p2p', name: t('P2P 直连'), localPort: 22, type: 'xtcp' },
  { key: 'files', name: t('文件共享'), localPort: 22, type: 'files' },
  { key: 'custom', name: t('自定义'), localPort: 8080, type: 'tcp' },
] as const

const TYPE_OPTIONS = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'xtcp', label: t('P2P 直连') },
  { value: 'files', label: t('文件共享') },
]

const newId = () => Math.random().toString(36).slice(2, 10) || 'm'

/** 随机密钥：P2P 的 secretKey、文件共享的密码 */
function randomSecret(bytes = 12) {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 换成 P2P / 文件共享时补上它要的密钥和账号 */
const withSecrets = (m: FrpMapping): FrpMapping => ({
  ...m,
  secretKey: m.type === 'xtcp' && !m.secretKey ? randomSecret() : m.secretKey,
  httpUser: m.type === 'files' && !m.httpUser ? 'agent' : m.httpUser,
  httpPassword: m.type === 'files' && !m.httpPassword ? randomSecret(6) : m.httpPassword,
})

const num = (v: string, fallback: number) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}

/**
 * 外部怎么连：按类型和本机端口认出常见服务，给出能直接复制的命令或地址。
 * SSH 用本机的登录用户名拼好；P2P 是在访问端那台电脑上连它自己的 127.0.0.1:visitorPort
 */
function mappingUsage(m: FrpMapping, server: string, user: string) {
  if (m.type === 'files')
    return { text: `http://${server}:${m.remotePort}/`, hint: t('在浏览器打开，用户名 {user}', { user: m.httpUser }) }
  const p2p = m.type === 'xtcp'
  const host = p2p ? '127.0.0.1' : server
  const port = p2p ? m.visitorPort : m.remotePort
  const where = p2p ? t('（在访问端电脑上，先运行访问端配置）') : ''
  if (m.localPort === 22)
    return { text: `ssh -p ${port} ${user || '<user>'}@${host}`, hint: t('复制到终端里执行') + where }
  if (m.localPort === 3389)
    return {
      text: `${host}:${port}`,
      hint: t('在「远程桌面连接」（mstsc）里填这个地址；本机要先在系统设置里打开远程桌面') + where,
    }
  if (m.localPort === 5900)
    return { text: `vnc://${host}:${port}`, hint: t('用 VNC 客户端或 macOS 的「屏幕共享」打开') + where }
  return { text: `${host}:${port}`, hint: where }
}

/** 文件共享的目录：带检查和「浏览」，和项目目录用同一个选择器 */
function SharedDir({ value, onChange }: { value: string; onChange: (p: string) => void }) {
  const info = useDirInfo(value)
  return (
    <DirPicker
      value={value}
      onChange={onChange}
      info={info}
      label={t('共享的目录')}
      hint={t('外部打开时只能看到这个目录里的文件，只能下载，不能上传和修改。')}
    />
  )
}

/** 复制访问端配置：内容是多行 TOML，按钮上只写名字 */
function CopyVisitor({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() =>
        void copyText(text, { fail: false }).then((ok) => {
          if (!ok) return
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
      title={t('复制后保存成 visitor.toml，在访问端电脑上运行 frpc -c visitor.toml')}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {t('复制访问端配置')}
    </Button>
  )
}

const portInput = 'w-[80px] font-mono text-body'

/**
 * 「端口映射」：把本机或局域网里的 SSH、远程桌面等服务经云服务器开到外网，
 * 也可以 P2P 直连（不经服务器转发）或把一个目录做成网页文件共享。
 * 改动后自动保存，frpc 跟着重启生效；服务器上的端口范围在一键配置时已经放行。
 */
export function FrpMappingsGroup({
  value,
  onChange,
  status,
}: {
  value: RemoteAccess
  onChange: (v: RemoteAccess) => void
  status: RemoteAccessStatus | null
}) {
  const f = value.frp
  const setMappings = (mappings: FrpMapping[]) => onChange({ ...value, frp: { ...f, mappings } })
  const update = (id: string, patch: Partial<FrpMapping>) =>
    setMappings(f.mappings.map((m) => (m.id === id ? withSecrets({ ...m, ...patch }) : m)))

  const freePort = () => {
    const used = new Set(f.mappings.map((m) => m.remotePort))
    for (let p = f.rangeStart; p <= f.rangeEnd; p++) if (!used.has(p)) return p
    return f.rangeStart
  }
  const freeVisitorPort = () => {
    const used = new Set(f.mappings.map((m) => m.visitorPort))
    for (let p = 6000; p < 7000; p++) if (!used.has(p)) return p
    return 6000
  }

  const add = (key: string) => {
    const p = PRESETS.find((x) => x.key === key) ?? PRESETS[0]
    const m = FrpMapping.parse({
      id: newId(),
      name: p.key === 'custom' ? '' : p.name,
      type: p.type,
      localPort: p.localPort,
      remotePort: freePort(),
      visitorPort: freeVisitorPort(),
    })
    setMappings([...f.mappings, withSecrets(m)])
  }

  return (
    <Group title={t('端口映射')}>
      <Row
        title={t('添加映射')}
        desc={t('通过云服务器访问本机的 SSH、远程桌面、文件等')}
        hint={t(
          'SSH、远程桌面直接暴露在公网上会被不停地扫描和猜密码：务必用强密码，最好在阿里云安全组里只允许自己的 IP 访问这些端口。P2P 直连不在服务器上开端口，更安全。',
        )}
      >
        <div className="flex max-w-[420px] flex-wrap justify-end gap-1.5">
          {PRESETS.map((p) => (
            <Button key={p.key} size="sm" variant="secondary" onClick={() => add(p.key)}>
              <Plus className="h-3.5 w-3.5" />
              {p.name}
            </Button>
          ))}
        </div>
      </Row>
      {f.mappings.map((m) => {
        const problem = frpMappingError(m, f)
        const st = status?.mappings?.[m.id]
        const tone = !m.enabled
          ? 'bg-line-strong'
          : problem || st?.error
            ? 'bg-danger'
            : st?.ok
              ? 'bg-success'
              : 'bg-line-strong'
        const use = mappingUsage(m, f.server, status?.localUser ?? '')
        const ready = m.enabled && !problem && !!f.server
        return (
          <Row
            key={m.id}
            title={m.name || t('未命名映射')}
            desc={problem || st?.error || (m.enabled ? use.hint || undefined : t('已停用'))}
            stack
          >
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-body text-muted">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
                <Input
                  value={m.name}
                  onChange={(e) => update(m.id, { name: e.target.value })}
                  placeholder={t('名称')}
                  className="w-[140px] text-body"
                  aria-label={t('名称')}
                />
                <Select
                  aria-label={t('类型')}
                  value={m.type}
                  onChange={(e) => update(m.id, { type: e.target.value as FrpMapping['type'] })}
                  className="w-[120px]"
                  options={TYPE_OPTIONS}
                />
                {m.type !== 'files' && (
                  <>
                    <Input
                      value={m.localIP}
                      onChange={(e) => update(m.id, { localIP: e.target.value.trim() })}
                      placeholder="127.0.0.1"
                      spellCheck={false}
                      className="w-[124px] font-mono text-body"
                      aria-label={t('本机地址')}
                    />
                    :
                    <Input
                      value={String(m.localPort)}
                      onChange={(e) => update(m.id, { localPort: num(e.target.value, m.localPort) })}
                      inputMode="numeric"
                      className="w-[72px] font-mono text-body"
                      aria-label={t('本机端口')}
                    />
                    →
                  </>
                )}
                {m.type === 'xtcp' ? (
                  <Input
                    value={String(m.visitorPort)}
                    onChange={(e) => update(m.id, { visitorPort: num(e.target.value, m.visitorPort) })}
                    inputMode="numeric"
                    className={portInput}
                    aria-label={t('访问端端口')}
                    title={t('访问端端口')}
                  />
                ) : (
                  <Input
                    value={String(m.remotePort)}
                    onChange={(e) => update(m.id, { remotePort: num(e.target.value, m.remotePort) })}
                    inputMode="numeric"
                    className={portInput}
                    aria-label={t('服务器端口')}
                    title={t('服务器端口')}
                  />
                )}
                <Switch
                  aria-label={t('启用')}
                  checked={m.enabled}
                  onCheckedChange={(on) => update(m.id, { enabled: on })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMappings(f.mappings.filter((x) => x.id !== m.id))}
                  aria-label={t('删除映射')}
                  title={t('删除映射')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {m.type === 'files' && (
                <div className="flex flex-col gap-2">
                  <SharedDir value={m.localPath} onChange={(p) => update(m.id, { localPath: p })} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={m.httpUser}
                      onChange={(e) => update(m.id, { httpUser: e.target.value.trim() })}
                      placeholder={t('用户名')}
                      className="w-[140px] font-mono text-body"
                      aria-label={t('用户名')}
                    />
                    <Input
                      value={m.httpPassword}
                      onChange={(e) => update(m.id, { httpPassword: e.target.value })}
                      placeholder={t('密码')}
                      className="w-[180px] font-mono text-body"
                      aria-label={t('密码')}
                    />
                  </div>
                </div>
              )}
              {ready && (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <CopyText text={use.text} title={t('复制')} />
                  {m.type === 'files' && <CopyText text={m.httpPassword} title={t('复制密码')} />}
                  {m.type === 'xtcp' && f.token && <CopyVisitor text={frpVisitorConfig(f, m)} />}
                </div>
              )}
            </div>
          </Row>
        )
      })}
      {f.mappings.some((m) => m.type === 'xtcp') && (
        <Row
          title={t('P2P 直连怎么用')}
          desc={t('在访问端电脑上下载 frpc，把访问端配置保存成 visitor.toml，运行 frpc -c visitor.toml')}
          hint={t(
            '两边先尝试打洞直连，流量不经过云服务器；打不通时自动改走服务器中转。访问端配置里带着 frp 令牌，只放在自己的电脑上。',
          )}
        >
          <a
            href="https://github.com/fatedier/frp/releases"
            target="_blank"
            rel="noreferrer"
            className="text-body text-accent-text hover:underline"
          >
            {t('下载 frpc')}
          </a>
        </Row>
      )}
    </Group>
  )
}
