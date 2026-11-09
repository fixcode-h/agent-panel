import { t } from '../../i18n.ts'
import type { PluginManifest } from '../types.ts'
import { BLENDER_AGENTS, BLENDER_WORKFLOWS } from './builtin.ts'

/**
 * Blender 插件（ADR 0059）：一比一接入 dsh-blender-plugin 的建模能力（6 个模型工具、34 族 228 个算子、
 * Gateway 后端、Blender 端扩展 DSH Blender Bridge、blender-modeling 技能），
 * 并收进面板原有的 Blender 能力（两个技能、「Blender 建模」角色和工作流、模型设计）。
 * 上游代码原样放在 plugins/blender/dsh/（改动见那里的 VENDORED.md），服务端适配在 server/plugins/blender/。
 */

/** 上游版本：和 plugins/blender/dsh/package.json 一致 */
export const DSH_VERSION = '3.1.0-alpha.1'

/** 哪些对话挂 Blender 工具 */
export const ATTACH_AUTO = 'auto'
export const ATTACH_ALL = 'all'

/** 用到这些技能的角色视为 Blender 角色：对话挂上 Blender 工具 */
export const BLENDER_SKILLS = ['blender-modeling', 'blender', 'blender-model-animation-workflow']

/** MCP 服务名：上游 6 个工具一个，模型设计预览的 2 个工具一个 */
export const DSH_SERVER = 'blender'
export const MODEL_SERVER = 'blender-model'

export const BLENDER_PLUGIN: PluginManifest = {
  id: 'blender',
  name: 'Blender',
  version: DSH_VERSION,
  icon: 'box',
  description: () =>
    t(
      '让 Agent 直接驱动你的 Blender：GUI 会话里执行 Python、看视口、跑 228 个建模算子，无头作业和渲染排队执行；附带模型设计页。',
    ),
  source: {
    name: 'dsh-blender-plugin',
    url: 'https://github.com/sixtysevenlf/dsh-blender-plugin',
    version: DSH_VERSION,
    license: 'BSD-3-Clause',
  },
  settings: () => [
    {
      key: 'blenderPath',
      type: 'path',
      group: 'Blender',
      label: t('Blender 可执行文件'),
      desc: t('留空时在安装目录、Steam 和 PATH 里找；模型设计也用它'),
      placeholder: t('自动查找'),
      default: '',
      env: 'DSH_BLENDER_EXE',
    },
    {
      key: 'workDir',
      type: 'path',
      group: 'Blender',
      label: t('工作目录'),
      desc: t('截帧、无头脚本和产物放这里，Blender 和面板都要能读写'),
      placeholder: t('自动'),
      default: '',
      env: 'DSH_BLENDER_WORKDIR',
    },
    {
      key: 'gatewayPort',
      type: 'number',
      group: t('运行'),
      label: t('Gateway 端口'),
      desc: t('Blender 扩展连的就是这个端口，两边要一致'),
      default: 39877,
      min: 1024,
      max: 65535,
      env: 'DSH_BLENDER_GATEWAY_PORT',
    },
    {
      key: 'virtualGui',
      type: 'select',
      group: t('运行'),
      label: t('虚拟 GUI'),
      desc: t('允许在后台开不弹窗的 Blender 窗口（Linux 上是预览功能）'),
      default: 'default',
      options: [
        { value: 'default', label: t('按系统（Windows 自动，其他关）') },
        { value: 'off', label: t('关') },
        { value: 'auto', label: t('自动') },
        { value: 'on', label: t('开') },
      ],
      env: 'DSH_BLENDER_VIRTUAL_GUI',
    },
    {
      key: 'virtualGuiMax',
      type: 'number',
      group: t('运行'),
      label: t('虚拟 GUI 实例上限'),
      desc: t('同时开着的后台 Blender 最多几个；内存不够时会自动降到 2'),
      default: 4,
      min: 1,
      max: 16,
      env: 'DSH_BLENDER_VIRTUAL_GUI_MAX',
    },
    {
      key: 'headlessWaitSeconds',
      type: 'number',
      group: t('运行'),
      label: t('无头作业等待窗口'),
      desc: t('超过这个时间转成后台作业，用 collect 收结果'),
      default: 100,
      min: 5,
      max: 3600,
      unit: t('秒'),
      env: 'DSH_HEADLESS_WAIT_MS',
    },
    {
      key: 'leaseMinutes',
      type: 'number',
      group: t('运行'),
      label: t('写权限租约'),
      desc: t('持有写权限的对话这么久没动静就自动释放'),
      default: 10,
      min: 1,
      max: 240,
      unit: t('分钟'),
      env: 'DSH_BLENDER_LEASE_TTL_MS',
    },
    {
      key: 'attach',
      type: 'select',
      group: t('运行'),
      label: t('哪些对话挂 Blender 工具'),
      desc: t('工具说明较长，挂到所有对话会占上下文'),
      default: ATTACH_AUTO,
      options: [
        { value: ATTACH_AUTO, label: t('模型设计和 Blender 角色') },
        { value: ATTACH_ALL, label: t('所有对话') },
      ],
    },
    {
      key: 'autoStart',
      type: 'boolean',
      group: t('运行'),
      label: t('打开插件时就启动 Gateway'),
      desc: t('关掉时第一次调用 Blender 工具才启动'),
      default: true,
    },
  ],
  skills: BLENDER_SKILLS,
  skillGuide: {
    'blender-modeling':
      '用 Blender 建模、按参考图还原、量比例、装配体检、修穿模和浮空、白模、交付导出与验收时（配合 blender_* 工具）',
    blender: '用无头 Blender 建模、检查、多视角截图或导出 FBX 时',
    'blender-model-animation-workflow': '制作可拆分的 Blender 模型和循环动画时',
  },
  agents: BLENDER_AGENTS,
  workflows: BLENDER_WORKFLOWS,
  mcpServers: [DSH_SERVER, MODEL_SERVER, 'agent-panel-blender'],
  toolNames: () => ({
    blender_session: t('会话'),
    blender_op: t('算子'),
    blender_py: t('执行 Python'),
    blender_see: t('看视口'),
    blender_run: t('作业'),
    blender_inspect: t('只读检查'),
    blender_python: t('执行 Blender 脚本'),
    blender_scene: t('查看场景'),
  }),
  features: ['modelDesign'],
}
