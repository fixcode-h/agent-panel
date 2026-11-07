import { useState } from 'react'
import { Check, Circle, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { FrpTestStep } from '@shared/remote'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Row } from './parts'

/**
 * frp 的「连接测试」：服务端从本机按顺序试配置、本机外网端口、云服务器 frp 端口、frpc、经云服务器打开面板，
 * 断在哪一段就停在哪、写清楚该去查什么（见 server/frp-test.ts）
 */
export function FrpTest() {
  const [steps, setSteps] = useState<FrpTestStep[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const run = async () => {
    setRunning(true)
    setError('')
    try {
      setSteps(await api.remoteFrpTest())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const passed = steps?.every((s) => s.ok)
  return (
    <Row
      title={t('连接测试')}
      desc={
        steps && !running
          ? passed
            ? t('全部通过：其他设备可以从外网打开面板')
            : t('没有通过，按下面红色那一步的提示处理')
          : t('从本机经云服务器绕一圈打开面板，看哪一段不通')
      }
      stack
    >
      <div className="flex flex-col gap-2.5">
        <div>
          <Button size="sm" variant="secondary" onClick={run} disabled={running}>
            {running ? t('正在测试…') : steps ? t('重新测试') : t('开始测试')}
          </Button>
        </div>
        {error && <p className="text-footnote text-danger">{error}</p>}
        {steps && (
          <ol className="flex flex-col gap-1.5">
            {steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-body">
                {s.ok === true ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                ) : s.ok === false ? (
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                ) : (
                  <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-line-strong" />
                )}
                <div className="flex min-w-0 flex-col">
                  <span className={s.ok === null ? 'text-subtle' : 'text-fg'}>{s.title}</span>
                  {s.detail && (
                    <span
                      className={`text-footnote leading-relaxed break-words ${s.ok === false ? 'text-danger' : 'text-subtle'}`}
                    >
                      {s.detail}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Row>
  )
}
