/**
 * 分片测试的并发上限：端到端和界面检查都按分片并行跑，每个分片自己的服务、浏览器和假 CLI 进程，
 * 全并发会把同一台机器的 CPU、内存和端口抢满（12 个分片全开会偶发时序失败）。
 * 环境变量可以覆盖（调试时想全并发），没写时取默认值和分片数的较小值。
 */
export function shardLimit(count, value, fallback) {
  const n = Number(value)
  // 空、0、负数、非数字都按默认处理：宁可慢一点，也不能一个分片都不跑
  const limit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
  return Math.max(1, Math.min(count, limit))
}
