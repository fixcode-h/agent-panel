import type { LifeNode, LifeReport } from '../../shared/lifecycle.ts'
import { registerFixTopic } from '../fix.ts'

/** 状态诊断「AI 分析」用的 topic：服务端据此补上判定规则的说明（见 registerFixTopic） */
export const LIFECYCLE_TOPIC = 'task-lifecycle'

/** 交给 AI 的日志行数：够看出最近几轮请求、停止和退出，又不至于把提示撑爆（FixInput.output 上限 4 万字） */
const AI_LOG_LINES = 150

/**
 * 「AI 分析」交给 AI 的材料：选中的那个节点（对话或子任务）的结论、异常、计数、现状和最近的日志，
 * 外加整棵树的诊断文件路径——AI 要看父子对话之间的关系时自己去读。
 * 发给 Agent 的提示词不翻译（AGENTS.md）
 */
export function lifecycleAnalysis(r: LifeReport, node: LifeNode, file: string) {
  const v = node.verdict
  const counts = node.counts
    ? Object.entries(node.counts)
        .map(
          ([k, c]) => `${k}=${c.n}${c.last ? `（最近 ${new Date(c.last.at).toLocaleString()}：${c.last.text}）` : ''}`,
        )
        .join('\n')
    : ''
  const parent = r.nodes.find((n) => n.id === node.parentId)
  return {
    title: `对话状态诊断：${node.title || node.id}`.slice(0, 200),
    topic: LIFECYCLE_TOPIC,
    ask:
      '分析这个对话（或子任务）现在的状态是否正常：如果卡住、出错或停不下来，结合下面的结论、异常、计数和日志，' +
      '判断问题出在模型网关、CLI 自己还是面板的调度，列出证据（引用日志行的时间），给出用户现在能做的操作；' +
      '如果是面板自己的问题，写清复现条件和相关的异常编号，方便报给开发。不要修改任何文件。',
    error: [v.headline, v.why ?? '', ...v.anomalies.map((a) => `[${a.level}] ${a.code}：${a.text}`)]
      .filter(Boolean)
      .join('\n'),
    output: node.log.slice(-AI_LOG_LINES).join('\n'),
    context: [
      `节点：${node.kind} · ${node.title}（${node.id}）${parent ? `，父节点「${parent.title}」` : ''}`,
      node.cli || node.model ? `CLI / 模型：${[node.cli, node.model].filter(Boolean).join(' · ')}` : '',
      `采集时间：${r.generatedAt}；面板 ${r.panel.version}，${r.panel.platform}，Node ${r.panel.node}`,
      `进程：${node.processes.map((p) => `pid ${p.pid}`).join('、') || '无'}`,
      `事件计数（按完整日志）：\n${counts}`,
      `现状（facts）：${JSON.stringify(node.facts)}`,
      `整棵对话树的诊断文件（JSON，含每个节点的完整日志）：${file}`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000),
  }
}

registerFixTopic(LIFECYCLE_TOPIC, {
  context: () =>
    [
      '这是 Agent 面板（本机调度编码 CLI 的网页控制台）的「状态」诊断。读法：',
      '- 日志行格式「时间 [事件] 键=值」。模型请求开始 / 模型开始输出（waitedMs 是首字等待）/ CLI 重试模型请求 / CLI 报这一轮结束 来自 CLI 的事件流；CLI 进程启动 / 退出（code、signal、killed=stopped|timeout|idle、aliveMs）来自面板的进程登记。',
      '- facts.live 是面板内存里的执行位：stop=true 表示停止已发出还没收完；held 是排着等这一轮结束后处理的消息。',
      '- 异常编号：model-silent（请求发出很久没有输出）、output-stalled（输出到一半停住）、working-no-process（标着执行但进程没了）、child-idle-parent-waiting（子对话已停、父对话没被叫醒）、held-unhandled（排着的消息没人接）、slot-idle（执行位空占）、stop-slow（停止迟迟没收完）、process-leftover（收口后进程还在）、apiwait-stale、running-no-slot。',
    ].join('\n'),
})
