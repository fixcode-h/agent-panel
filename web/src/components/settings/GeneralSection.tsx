import { useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { toast } from '@/lib/toast'
import { type Settings, CONTENT_MAX, CONTENT_WIDTH } from '@shared/schema'
import { applyContentWidth, switchLang } from '@/lib/data'
import { LANGS, autoLangLabel, t } from '@shared/i18n'
import { WEBHOOK_MAX_ATTEMPTS } from '@shared/schedule'
import { notifyEnabled, notifySupported, setNotify } from '@/lib/notify'
import { hotkeyLabel } from '@/lib/hotkey'
import { pickButtonLabel } from '@/lib/element-pick'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Kbd } from '@/components/ui/kbd'
import { Advanced, Group, NumberField, Row } from '@/components/settings/parts'
import { QuotaResumeGroup } from '@/components/settings/QuotaResumeGroup'
import { ShellSetting } from '@/components/settings/ShellSetting'
import type { GeneralChecks, GeneralDraft } from '@/components/settings/general-draft'

/** 抓取键的显示名（「常规」里的开发者模式那行写着，细则在「快捷键」） */
const pickLabel = pickButtonLabel

/**
 * 「常规」页各小节共用的东西：草稿在设置页上（切页不丢、自动保存要读），这里只按 patch 改自己那几项。
 * 从 pages/SettingsPage.tsx 挪出，每个小节一个组件。
 */
interface GeneralProps {
  value: GeneralDraft
  checks: GeneralChecks
  onChange: (patch: Partial<GeneralDraft>) => void
}

/** 设置 →「常规」 */
export function GeneralSection({
  value,
  checks,
  onChange,
  elementPicker,
  demo,
  onSection,
  saveNow,
}: GeneralProps & {
  /** 抓取方式在「快捷键」里改，这里只显示 */
  elementPicker: Settings['elementPicker']
  demo: boolean
  onSection: (s: string) => void
  /** 立即保存（带上这几项改动），不等自动保存：切换语言后要重新加载页面 */
  saveNow: (patch: Partial<Settings>) => Promise<void>
}) {
  const props = { value, checks, onChange }
  return (
    <>
      {demo && (
        <p className="mb-2 flex gap-2.5 rounded-xl bg-sel/50 p-3.5 text-body leading-relaxed text-subtle">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
          {t('在线演示没有本机环境，任务的输出都是示例；下载到本机运行后会真正调用 Agent。')}
        </p>
      )}
      <GeneralUiGroup {...props} demo={demo} saveNow={saveNow} />
      <GeneralInputGroup {...props} />
      <GeneralRunGroup {...props} />
      <GeneralProcessGroup {...props} />
      <QuotaResumeGroup />
      <GeneralNotifyGroup {...props} demo={demo} elementPicker={elementPicker} onSection={onSection} />
    </>
  )
}

function GeneralUiGroup({
  value,
  onChange,
  demo,
  saveNow,
}: GeneralProps & { demo: boolean; saveNow: (patch: Partial<Settings>) => Promise<void> }) {
  const { language, contentWidth, openBrowser } = value
  return (
    <Group title={t('界面')}>
      <Row title="语言 · Language" desc={t('切换后页面会重新加载')}>
        <Select
          aria-label={t('语言')}
          value={language}
          onChange={async (e) => {
            const v = e.target.value as Settings['language']
            onChange({ language: v })
            // 文案在页面加载时就定了，保存后重新加载页面
            try {
              await saveNow({ language: v })
            } catch (err) {
              return toast.error((err as Error).message)
            }
            switchLang(v)
          }}
          options={[
            {
              value: 'auto',
              label: t('跟随浏览器 · {lang}', { lang: autoLangLabel(navigator.language) }),
            },
            ...LANGS.map((l) => ({ value: l.id, label: l.label })),
          ]}
          className="w-48"
        />
      </Row>
      <Row
        title={t('内容宽度')}
        desc={t('对话和任务列表的最大宽度')}
        hint={t('项目首页的输入框和任务列表、任务页的对话和工作流节点都用这个宽度，窗口窄时自动缩小。')}
      >
        <div className="flex items-center justify-end gap-3">
          {contentWidth !== CONTENT_WIDTH && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange({ contentWidth: CONTENT_WIDTH })
                applyContentWidth(CONTENT_WIDTH)
              }}
            >
              {t('恢复默认')}
            </Button>
          )}
          <input
            type="range"
            min={640}
            max={CONTENT_MAX}
            step={20}
            value={contentWidth}
            aria-label={t('内容宽度')}
            onChange={(e) => {
              const w = Number(e.target.value)
              onChange({ contentWidth: w })
              // 拖动时立即生效，不用等保存
              applyContentWidth(w)
            }}
            className="w-32 cursor-pointer accent-[var(--color-accent)]"
          />
          <span className="w-14 text-right font-mono text-body text-muted tabular-nums">{contentWidth}px</span>
        </div>
      </Row>
      {!demo && (
        <Row title={t('启动后打开浏览器')} desc={t('服务启动时自动打开面板')}>
          <Switch
            aria-label={t('启动后打开浏览器')}
            checked={openBrowser}
            onCheckedChange={(v) => onChange({ openBrowser: v })}
          />
        </Row>
      )}
    </Group>
  )
}

