import { Plus, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { FrpMapping, RemoteAccess } from '@shared/schema'
import { frpMappingError, type RemoteAccessStatus } from '@shared/remote'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CopyText, Group, Row } from './parts'

/** 常用服务：本机端口固定，服务器端口从范围里挑一个空的 */
const PRESETS = [
  { key: 'ssh', name: 'SSH', localPort: 22, type: 'tcp' },
  { key: 'rdp', name: t('Windows 远程桌面'), localPort: 3389, type: 'tcp' },
  { key: 'vnc', name: t('VNC / macOS 屏幕共享'), localPort: 5900, type: 'tcp' },
  { key: 'custom', name: t('自定义'), localPort: 8080, type: 'tcp' },
] as const

const newId = () => Math.random().toString(36).slice(2, 10) || 'm'

const num = (v: string, fallback: number) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}

/** 连接方式的提示：按本机端口认出常见服务，给出能直接用的命令 */
function usage(m: FrpMapping, host: string) {
  const addr = `${host}:${m.remotePort}`
  if (m.localPort === 22)
    return { text: `ssh -p ${m.remotePort} <user>@${host}`, hint: t('在终端里执行，<user> 换成本机的用户名') }
  if (m.localPort === 3389)
    return { text: addr, hint: t('在「远程桌面连接」（mstsc）里填这个地址；本机要先在系统设置里打开远程桌面') }
  if (m.localPort === 5900) return { text: `vnc://${addr}`, hint: t('用 VNC 客户端或 macOS 的「屏幕共享」打开') }
  return { text: addr, hint: '' }
}

/**
 * 「端口映射」：把本机或局域网里的 SSH、远程桌面等服务经云服务器开到外网。
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
    setMappings(f.mappings.map((m) => (m.id === id ? { ...m, ...patch } : m)))

  const freePort = () => {
    const used = new Set(f.mappings.map((m) => m.remotePort))
    for (let p = f.rangeStart; p <= f.rangeEnd; p++) if (!used.has(p)) return p
    return f.rangeStart
  }

  const add = (key: string) => {
    const p = PRESETS.find((x) => x.key === key) ?? PRESETS[0]
    setMappings([
      ...f.mappings,
      {
        id: newId(),
        name: p.key === 'custom' ? '' : p.name,
        type: p.type,
        localIP: '127.0.0.1',
        localPort: p.localPort,
        remotePort: freePort(),
        enabled: true,
      },
    ])
  }

  return (
    <Group title={t('端口映射')}>
      <Row
        title={t('添加映射')}
        desc={t('通过云服务器访问本机的 SSH、远程桌面等服务')}
        hint={t(
          'SSH、远程桌面直接暴露在公网上会被不停地扫描和猜密码：务必用强密码，最好在阿里云安全组里只允许自己的 IP 访问这些端口。',
        )}
      >
        <div className="flex flex-wrap justify-end gap-1.5">
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
        const use = usage(m, f.server)
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
                  aria-label={t('协议')}
                  value={m.type}
                  onChange={(e) => update(m.id, { type: e.target.value as FrpMapping['type'] })}
                  className="w-[84px]"
                  options={[
                    { value: 'tcp', label: 'TCP' },
                    { value: 'udp', label: 'UDP' },
                  ]}
                />
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
                <Input
                  value={String(m.remotePort)}
                  onChange={(e) => update(m.id, { remotePort: num(e.target.value, m.remotePort) })}
                  inputMode="numeric"
                  className="w-[80px] font-mono text-body"
                  aria-label={t('服务器端口')}
                />
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
              {m.enabled && !problem && f.server && (
                <div className="flex min-w-0 items-center gap-2">
                  <CopyText text={use.text} title={t('复制')} />
                </div>
              )}
            </div>
          </Row>
        )
      })}
    </Group>
  )
}
