import { useCallback, useEffect, useState } from 'react'
import { FileCog, Pencil, Plus, Trash2 } from 'lucide-react'
import { customToolsContract as C } from '@shared/api-contract/custom-tools'
import type { ProgramPathView } from '@shared/custom-tools/programs'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { CapabilityBlockHeader, CapabilityItem, CapabilityItemList } from '@/components/ui/capability-item'
import { call } from '@/lib/api/call'
import { toast, toastError } from '@/lib/toast'

type Draft = { name: string; path: string; note: string; old?: string }

/**
 * 「技能与 MCP」页「工具」下的「程序位置」（shared/custom-tools/programs.ts）：Agent 找到 luac、导表工具这类程序后
 * 用 custom_tool action=locate 登记，之后每个对话开头都带上；这里看、改、删，也能自己登记。
 * 路径只在这台电脑上，存本机数据目录，不跟着项目文档走
 */
export function ProgramPathsBlock({ projectId, q }: { projectId: string; q: string }) {
  const [items, setItems] = useState<ProgramPathView[]>()
  const [file, setFile] = useState('')
  const [draft, setDraft] = useState<Draft>()
  const [error, setError] = useState('')
  /** 保存中：连点两下只存一次 */
  const [saving, setSaving] = useState(false)
  const reload = useCallback(() => {
    call(C.programs, { query: { projectId } })
      .then((r) => {
        setItems(r.items)
        setFile(r.file)
      })
      .catch(toastError)
  }, [projectId])
  useEffect(reload, [reload])

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      const r = await call(C.setProgram, { body: { projectId, name: draft.name, path: draft.path, note: draft.note } })
      if (!r.ok) return setError(r.info)
      // 改了名字：旧名字那条删掉，不留两条
      if (draft.old && draft.old.toLowerCase() !== draft.name.trim().toLowerCase())
        await call(C.removeProgram, { params: { name: draft.old }, query: { projectId } }).catch(() => undefined)
      toast.success(r.info)
      setDraft(undefined)
      reload()
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
    }
  }
  const remove = (name: string) =>
    call(C.removeProgram, { params: { name }, query: { projectId } })
      .then((r) => {
        if (r.ok) toast.success(r.info)
        else toast.error(r.info)
        reload()
      })
      .catch(toastError)
  const open = (d: Draft) => {
    setError('')
    setDraft(d)
  }

  const s = q.trim().toLowerCase()
  const list = (items ?? []).filter((p) => !s || [p.name, p.path, p.note].join(' ').toLowerCase().includes(s))
  return (
    <section className="flex flex-col gap-3" data-program-paths>
      <CapabilityBlockHeader
        title={t('程序位置')}
        meta={items ? t('{n} 个 · 只在本机，对话开头都会带上', { n: items.length }) : t('正在读取…')}
        action={
          <Button size="sm" variant="ghost" onClick={() => open({ name: '', path: '', note: '' })}>
            <Plus className="h-3.5 w-3.5" />
            {t('登记程序')}
          </Button>
        }
      />
      {list.length ? (
        <CapabilityItemList footer={file && <span className="font-mono text-caption text-subtle">{file}</span>}>
          {list.map((p) => (
            <CapabilityItem
              key={p.name}
              icon={FileCog}
              name={p.name}
              description={p.note || undefined}
              where={p.path}
              whereNote={t('{by} · {at}', { by: p.by || t('未知'), at: p.at.slice(0, 10) })}
              muted={p.missing}
              trailing={
                <>
                  {p.missing && <Badge tone="warning">{t('找不到了')}</Badge>}
                  <IconButton
                    icon={Pencil}
                    size="xs"
                    label={t('修改 {name}', { name: p.name })}
                    onClick={() => open({ name: p.name, path: p.path, note: p.note, old: p.name })}
                  />
                  <IconButton
                    icon={Trash2}
                    size="xs"
                    label={t('删掉 {name}', { name: p.name })}
                    onClick={() => void remove(p.name)}
                  />
                </>
              }
            />
          ))}
        </CapabilityItemList>
      ) : (
        <EmptyPanel size="md">
          {s
            ? t('没有符合筛选的程序。')
            : t(
                '还没有登记的程序。Agent 找到 luac、导表工具这类不在 PATH 里的程序后会记在这里，之后的对话直接用，不再全盘找。',
              )}
        </EmptyPanel>
      )}
      <Modal
        open={!!draft}
        onOpenChange={(v) => !v && setDraft(undefined)}
        title={draft?.old ? t('修改程序位置') : t('登记程序')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(undefined)}>
              {t('取消')}
            </Button>
            <Button onClick={() => void save()} disabled={saving || !draft?.name.trim() || !draft?.path.trim()}>
              {t('保存')}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="flex flex-col gap-3">
            <Field label={t('程序名')} hint={t('命令里写的名字，例如 luac')}>
              <Input
                aria-label={t('程序名')}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label={t('完整路径')}>
              <Input
                aria-label={t('完整路径')}
                className="font-mono"
                value={draft.path}
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
              />
            </Field>
            <Field label={t('用途（可选）')}>
              <Input
                aria-label={t('用途（可选）')}
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </Field>
            {/* 名字不对、路径不对、本机没有这个文件：服务端的原话，不分是哪一栏 */}
            {error && <p className="text-footnote break-all text-danger">{error}</p>}
          </div>
        )}
      </Modal>
    </section>
  )
}
