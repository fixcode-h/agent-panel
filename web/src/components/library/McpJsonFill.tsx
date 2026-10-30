import { useState } from 'react'
import { ScanSearch } from 'lucide-react'
import { parseMcpJson, type McpDraft } from '@shared/mcp-json'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'

/**
 * MCP 工具编辑弹窗顶部的「粘贴 JSON → 分析」：各家文档给的都是一段 JSON，
 * 拆开填进下面的名字、命令、参数、环境变量要手抄，这里一键填好。
 * 「MCP 工具」页和项目设置里的 MCP 两个弹窗共用。
 */
export function McpJsonFill({ onFill }: { onFill: (d: McpDraft) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  // JSON 里有多个工具时列出来，点哪个填哪个
  const [drafts, setDrafts] = useState<McpDraft[]>([])
  const [picked, setPicked] = useState('')

  const fill = (d: McpDraft) => {
    setPicked(d.name)
    onFill(d)
  }
  const analyze = () => {
    try {
      const list = parseMcpJson(text)
      setError('')
      setDrafts(list)
      fill(list[0])
    } catch (e) {
      setDrafts([])
      setError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.8125rem] font-medium">{t('从 JSON 填入')}</span>
      <Textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            analyze()
          }
        }}
        placeholder={'{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "..."] } } }'}
        spellCheck={false}
        className="font-mono text-[0.75rem]"
      />
      <div className="flex items-start gap-3">
        <span className={`min-w-0 flex-1 text-[0.75rem] ${error ? 'text-warning' : 'text-subtle'}`}>
          {error ||
            (drafts.length > 1
              ? t('JSON 里有 {n} 个工具，点名字切换要填的那个', { n: drafts.length })
              : drafts.length
                ? t('已填入下面的表单，保存前可以再改')
                : t('粘贴文档里的 MCP 配置，点「分析」自动填好下面各项'))}
        </span>
        <Button size="sm" variant="secondary" onClick={analyze} disabled={!text.trim()}>
          <ScanSearch className="h-3.5 w-3.5" />
          {t('分析')}
        </Button>
      </div>
      {drafts.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {drafts.map((d, i) => (
            <Button
              key={`${d.name}-${i}`}
              size="sm"
              variant={picked === d.name ? 'secondary' : 'ghost'}
              className="font-mono"
              onClick={() => fill(d)}
            >
              {d.name || t('（没有名字）')}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
