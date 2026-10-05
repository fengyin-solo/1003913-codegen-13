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

/** 批量督办台：逐条处理时的行草稿。 */
export type SupervisionDraftItem = {
  taskId: number
  /** 行内期限当前值：人工未修正时跟随批次默认，修正后以人工值为准 */
  deadline: string
  /** 是否被人工改过：改过则不再跟随批次默认期限 */
  touched: boolean
}

export type SupervisionRisk = {
  level: 'block' | 'warn'
  text: string
}

/** 批量督办台：一条任务在提交前的试算结果，页面提示与提交校验共用同一份。 */
export type SupervisionPreviewItem = {
  taskId: number
  任务编号: string
  生效责任单位: string
  责任单位回填: boolean
  生效期限: string
  期限来源: '人工修正' | '批次默认' | '任务原值' | '缺失'
  risks: SupervisionRisk[]
}

export type SupervisionSubmitInput = {
  签发单位: string
  复核人: string
  默认期限: string
  items: SupervisionDraftItem[]
}
