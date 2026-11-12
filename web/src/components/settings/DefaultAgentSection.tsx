import { CLIS } from '@shared/clis'
import { cliApi } from '@shared/accounts'
import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { useCliDef } from '@/lib/cli-models'
import type { useModelCatalog } from '@/lib/model-catalog'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Group, ReadValue, Row } from '@/components/settings/parts'
import { RestoreSettings } from '@/components/settings/RestoreSettings'
import { CustomClis } from '@/components/settings/CustomClis'
import { AssistModel, TierTable, defaultEffortText, defaultModelText } from '@/components/settings/CliSection'
import type { CliDrafts } from '@/components/settings/use-cli-drafts'

/**
 * 设置 →「默认 Agent」（Agent 二级列表的第一页）：默认 Agent 和它的模型、模型目录、图片生成。
 * 从 pages/SettingsPage.tsx 挪出；CLI 草稿和默认 Agent 由设置页持有（CLI 页、AI 创建也读），这里按参数拿。
 */
export function DefaultAgentSection({
  cli,
  apis,
  modelCatalog,
  onModelCatalog,
  catalog,
  imageGen,
  onImageGen,
  designRestore,
  onDesignRestore,
  demo,
  onSection,
}: {
  cli: Pick<CliDrafts, 'ordered' | 'statusOf' | 'drafts' | 'defCli' | 'setDefCli'>
  apis: Settings['apis']
  modelCatalog: Settings['modelCatalog']
  onModelCatalog: (v: Settings['modelCatalog']) => void
  /** 模型目录在打开设置时就开始读（设置页里调 useModelCatalog），这里只显示 */
  catalog: ReturnType<typeof useModelCatalog>
  imageGen: Settings['imageGen']
  onImageGen: (v: Settings['imageGen']) => void
  designRestore: Settings['designRestore']
  onDesignRestore: (v: Settings['designRestore']) => void
  demo: boolean
  onSection: (s: string) => void
}) {
  const { ordered, statusOf, drafts, defCli, setDefCli } = cli
  const defDef = useCliDef(defCli) ?? CLIS.find((c) => c.id === defCli)!
  const defDraft = drafts[defCli]
  const defApi =
    defDraft.authMode === 'api'
      ? cliApi(
          defDef.auth,
          apis.find((a) => a.id === defDraft.apiId),
          defDraft.apiProtocol,
        )
      : undefined
  const defProtocol = defApi?.protocol
  return (
    <>
      <p className="text-body text-subtle">{t('没指定 Agent 和模型的角色都用这里的设置。')}</p>
      <Group>
        <Row
          title={t('默认 Agent')}
          desc={t('角色没指定 Agent 时用')}
          hint={t(
            '角色可以不指定 Agent，选「系统默认」时用这里的 Agent；模型可以只选高、中、低一档，执行时换成那个 Agent 对应档位的模型和思考强度。改这里就能让所有用默认设置的角色一起切换。',
          )}
        >
          <Select
            aria-label={t('默认 Agent')}
            value={defCli}
            onChange={(e) => setDefCli(e.target.value)}
            className="w-[240px]"
            // 停用或没安装的 CLI 不给选；当前的默认照常显示，并标出原因
            options={ordered
              .filter((c) => {
                const st = statusOf(c.id)
                return !st || (st.installed && st.enabled) || c.id === defCli
              })
              .map((c) => {
                const st = statusOf(c.id)
                const note = !st
                  ? ''
                  : !st.installed
                    ? ` · ${t('未安装')}`
                    : !st.enabled
                      ? ` · ${t('已停用')}`
                      : drafts[c.id]?.authMode === 'api' && c.auth?.api?.noImages
                        ? ` · ${t('API 方式不能生图')}`
                        : ''
                return { value: c.id, label: c.name + note }
              })}
          />
        </Row>
      </Group>
      <Group title={t('{cli} 的模型', { cli: defDef.name })}>
        <Row
          title={t('三档模型')}
          desc={
            <>
              {t('跟随 {cli} 的设置', { cli: defDef.name })}
              {' · '}
              <Button variant="link" className="inline" onClick={() => onSection(`cli:${defCli}`)}>
                {t('去修改')}
              </Button>
            </>
          }
          stack
        >
          <TierTable
            def={defDef}
            value={defDraft.tiers}
            defaultModel={defDraft.defaultModel}
            protocol={defProtocol}
            apiModelMap={defApi?.modelMap}
            apiModelEfforts={defApi?.modelEfforts}
            readOnly
          />
        </Row>
        {/* 默认模型和思考强度也只展示，在对应 CLI 里改 */}
        <Row title={t('默认模型')} desc={t('角色没指定模型时用')}>
          <ReadValue mono>{defaultModelText(defDef, drafts[defCli])}</ReadValue>
        </Row>
        <Row title={t('默认思考强度')} desc={t('角色和档位都没指定时用')}>
          <ReadValue>{defaultEffortText(defDef, defDraft)}</ReadValue>
        </Row>
      </Group>
      <Group title={t('模型目录')}>
        <Row
          title={t('AI 补全模型信息')}
          desc={t('目录里没有的模型联网查')}
          hint={t(
            '模型目录里没有的模型，可以在三档模型旁边点「AI 补全」，用「AI 创建」里设置的 Agent 联网查上下文窗口、最大输出、默认和可选的思考强度。',
          )}
        >
          <Switch
            aria-label={t('未知模型用 AI 补全')}
            checked={modelCatalog.aiLookup}
            onCheckedChange={(v) => onModelCatalog({ ...modelCatalog, aiLookup: v })}
          />
        </Row>
        <Row
          title={t('补充目录')}
          desc={t('已收录 {n} 个模型', { n: catalog?.entries.length ?? 0 })}
          hint={t('AI 补全的模型信息写在这个文件里，和内置目录合并使用。')}
        >
          <ReadValue mono>{catalog?.file || '~/.agent-panel/config/models.json'}</ReadValue>
        </Row>
      </Group>
      <Group title={t('图片生成')}>
        <Row
          title={t('生图 Agent')}
          desc={t('UI 设计生成图片时用')}
          hint={t('UI 设计里生成图片时使用。目前只有 Codex 内置了生图工具，用 ChatGPT 账号登录即可，不需要 API Key。')}
        >
          <Select
            aria-label={t('图片生成 Agent')}
            value={imageGen.cli}
            onChange={(e) => onImageGen({ ...imageGen, cli: e.target.value, model: '' })}
            className="w-[240px]"
            options={ordered
              .filter((c) => {
                const st = statusOf(c.id)
                return c.images && (!st || (st.installed && st.enabled) || c.id === imageGen.cli)
              })
              .map((c) => {
                const st = statusOf(c.id)
                const note = !st
                  ? ''
                  : !st.installed
                    ? ` · ${t('未安装')}`
                    : !st.enabled
                      ? ` · ${t('已停用')}`
                      : drafts[c.id]?.authMode === 'api' && c.auth?.api?.noImages
                        ? ` · ${t('API 方式不能生图')}`
                        : ''
                return { value: c.id, label: c.name + note }
              })}
          />
        </Row>
        <Row title={t('生图模型')} desc={t('不选时用这个 Agent 的高档模型')}>
          <div>
            <AssistModel
              cli={imageGen.cli}
              draft={drafts[imageGen.cli]}
              value={imageGen.model}
              onChange={(model) => onImageGen({ ...imageGen, model })}
              label={t('图片生成模型')}
              fallback="@high"
            />
          </div>
        </Row>
        <Row
          title={t('同时生成')}
          desc={t('最多并行生成几张图')}
          hint={t(
            'Agent 是每张图各开一个进程，最多同时开这么多个；浏览器是在选中的 Gemini / ChatGPT 标签页里只开这么多个对话（网页左边的对话列表里能看到），之后的图排队，哪个对话空了就接着用哪个。',
          )}
        >
          <Select
            aria-label={t('同时生成几张')}
            value={String(imageGen.concurrency)}
            onChange={(e) => onImageGen({ ...imageGen, concurrency: Number(e.target.value) })}
            className="w-[240px]"
            options={Array.from({ length: 10 }, (_, i) => ({
              value: String(i + 1),
              label: i + 1 === 3 ? t('{n} 个（默认）', { n: i + 1 }) : t('{n} 个', { n: i + 1 }),
            }))}
          />
        </Row>
      </Group>
      <RestoreSettings value={designRestore} onChange={onDesignRestore} />
      <CustomClis demo={demo} />
    </>
  )
}
