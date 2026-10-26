import { useCallback, useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import type { BundledSkill } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from './api'
import { refreshSkillUpdates } from './skill-updates'

/**
 * 自带 Skill 列表和安装动作：左栏列表、右详情页共用一份，
 * 谁装完都重新读一遍，两边的状态标签才不会一前一后对不上。
 */
export function useBundledSkills() {
  const [items, setItems] = useState<BundledSkill[] | null>(null)
  const [error, setError] = useState('')
  /** 正在装的项名（'all' / 'update-all' 是批量），同时只跑一个：都在写 ~/.agents/skills */
  const [busy, setBusy] = useState('')

  const load = useCallback(
    () =>
      api
        .bundledSkills()
        .then((d) => {
          setItems(d.items)
          setError('')
        })
        .catch((e) => setError((e as Error).message)),
    [],
  )

  useEffect(() => {
    void load()
    // 只在打开时读一次；装完由 install 里重新读
  }, [load])

  /** key 用来标记是哪一项在装（也是提示文案的口径：批量时是「更新」） */
  const install = useCallback(
    async (names: string[], key: string, overwrite: boolean) => {
      setBusy(key)
      try {
        const r = await api.installBundled({ names, clis: [], overwrite })
        if (!r.done.length) toast.success(t('都已经是最新的了'))
        // 批量更新时说的是「更新」：装了没有的和换回自带版本是两件事
        else if (key === BUNDLED_UPDATE_ALL) toast.success(t('更新了 {n} 项', { n: r.done.length }))
        else toast.success(t('装好了 {n} 项', { n: r.done.length }))
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        // 失败也重读：出错前可能已经装进去了几项，列表得跟磁盘对得上
        await load()
        void refreshSkillUpdates()
        setBusy('')
      }
    },
    [load],
  )

  return { items, error, busy, load, install }
}

/** 「更新全部」这个批量操作的 key：install 里按它区分提示文案 */
export const BUNDLED_UPDATE_ALL = 'update-all'
/** 「安装全部未装的」这个批量操作的 key */
export const BUNDLED_INSTALL_ALL = 'all'

/** 状态标签的文案：安装状态只有三种 */
export const BUNDLED_STATUS_LABEL: Record<BundledSkill['status'][string], string> = {
  missing: t('未安装'),
  same: t('已安装'),
  changed: t('和自带的不同'),
}