function GeneralInputGroup({ value, checks, onChange }: GeneralProps) {
  return (
    <Group title={t('输入')}>
      <Row
        title={t('我的称呼')}
        desc={t('AI 提问时怎么称呼你')}
        hint={t('提问卡片、子对话提问这些地方怎么称呼你，例如「需要用户回答」。不填写「用户」。')}
      >
        <Input
          aria-label={t('称呼')}
          value={value.userName}
          maxLength={20}
          placeholder={t('用户')}
          onChange={(e) => onChange({ userName: e.target.value })}
          className="ml-auto block w-40"
        />
      </Row>
      <Row
        title={t('默认允许提问')}
        desc={t('新会话的「提问」按钮默认打开')}
        hint={t('AI 有问题时弹出卡片问你，等你回答再继续；关着时 AI 自己选最合适的做法。已有的会话保持各自的选择。')}
      >
        <Switch
          aria-label={t('新会话默认开启提问')}
          checked={value.askUserDefault}
          onCheckedChange={(v) => onChange({ askUserDefault: v })}
        />
      </Row>
      <Row
        title={t('诊断报告显示作者')}
        desc={t('Bug 的引入点写出是谁的改动')}
        hint={t(
          '用户报的 Bug 查清后，诊断报告会写出问题是哪次改动引入的。打开时连作者一起写（照版本记录原文），关掉只写提交号和标题。',
        )}
      >
        <Switch
          aria-label={t('诊断报告显示作者')}
          checked={value.bugAuthor}
          onCheckedChange={(v) => onChange({ bugAuthor: v })}
        />
      </Row>
      <Row
        title={t('大文件只传路径')}
        desc={t('超过这个大小不上传，直接引用原文件')}
        hint={t('粘贴、拖进输入框的文件超过这么大时不上传、不拷进对话目录，面板在本机找到原文件后直接引用它的路径。')}
      >
        <NumberField
          value={value.largeMB}
          onChange={(v) => onChange({ largeMB: v })}
          unit="MB"
          invalid={!checks.large.ok}
          error={t('填 1 到 50 之间的整数')}
          label={t('大文件只引用路径（MB）')}
        />
      </Row>
      <Row
        title={t('长文本转文件')}
        desc={t('粘贴超过这么多字时存成附件')}
        hint={t('输入框里只放这个文件的卡片，消息不会被一大段文字撑满。')}
      >
        <NumberField
          value={value.longPaste}
          onChange={(v) => onChange({ longPaste: v })}
          unit={t('字')}
          empty={t('不转')}
          invalid={!checks.paste.ok}
          error={t('填 0 到 1000000 之间的整数，0 表示不转')}
          label={t('长文字存成文件（字）')}
        />
      </Row>
    </Group>
  )
}

