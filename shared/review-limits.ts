/**
 * 评审子任务的边界数字（ADR 0013）：角色设定、面板的提醒和测试都从这里取，改一处全部跟着变。
 */

/** 软时限：到了就给还在跑的评审传话，要它停止再读代码、按已确认的交卷 */
export const REVIEW_SOFT_LIMIT_MIN = 6

/** 交接单和差异之外，评审最多读几次代码（只为确认一条具体的怀疑） */
export const REVIEW_READ_BUDGET = 3
