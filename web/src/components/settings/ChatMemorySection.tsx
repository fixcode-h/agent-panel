import { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { api, type ChatMemoryView } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Group } from './parts'
import { Input, Textarea } from '@/components/ui/input'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 设置 ·「关于我与记忆」（设计报告 Chat P1-4）：Chat 页的每个对话都带上这里的内容（server/chat-memory.ts）。
 * 「关于我」是用户自己写的；记忆是 Chat 里模型用 remember 记下的长期偏好，这里能看、能删、也能自己加一条。
 * 项目里的对话不带：它们有项目说明文件和项目教训
 */
export function ChatMemorySection() {
  const [data, setData] = useState<ChatMemoryView | null>(null)
  const [about, setAbout] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    api
      .chatMemory()
      .then(setData)
      .catch((e) => toast.error((e as Error).message))
  }, [])
  const run = async (key: string, fn: () => Promise<ChatMemoryView>) => {
    setBusy(key)
    try {
      setData(await fn())
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setBusy('')
    }
  }
  if (!data)
    return (
      <div className="flex items-center gap-2 text-body text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('读取中…')}
      </div>
    )
  const aboutText = about ?? data.about
  return (
    <div className="flex flex-col">
      <Group title={t('关于我')} plain>
        <p className="pb-2 pl-1 text-body leading-relaxed text-subtle">
          {t(
            '写下你希望 Agent 一直记得的事：怎么称呼你、回复用什么语言和格式、你常用的技术栈。Chat 页的每个对话都会带上，不用每次重说；项目里的对话不带。',
          )}
        </p>
        <Textarea
          value={aboutText}
          maxLength={4000}
          rows={5}
          placeholder={t('例如：叫我小王；回复用中文，先给结论再展开；前端用 React + TypeScript')}
          onChange={(e) => setAbout(e.target.value)}
        />
        <div className="flex justify-end pt-2">
          <Button
            size="sm"
            disabled={about === null || about === data.about || !!busy}
            onClick={async () => {
              if (await run('about', () => api.saveChatAbout(aboutText))) {
                setAbout(null)
                toast.success(t('已保存「关于我」'))
              }
            }}
          >
            {busy === 'about' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('保存')}
          </Button>
        </div>
      </Group>

      <Group title={t('记忆')} plain>
        <p className="pb-2 pl-1 text-body leading-relaxed text-subtle">
          {t(
            'Chat 里 Agent 发现你以后也该记住的偏好时会记一条，之后的 Chat 对话都会带上。记错了就删掉；也可以自己加。',
          )}
          <span className="ml-1.5 text-xs">{t('{n} 条', { n: data.items.length })}</span>
        </p>
        <div className="settings-card">
          {data.items.length ? (
            [...data.items].reverse().map((x) => (
              <div key={x.id} className="flex items-center gap-3 border-b py-2.5 last:border-b-0">
                <span className="min-w-0 flex-1 text-body leading-relaxed [overflow-wrap:anywhere]">{x.text}</span>
                <span className="shrink-0 text-caption text-subtle tabular-nums">{x.at.slice(0, 10)}</span>
                <IconButton
                  size="sm"
                  icon={Trash2}
                  label={t('删掉这条记忆')}
                  disabled={!!busy}
                  onClick={() => void run(x.id, () => api.forgetChatMemory(x.id))}
                />
              </div>
            ))
          ) : (
            <p className="py-3 text-center text-body text-subtle">{t('还没有记忆')}</p>
          )}
        </div>
        <form
          className="flex items-center gap-2 pt-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (adding.trim() && (await run('add', () => api.addChatMemory(adding)))) setAdding('')
          }}
        >
          <Input
            value={adding}
            maxLength={300}
            placeholder={t('自己加一条，例如：我的电脑是 Windows，命令要能在 PowerShell 里跑')}
            onChange={(e) => setAdding(e.target.value)}
            className="flex-1"
          />
          <Button size="sm" variant="secondary" type="submit" disabled={!adding.trim() || !!busy}>
            {busy === 'add' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t('添加')}
          </Button>
        </form>
      </Group>
    </div>
  )
}