function GeneralRunGroup({ value, checks, onChange }: GeneralProps) {
  const { fileFormat } = value
  return (
    <Group title={t('运行')}>
      <Row title={t('单步超时')} desc={t('超时停止这一步，任务记为失败')}>
        <NumberField
          value={value.timeout}
          onChange={(v) => onChange({ timeout: v })}
          unit={t('分钟')}
          empty={t('不限')}
          invalid={!checks.timeout.ok}
          error={t('填 0 到 1440 之间的整数，0 表示不限制')}
          label={t('单个步骤最长运行时间（分钟）')}
        />
      </Row>
      <Row
        title={t('无输出提醒')}
        desc={t('长时间没输出先提醒，再停止')}
        hint={t(
          'Agent 这么久没有任何输出时在任务里提醒一次，再过同样的时间还没有就自动停止，免得卡在登录或确认上一直显示执行中。',
        )}
      >
        <NumberField
          value={value.idle}
          onChange={(v) => onChange({ idle: v })}
          unit={t('分钟')}
          empty={t('不检测')}
          invalid={!checks.idle.ok}
          error={t('填 0 到 1440 之间的整数，0 表示不检测')}
          label={t('没有输出时提醒（分钟）')}
        />
      </Row>
      <Row
        title={t('子对话卡住时追问')}
        desc={t('替父对话问进展，不回就重启或换人接手')}
        hint={t(
          '子对话这么久没有任何输出时，面板以父对话的名义问它当前在做什么、是否卡住，收到回复就重新计时。问过之后再过这么久还没回复（正在跑命令时多等几倍），就停掉它、接回原会话重启；重启也没恢复，就在对话里记一条警告，新开一个子对话带上原任务和已有进展接手。',
        )}
      >
        <NumberField
          value={value.childAsk}
          onChange={(v) => onChange({ childAsk: v })}
          unit={t('分钟')}
          empty={t('关闭')}
          invalid={!checks.childAsk.ok}
          error={t('填 0 到 1440 之间的整数，0 表示不问')}
          label={t('子对话没有输出时自动询问（分钟）')}
        />
      </Row>
      <Row
        title={t('后台命令并发')}
        desc={t('测试、编译最多同时跑几条')}
        hint={t(
          '所有对话交给面板在后台跑的命令（完整测试、编译）超出这个数就排队，前面的跑完一条再开始。机器配置低时调小，免得一起跑卡住。',
        )}
      >
        <NumberField
          value={value.bgLimit}
          onChange={(v) => onChange({ bgLimit: v })}
          unit={t('条')}
          invalid={!checks.bg.ok}
          error={t('填 1 到 64 之间的整数')}
          label={t('同时运行的后台命令')}
        />
      </Row>
      <ShellSetting value={value.shell} onChange={(v) => onChange({ shell: v })} />
      <Advanced label={t('新建文件格式')}>
        <Row
          title={t('新建文件格式')}
          desc={t('面板写文件时用的编码和换行符')}
          hint={t(
            '面板写说明文件、部署全局说明，以及交给角色的约定都按这里来。默认 UTF-8（不带 BOM）+ LF：Windows 上编辑、WSL / Linux 里跑测试时，脚本不会因为 CRLF 或 BOM 报 bad interpreter。项目可以单独设置。',
          )}
        >
          <div className="flex flex-col gap-2">
            <Select
              aria-label={t('文件编码')}
              value={fileFormat.encoding}
              onChange={(e) =>
                onChange({ fileFormat: { ...fileFormat, encoding: e.target.value as typeof fileFormat.encoding } })
              }
              options={[
                { value: 'utf8', label: t('UTF-8（不带 BOM）') },
                { value: 'utf8-bom', label: 'UTF-8（带 BOM）' },
              ]}
            />
            <Select
              aria-label={t('换行符')}
              value={fileFormat.eol}
              onChange={(e) =>
                onChange({ fileFormat: { ...fileFormat, eol: e.target.value as typeof fileFormat.eol } })
              }
              options={[
                { value: 'lf', label: 'LF（Linux / macOS）' },
                { value: 'crlf', label: 'CRLF（Windows）' },
              ]}
            />
          </div>
        </Row>
      </Advanced>
    </Group>
  )
}

function GeneralProcessGroup({ value, checks, onChange }: GeneralProps) {
  return (
    <Group title={t('Agent 进程')}>
      <Row
        title={t('回收空闲 Agent')}
        desc={t('空闲到时结束进程，再用时续接会话')}
        hint={t(
          '回复完没人看着的空闲 Agent 会在「离开后保留」这段时间结束后回收，用户回来时重新启动（几秒，会话会续接）。正在执行的对话不受这段时间管，页面切到后台也照样跑完。关掉后不再按时间回收，进程会越攒越多。',
        )}
      >
        <Switch
          aria-label={t('自动回收闲置 Agent')}
          checked={value.reclaim}
          onCheckedChange={(v) => onChange({ reclaim: v })}
        />
      </Row>
      {value.reclaim && (
        <Row
          indent
          title={t('离开后保留')}
          desc={t('离开对话后 Agent 留多久')}
          hint={t(
            '填 0 表示回复完就结束这一轮。这段时间内回来发消息能直接接着说，不用重新启动 Agent；每个还在等的对话会占用一个 Agent 进程。只算回复完停在等下一句的空闲对话，正在执行的对话不会因为这个时长被收掉。',
          )}
        >
          <NumberField
            value={value.presence}
            onChange={(v) => onChange({ presence: v })}
            unit={t('分钟')}
            invalid={!checks.presence.ok}
            error={t('填 0 到 1440 之间的整数，0 表示不保留')}
            label={t('离开对话后保留多久（分钟）')}
          />
        </Row>
      )}
      <Row
        title={t('重启后自动继续')}
        desc={t('面板重启后接着跑被打断的对话')}
        hint={t(
          '打开后，面板重启时还在执行的对话会在启动后自动继续（和首页「全部继续」一样，连带拉起它们的子对话和子任务）。默认关：继续会花钱、会接着改项目，关着时由你在首页点「全部继续」或逐个继续。',
        )}
      >
        <Switch
          aria-label={t('面板重启后自动继续被打断的对话')}
          checked={value.resumeRestart}
          onCheckedChange={(v) => onChange({ resumeRestart: v })}
        />
      </Row>
      <Row
        title={t('子对话完成后保留')}
        desc={t('完成后 Agent 再留多久')}
        hint={t(
          '填 0 表示完成就结束。子对话彻底完成后，它的 Agent 先停在等下一句上，这段时间里父对话或你接着交代，直接交给同一个进程，不用重新启动；到点还没人用就结束，之后再交代会续接原会话。在独立分支里做的子对话完成时分支目录会删掉，Agent 随之结束，不受这一项影响。',
        )}
      >
        <NumberField
          value={value.childKeep}
          onChange={(v) => onChange({ childKeep: v })}
          unit={t('分钟')}
          invalid={!checks.childKeep.ok}
          error={t('填 0 到 1440 之间的整数，0 表示不保留')}
          label={t('子对话完成后 Agent 保留多久（分钟）')}
        />
      </Row>
      <Row
        title={t('自动归档')}
        desc={t('多久没动静的对话收进归档')}
        hint={t(
          '对话（连同子对话）这么多天没有动静、没在执行、回复也都看过了，就自动归档：列表里不再显示，在筛选里选「已归档」还能找到，随时可以取消归档。',
        )}
      >
        <NumberField
          value={value.archiveDays}
          onChange={(v) => onChange({ archiveDays: v })}
          unit={t('天')}
          empty={t('不归档')}
          invalid={!checks.archive.ok}
          error={t('填 0 到 3650 之间的整数，单位是天')}
          label={t('自动归档不动的对话')}
        />
      </Row>
    </Group>
  )
}

