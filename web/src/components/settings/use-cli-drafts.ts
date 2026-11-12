import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { CLIS } from '@shared/clis'
import { cliApi } from '@shared/accounts'
import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { defaultCli, orderClis } from '@shared/settings'
import { api } from '@/lib/api'
import { loadCliModels, preloadCliModels, setCliMode } from '@/lib/cli-models'
import { resumeInstallJobs, setInstallFinish } from '@/lib/cli-install'
import { toDraft } from '@/components/settings/CliSection'
import type { useData } from '@/lib/data'

type Data = ReturnType<typeof useData>

/**
 * 设置页里各个 CLI 的草稿、顺序和默认 Agent（从 pages/SettingsPage.tsx 挪出）。
 * 左栏的二级列表、默认 Agent、AI 创建、经验和各个 CLI 页都读这一份，所以放在页面上、按显式参数传给各分区。
 */
export function useCliDrafts({
  initial,
  clis,
  refreshClis,
  setSettings,
  apis,
}: {
  initial: Settings
  clis: Data['clis']
  refreshClis: Data['refreshClis']
  setSettings: Data['setSettings']
  apis: Settings['apis']
}) {
  const [cliOrder, setCliOrder] = useState(() =>
    orderClis(CLIS, initial.cliOrder, (c) => initial.clis[c.id]?.enabled !== false).map((c) => c.id),
  )
  const [drafts, setDrafts] = useState(() => toDraft(initial))
  const statusOf = (id: string) => clis.find((c) => c.id === id)
  const isOn = (id: string) => drafts[id]?.enabled ?? true
  // 没安装的 CLI 一律不启用：开关不显示，分组也按未启用算；装好后由安装完成的逻辑重新打开
  useEffect(() => {
    setDrafts((ds) => {
      let changed = false
      const next = { ...ds }
      for (const c of clis)
        if (c.installed === false && next[c.id]?.enabled) {
          next[c.id] = { ...next[c.id], enabled: false }
          changed = true
        }
      return changed ? next : ds
    })
  }, [clis])
  // 已安装并且启用才算已接入；没安装的统一归到「未启用」，免得和真在用的混在一起
  const isReady = (id: string) => isOn(id) && statusOf(id)?.installed !== false
  // 已接入的排在前面；同一组里按拖动过的顺序，没拖过的按名字比较
  const ordered = orderClis(CLIS, cliOrder, (c) => isReady(c.id))
  // 拖动只改同一组里的顺序，不能跨过启用和停用的分界
  const moveCli = (id: string, to: number) =>
    setCliOrder((o) => {
      const list = orderClis(CLIS, o, (c) => isReady(c.id)).map((c) => c.id)
      const from = list.indexOf(id)
      if (from < 0 || to < 0 || to >= list.length || from === to) return o
      const on = isReady(id)
      let start = from
      let end = from
      while (start > 0 && isReady(list[start - 1]) === on) start--
      while (end < list.length - 1 && isReady(list[end + 1]) === on) end++
      const dest = Math.max(start, Math.min(end, to))
      if (dest === from) return o
      const next = list.filter((x) => x !== id)
      next.splice(dest, 0, id)
      return next
    })
  // 每个 CLI 上次保存时的登录方式和 API，变了才重新读模型
  const modelSig = useRef<Record<string, string>>({})
  const [detecting, setDetecting] = useState(false)
  const [defCli, setDefCli] = useState(() => defaultCli(initial))
  // 默认 CLI 被停用、又有别的启用了（例如新装后第一次打开一个）：默认换成按顺序第一个启用的
  useEffect(() => {
    if (drafts[defCli]?.enabled) return
    const first = ordered.find((c) => drafts[c.id]?.enabled)
    if (first) setDefCli(first.id)
    // 只跟着开关变化；ordered、defCli 变了不需要重新判断
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts])
  // 安装 / 卸载结束后重新检测，并提示结果；进度在 cli-install 里，切换页面不会丢
  useEffect(() => {
    setInstallFinish((j) => {
      const name = CLIS.find((c) => c.id === j.cli)?.name ?? j.cli
      void Promise.all([refreshClis().catch(() => {}), loadCliModels(j.cli, true).catch(() => {})])
      // 服务端改用了 npm 装的那个可执行文件：同步到这里，免得自动保存又改回去
      if (j.note)
        void api.settings().then((fresh) => {
          setSettings(fresh)
          setDrafts((d) => ({ ...d, [j.cli]: { ...d[j.cli], command: fresh.clis[j.cli]?.command ?? '' } }))
        })
      const kind = j.action === 'uninstall' ? 'uninstall' : j.update ? 'update' : 'install'
      if (j.status === 'done')
        toast.success(
          {
            install: t('{name} 已安装', { name }),
            update: t('{name} 已更新', { name }),
            uninstall: t('{name} 已卸载', { name }),
          }[kind],
        )
      else
        toast.error(
          {
            install: t('{name} 安装失败', { name }),
            update: t('{name} 更新失败', { name }),
            uninstall: t('{name} 卸载失败', { name }),
          }[kind],
        )
    })
    void resumeInstallJobs()
    // 只在安装结束时执行一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshClis])
  // 打开设置就开始读各个 CLI 的模型列表，切到 CLI 页时多半已经读好（Command Code 第一次要几秒）
  useEffect(() => {
    for (const c of CLIS) loadCliModels(c.id).catch(() => {})
  }, [])
  // 切换账号 / API 时模型下拉马上换成那种方式的列表，不等自动保存；
  // 模型从 CLI 列表读的（Command Code、Pi）两种方式的列表都提前读好，切换时不用等 CLI
  useEffect(() => {
    for (const c of CLIS) {
      const d = drafts[c.id]
      if (!d) continue
      setCliMode(c.id, { authMode: d.authMode, apiId: d.apiId, apiProtocol: d.apiProtocol })
      if (!d.enabled || c.auth?.api?.modelSource !== 'cli') continue
      preloadCliModels(c.id, { authMode: 'account' })
      if (d.apiId && apis.some((a) => a.id === d.apiId))
        preloadCliModels(c.id, { authMode: 'api', apiId: d.apiId, apiProtocol: d.apiProtocol })
    }
  }, [drafts, apis])

  /** 自动保存之后：登录方式、选的 API 或它的模型变了，这个 CLI 的模型下拉要重新读（账号和 API 各列各的） */
  const reloadChangedModels = (v: Settings) => {
    for (const c of CLIS) {
      const cs = v.clis[c.id]
      const a =
        cs?.authMode === 'api'
          ? cliApi(
              c.auth,
              v.apis.find((x) => x.id === cs.apiId),
              cs.apiProtocol,
            )
          : undefined
      const sig = `${cs?.authMode ?? 'account'}|${a ? `${a.id}|${a.name}|${a.provider}|${a.protocol}|${a.baseUrl}|${a.apiKey}|${a.models.join(',')}` : ''}`
      if (modelSig.current[c.id] !== undefined && modelSig.current[c.id] !== sig)
        void loadCliModels(c.id, true).catch(() => {})
      modelSig.current[c.id] = sig
    }
  }

  const detect = async () => {
    setDetecting(true)
    try {
      // 模型列表跟着重新读：装了新版本、换了账号或改了环境变量后能用的模型可能变了
      await Promise.all([refreshClis(), ...CLIS.map((c) => loadCliModels(c.id, true).catch(() => {}))])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDetecting(false)
    }
  }

  return {
    cliOrder,
    drafts,
    setDrafts,
    statusOf,
    isReady,
    ordered,
    moveCli,
    defCli,
    setDefCli,
    detecting,
    detect,
    reloadChangedModels,
  }
}

/** 各分区要用的那份 CLI 状态（见 useCliDrafts） */
export type CliDrafts = ReturnType<typeof useCliDrafts>
