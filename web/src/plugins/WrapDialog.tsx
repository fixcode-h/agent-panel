import { useEffect, useState } from 'react'
import { Bot, Download, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { pluginWrapContract as W, type WrapPreview } from '@shared/api-contract/plugin-wrap'
import type { PluginManifest } from '@shared/plugins/types'
import { call } from '@/lib/api/call'
import { runPromptInProject } from '@/lib/assist-conv'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { ScanFindings } from '@/components/ui/scan-findings'
import { WrapPreviewBody } from '@/components/ui/wrap-preview'
import { configScanApi } from '@/lib/api-config-scan'
import { pluginApi } from './api'
import { pluginIcon } from './icon'
import { loadPlugins } from './registry'
import { closeWrap, openWrap, useWrapRequest, type WrapRequest } from './wrap-state'

/**
 * 「从 GitHub 链接包装…」（ADR 0068，效果图 5）：贴链接 → 服务端下载、识别、生成插件包、扫描（不执行任何东西）→
 * 预览里改勾选、改生效范围（重新生成）→ 「包装并安装」后才在插件目录里跑白名单安装动作。
 * 认不出来时给「AI 帮我包装」：开一个分析对话写配方，做完再回到这个弹窗预览。更新包装插件也走这里（只列新增发现和权限变化）
 */

/** 「AI 帮我包装」：分析对话的最后一条回复交服务端校验，配方对了就带着它重新打开弹窗 */
function wrapWithAi(url: string) {
  runPromptInProject({
    projectId: '',
    title: t('AI 包装 {repo}', { repo: url.replace(/^https?:\/\/github\.com\//, '') }),
    analysis: 'run',
    prompt: async () => (await call(W.aiPrompt, { body: { url } })).prompt,
    resolve: async (text) => {
      const r = await call(W.aiResolve, { body: { url, text } })
      if (!r.recipe) return { error: r.error ?? '' }
      openWrap({ url, recipe: r.recipe })
      return {}
    },
  })
}

function usePreview(req: WrapRequest | null) {
  const [preview, setPreview] = useState<WrapPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async (opts: { picks?: string[]; activation?: 'global' | 'project' } = {}) => {
    if (!req?.url) return
    setBusy(true)
    setError('')
    try {
      setPreview(
        await call(W.preview, {
          body: {
            url: req.url,
            ...(req.update && { update: true }),
            ...(req.recipe && { recipe: req.recipe }),
            ...opts,
          },
        }),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    setPreview(undefined)
    setError('')
    void load()
    // 每次打开（seq 变了）重新读一次；load 跟着 req 变，不放进依赖免得读两遍
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.seq])
  return { preview, busy, error, load }
}

export function WrapDialog() {
  const req = useWrapRequest()
  const [url, setUrl] = useState('')
  const [ack, setAck] = useState(false)
  const [installing, setInstalling] = useState(false)
  const { preview, busy, error, load } = usePreview(req)
  useEffect(() => {
    setUrl(req?.url ?? '')
    setAck(false)
  }, [req?.seq])
  const info = preview?.wrap
  const m = preview?.manifest as PluginManifest | undefined
  const scan = preview?.scan ?? []
  const needAck = scan.some((f) => f.level === 'high') || !!info?.steps.some((s) => s.advanced)
  const close = () => !installing && closeWrap()
  const install = async () => {
    if (!preview?.token || !m) return
    setInstalling(true)
    try {
      await pluginApi.confirm(preview.token)
      await loadPlugins()
      toast.success(
        preview.installed
          ? t('已更新插件 {name}', { name: m.name })
          : t('已安装插件 {name}，打开开关后生效', { name: m.name }),
      )
      closeWrap()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }
  const toggle = (key: string, on: boolean) => {
    if (!info) return
    const picks = on ? [...info.picks, key] : info.picks.filter((k) => k !== key)
    void load({ picks, activation: info.activation })
  }
  const asking = !!req && !req.url
  return (
    <Modal
      open={!!req}
      onOpenChange={(o) => !o && close()}
      size="lg"
      title={req?.update ? t('更新包装插件') : t('从 GitHub 包装插件')}
      footer={
        asking ? (
          <>
            <Button variant="secondary" className="ml-auto" onClick={close}>
              {t('取消')}
            </Button>
            <Button onClick={() => url.trim() && openWrap({ url: url.trim() })} disabled={!url.trim()}>
              {t('读取')}
            </Button>
          </>
        ) : (
          <>
            {info && !info.unrecognized && (
              <span className="text-xs text-subtle">{t('装好后在插件页能关、能删，删掉不留东西')}</span>
            )}
            {needAck && preview?.token && (
              <Checkbox checked={ack} onChange={setAck} label={t('我看过了，仍然安装')} disabled={installing} />
            )}
            <Button variant="secondary" className="ml-auto" onClick={close} disabled={installing}>
              {t('取消')}
            </Button>
            {info?.unrecognized ? (
              <Button
                onClick={() => {
                  wrapWithAi(req!.url)
                  closeWrap()
                }}
              >
                <Bot className="h-3.5 w-3.5" />
                {t('AI 帮我包装')}
              </Button>
            ) : (
              <Button
                onClick={() => void install()}
                disabled={!preview?.token || busy || installing || (needAck && !ack)}
                data-wrap-install
              >
                {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {preview?.installed ? t('更新') : t('包装并安装')}
              </Button>
            )}
          </>
        )
      }
    >
      {asking ? (
        <div className="flex flex-col gap-1.5">
          <Input
            aria-label={t('GitHub 链接')}
            value={url}
            autoFocus
            placeholder="https://github.com/owner/repo"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && url.trim() && openWrap({ url: url.trim() })}
            className="font-mono"
          />
          <span className="text-xs text-subtle">
            {t(
              '贴一个开源项目的链接，自动识别成技能、MCP、命令行或网页应用，生成标准插件包。分析时只下载、不运行任何代码；插件市场里有审核过的配方时按配方来。',
            )}
          </span>
        </div>
      ) : error ? (
        <div className="flex flex-col gap-2">
          <p className="text-body break-all text-danger">{error}</p>
          <Button size="sm" variant="secondary" className="self-start" onClick={() => void load()}>
            {t('重试')}
          </Button>
        </div>
      ) : !info ? (
        <p className="flex items-center gap-2 text-body text-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('正在下载 {repo} 并识别（不运行任何代码）…', { repo: req?.url ?? '' })}
        </p>
      ) : (
        <WrapPreviewBody
          info={info}
          name={m?.name}
          version={m?.version}
          description={m?.description}
          icon={m ? pluginIcon(m.icon) : undefined}
          busy={busy}
          onToggle={info.editable ? toggle : undefined}
          onActivation={(a) => void load({ picks: info.editable ? info.picks : undefined, activation: a })}
        >
          {info.unrecognized ? (
            <p className="text-body text-muted">
              {t(
                '这个仓库里没找到技能、MCP 服务、命令行工具或网页应用。可以让 AI 读一遍仓库写一份配方：开一个分析对话，写好后回到这里预览，照样过扫描和确认。',
              )}
            </p>
          ) : (
            <ScanFindings
              findings={scan}
              onIgnore={async (f) => {
                await configScanApi.ignore(f, preview?.scanScope ?? '')
                void load({ picks: info.editable ? info.picks : undefined, activation: info.activation })
              }}
            />
          )}
        </WrapPreviewBody>
      )}
    </Modal>
  )
}