function GeneralNotifyGroup({
  value,
  onChange,
  demo,
  elementPicker,
  onSection,
}: GeneralProps & { demo: boolean; elementPicker: Settings['elementPicker']; onSection: (s: string) => void }) {
  // 浏览器通知开关存在这台浏览器里（不进设置文件），只有这一节用
  const [notify, setNotifyOn] = useState(notifyEnabled)
  return (
    <Group title={t('通知与安全')}>
      <Row title={t('任务完成通知')} desc={t('页面在后台时弹出系统通知')} hint={t('需要浏览器允许通知。')}>
        <Switch
          aria-label={t('任务完成时通知我')}
          checked={notify}
          disabled={!notifySupported()}
          onCheckedChange={async (on) => {
            const ok = await setNotify(on)
            setNotifyOn(ok)
            if (on && !ok) toast.error(t('浏览器没有允许通知，可以在地址栏左侧的网站设置里打开'))
          }}
        />
      </Row>
      <Row
        title={t('计划 Webhook')}
        desc={t('已并入「钩子」')}
        hint={t(
          '在「钩子」里新建一个「计划任务跑完」事件的 HTTP 钩子：计划成功启动、启动失败、错过或上游没成功时 POST 结果，失败最多重试 {n} 次。以前填的地址已经自动迁过去了。',
          { n: WEBHOOK_MAX_ATTEMPTS },
        )}
      >
        <Button size="sm" variant="secondary" onClick={() => onSection('hooks')}>
          {t('去钩子')}
        </Button>
      </Row>
      {!demo && (
        <Row
          title={t('访问令牌')}
          desc={t('只允许带令牌打开过的浏览器访问')}
          hint={t(
            '打开后，只有用启动时显示的地址（带 token）打开过的浏览器能访问面板，本机的其他程序不能直接调用接口。这个浏览器会自动获得授权。',
          )}
        >
          <Switch
            aria-label={t('访问令牌')}
            checked={value.requireToken}
            onCheckedChange={(v) => onChange({ requireToken: v })}
          />
        </Row>
      )}
      <Row
        title={t('开发者模式')}
        desc={t('输入框多一个「抓取界面元素」按钮')}
        hint={t(
          '也可以按快捷键开启抓取：抓取期间左键、右键照常可用，用设置里的鼠标键（默认中键）点选面板界面上的元素，它的源码位置、组件、文字和样式会作为引用放进输入框，发给 AI 修改面板自己的代码。Esc 退出。',
        )}
      >
        <Switch
          aria-label={t('开发者模式')}
          checked={value.developerMode}
          onCheckedChange={(v) => onChange({ developerMode: v })}
        />
      </Row>
      {value.developerMode && (
        <Row indent title={t('抓取方式')} desc={t('在「快捷键」里修改')}>
          <div className="flex items-center justify-end gap-2 text-body text-muted">
            <Kbd className="h-auto px-1.5 py-0.5 text-footnote">{hotkeyLabel(elementPicker.hotkey)}</Kbd>
            <span>{t('＋')}</span>
            <span>{pickLabel(elementPicker.button)}</span>
            <Button variant="ghost" size="sm" onClick={() => onSection('shortcuts')}>
              {t('去修改')}
            </Button>
          </div>
        </Row>
      )}
    </Group>
  )
}
