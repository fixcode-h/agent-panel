/** Orchestra 里需求原话对照表那部分（shared/run/needs.ts）：write_state 的 needs 参数走它 */
export interface OrchNeeds {
  /** 新拆条目、逐条标落地 / 延期 / 不做；子任务调用时拒绝（结果交回节点由节点标） */
  trackNeeds?: (raw: unknown) => { ok: boolean; info: string }
}
