/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 整改任务证据完整度：措施与整改证据两项齐全才算完整。 */
export type EvidenceLevel = '完整' | '部分' | '缺失'

export type RiskLevel = '高' | '中' | '低'

/** 批量督办台对单条任务的风险评估结果。 */
export type TaskRisk = {
  level: RiskLevel
  reasons: string[]
  evidence: EvidenceLevel
  /** 责任单位缺失时按签发单位回填后的建议值。 */
  backfillUnit: string
}

/** 批量督办提交时的逐条处理结果：选择、修正与整批回写在同一次提交里完成。 */
export type SupervisionItem = {
  taskId: number
  /** 人工修正过的整改期限优先，未修正才回落批量默认值。 */
  deadline: string
  deadlineManual: boolean
  /** 提交时实际写入的责任单位（含历史缺失任务按签发单位的回填）。 */
  responsibleUnit: string
  backfilled: boolean
  risk: TaskRisk
}

export type SupervisionBatch = {
  id: number
  batchNo: string
  status: '待复核' | '复核通过'
  submittedAt: string
  reviewedAt: string
  reviewer: string
  deadlineDefault: string
  items: SupervisionItem[]
}

export type SupervisionSubmitResult = {
  ok: boolean
  message: string
  batch?: SupervisionBatch
}

