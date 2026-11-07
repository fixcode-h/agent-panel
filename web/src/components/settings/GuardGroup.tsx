import { useCallback, useEffect, useState } from 'react'
import { t, uiLocale } from '@shared/i18n'
import type { RemoteAccess } from '@shared/schema'
import type { GuardState } from '@shared/remote'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Advanced, CopyText, Group, Row } from './parts'

/** 密码最短长度，和服务端 server/guard/password.ts 的 MIN_PASSWORD 一致 */
const MIN_PASSWORD = 8

const when = (ms: number) => new Date(ms).toLocaleString(uiLocale(), { dateStyle: 'short', timeStyle: 'short' })

/** 从 User-Agent 里认出浏览器和系统，列表里给人看；认不出就显示原文开头 */
function device(ua: string) {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ''
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40) || t('未知设备')
}

/**
 * 「访问密码」和「登录的设备」：外网打开面板要输的密码、会话有效期和失败锁定，以及现在登录着的外网设备。
 * 做法参考 dsh-web-guard 的设置页：改密码后别的设备都要重新登录，可以踢掉单个设备或全部退出
 */
export function GuardGroup({ value, onChange }: { value: RemoteAccess; onChange: (v: RemoteAccess) => void }) {
  const [state, setState] = useState<GuardState | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    api
      .guardState()
      .then(setState)
      .catch(() => {})
  }, [])
  useEffect(() => {
    load()
    // 别的设备登录、过期都在服务端发生，开着这一页时定时刷新
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  const change = async () => {
    if (next.length < MIN_PASSWORD) return toast.error(t('密码至少 {n} 位', { n: String(MIN_PASSWORD) }))
    if (next !== confirm) return toast.error(t('两次输入的密码不一样'))
    setSaving(true)
    try {
      await api.guardPassword(next, current)
      setCurrent('')
      setNext('')
      setConfirm('')
      toast.success(t('密码已修改，其他设备需要重新登录'))
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const kick = async (id: string) => {
    try {
      await api.guardKick(id)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const logoutAll = async () => {
    try {
      await api.guardLogoutAll()
      if (state?.external) location.href = '/login'
      else load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const num = (key: 'sessionDays' | 'maxAttempts' | 'lockMinutes', min: number, max: number, label: string) => (
    <Input
      value={String(value[key])}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isInteger(n) && n >= min && n <= max) onChange({ ...value, [key]: n })
      }}
      inputMode="numeric"
      className="w-[80px] font-mono text-body"
      aria-label={label}
    />
  )

  return (
    <>
      <Group title={t('访问密码')}>
        {state?.initialPassword && (
          <Row
            title={t('初始密码')}
            desc={t('面板自动生成的，只在这台电脑上显示；建议改成自己的密码')}
            hint={t('在其他设备上打开外网地址时输入这个密码。改过密码后这里不再显示。')}
          >
            <CopyText text={state.initialPassword} title={t('复制密码')} />
          </Row>
        )}
        <Row
          title={t('修改密码')}
          desc={t('至少 {n} 位；改完后其他已登录的设备都要重新登录', { n: String(MIN_PASSWORD) })}
          stack
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            {state?.external && (
              <Input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder={t('当前密码')}
                autoComplete="current-password"
                aria-label={t('当前密码')}
              />
            )}
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder={t('新密码')}
              autoComplete="new-password"
              aria-label={t('新密码')}
            />
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t('再输一遍')}
              autoComplete="new-password"
              aria-label={t('再输一遍')}
            />
            <Button size="sm" onClick={change} disabled={saving || !next} className="shrink-0 self-end sm:self-auto">
              {saving ? t('保存中…') : t('修改')}
            </Button>
          </div>
        </Row>
        <Advanced label={t('登录有效期和锁定')}>
          <Row title={t('登录有效期（天）')} desc={t('这么多天没打开面板就要重新登录；0 表示关掉浏览器就失效')}>
            {num('sessionDays', 0, 365, t('登录有效期（天）'))}
          </Row>
          <Row title={t('连续输错几次锁定')} desc={t('同一个地址连续输错这么多次，暂时不让再试')}>
            {num('maxAttempts', 1, 50, t('连续输错几次锁定'))}
          </Row>
          <Row title={t('锁定多少分钟')}>{num('lockMinutes', 1, 1440, t('锁定多少分钟'))}</Row>
        </Advanced>
      </Group>

      <Group title={t('登录的设备')}>
        {!state?.sessions.length ? (
          <Row title={t('没有外网设备登录')} desc={t('在其他设备上用访问密码登录后会列在这里')}>
            <span />
          </Row>
        ) : (
          <>
            {state.sessions.map((s) => (
              <Row
                key={s.id}
                title={`${device(s.ua)}${s.id === state.current ? ` · ${t('本设备')}` : ''}`}
                desc={t('{ip} · 登录于 {created} · 最后活动 {seen}', {
                  ip: s.ip,
                  created: when(s.createdAt),
                  seen: when(s.lastSeen),
                })}
              >
                <Button size="sm" variant="ghost" onClick={() => void kick(s.id)}>
                  {t('退出登录')}
                </Button>
              </Row>
            ))}
            <Row title={t('退出所有设备')} desc={t('怀疑密码泄露时用：所有外网设备都要重新登录')}>
              <Button size="sm" variant="secondary" onClick={logoutAll}>
                {t('全部退出')}
              </Button>
            </Row>
          </>
        )}
      </Group>
    </>
  )
}
