/**
 * 改完自动校验在调用记录里的那一行（ADR 0086）：不是 Agent 发起的调用，是面板自己跑的，单独记一行，
 * 设置「调用记录」页显示成「校验 · lua-check · 1 处报错 / 通过」。服务端网关和演示后端用同一份
 */
import type { CallRecord } from '../types.ts'
import type { VerifyRun } from './types.ts'

export type VerifyRecordBase = Pick<CallRecord, 'id' | 'at' | 'projectId' | 'taskId' | 'taskTitle' | 'turn' | 'cli'>

export function verifyRecord(base: VerifyRecordBase, run: VerifyRun): CallRecord {
  return {
    ...base,
    tool: run.tool,
    kind: 'panel',
    summary: run.files.join(' ').slice(0, 200),
    input: JSON.stringify({ files: run.files }).slice(0, 2000),
    capability: 'verify',
    decision: 'pass',
    ms: 0,
    durMs: run.ms,
    // 查出报错是检查跑通了；超时、没跑起来、退出码不对又认不出报错行才算这次执行失败
    ...(run.outcome === 'ok' || run.outcome === 'errors' ? {} : { failed: true }),
    // 不标只读：「本可以并行」只比 Agent 自己发的调用
    verify: run,
  }
}
