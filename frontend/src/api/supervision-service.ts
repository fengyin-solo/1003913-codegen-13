import { listRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  SupervisionDraftItem,
  SupervisionPreviewItem,
  SupervisionRisk,
  SupervisionSubmitInput,
} from '@/data/types'

// 批量督办台的事务边界：整改任务、督办批、验收台账三张表同进同退。
const RECT_KEY = 'rectification'
const BATCH_KEY = 'supervision'
const ACCEPT_KEY = 'acceptance'

// 任务主线状态机：只能一格一格往前走，不许跳级、不许回退。
// 「逾期未改」是分支态，不在主线上，不能作为推进目标。
const TASK_FLOW = ['待整改', '整改中', '已整改', '已复核']
// 批次状态机：待复核 → 已复核，同样只许依次推进。
const BATCH_FLOW = ['待复核', '已复核']

function todayText(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function nowText(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  return `${todayText()} ${hh}:${mi}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(prefix: string, rows: EntryRow[], field: string): string {
  const max = rows.reduce((acc, row) => {
    const matched = String(row[field] ?? '').match(/(\d+)$/)
    return matched ? Math.max(acc, Number(matched[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

/**
 * 逐条试算：责任单位回填、期限取舍、风险提示。
 * 页面实时预览和提交前校验共用这一个函数，保证看到的风险就是提交时拦的风险。
 *
 * 期限冲突的取舍（默认值 vs 人工修正）：人工修正 > 批次默认 > 任务原值。
 * 人工修正是对单条任务的最新判断，批次默认是批量兜底，原值只是历史遗留。
 */
function evaluateItem(
  row: EntryRow,
  draft: SupervisionDraftItem,
  input: SupervisionSubmitInput,
  today: string,
): SupervisionPreviewItem {
  const risks: SupervisionRisk[] = []

  // 责任单位：历史缺口的按签发单位回填
  const unit = String(row['责任单位'] ?? '').trim()
  const issuer = input.签发单位.trim()
  let 生效责任单位 = unit
  let 责任单位回填 = false
  if (!unit) {
    if (issuer) {
      生效责任单位 = issuer
      责任单位回填 = true
      risks.push({ level: 'warn', text: `责任单位缺失，将按签发单位「${issuer}」回填` })
    } else {
      risks.push({ level: 'block', text: '责任单位缺失，且批次未填签发单位，无法回填' })
    }
  }

  // 期限：人工修正 > 批次默认 > 任务原值
  const 原期限 = String(row['整改期限'] ?? '').trim()
  let 生效期限 = 原期限
  let 期限来源: SupervisionPreviewItem['期限来源'] = 原期限 ? '任务原值' : '缺失'
  if (input.默认期限.trim()) {
    生效期限 = input.默认期限.trim()
    期限来源 = '批次默认'
  }
  if (draft.touched && draft.deadline.trim()) {
    生效期限 = draft.deadline.trim()
    期限来源 = '人工修正'
  }
  if (!生效期限) {
    risks.push({ level: 'block', text: '整改期限缺失：请设批次默认期限或逐条修正' })
  } else if (生效期限 < today) {
    risks.push({ level: 'warn', text: `期限 ${生效期限} 已逾期` })
  }

  // 证据完整度：整改措施与验收编号是复核时要看的证据
  if (!String(row['整改措施'] ?? '').trim()) {
    risks.push({ level: 'warn', text: '证据不完整：整改措施为空' })
  }
  if (!String(row['验收编号'] ?? '').trim()) {
    risks.push({ level: 'warn', text: '证据不完整：验收编号为空' })
  }

  // 状态只可依次推进：只有「整改中」的下一格才是「已整改」（进入复核）
  const status = String(row.status)
  if (status !== TASK_FLOW[1]) {
    risks.push({
      level: 'block',
      text: `当前状态「${status}」不能进入复核：状态只可依次推进（整改中→已整改）`,
    })
  }

  return {
    taskId: Number(row.id),
    任务编号: String(row['任务编号'] ?? row.id),
    生效责任单位,
    责任单位回填,
    生效期限,
    期限来源,
    risks,
  }
}

/** 督办台面板的实时预览：纯试算，不落库。 */
export function previewBatch(
  rows: EntryRow[],
  input: SupervisionSubmitInput,
): SupervisionPreviewItem[] {
  const today = todayText()
  return input.items
    .map((draft) => {
      const row = rows.find((item) => Number(item.id) === draft.taskId)
      return row ? evaluateItem(row, draft, input, today) : null
    })
    .filter((item): item is SupervisionPreviewItem => item !== null)
}

// 并发提交只认首次请求：提交期间到达的重复请求直接拒绝。
// 页面按钮防双击是一道，这道锁是第二道，状态机幂等是第三道。
let submitInFlight = false

/** 提交督办批：逐条校验全部通过后整批回写；任一条失败，整批不写。 */
export function submitBatch(input: SupervisionSubmitInput): ActionResult {
  if (submitInFlight) {
    return { ok: false, message: '已有督办批正在提交，并发请求仅首次有效' }
  }
  submitInFlight = true
  try {
    const 签发单位 = input.签发单位.trim()
    const 复核人 = input.复核人.trim()
    if (!input.items.length) {
      return { ok: false, message: '督办批至少需要勾选一条整改任务' }
    }
    if (!签发单位) {
      return { ok: false, message: '签发单位必填：缺责任单位的任务要按它回填' }
    }
    if (!复核人) {
      return { ok: false, message: '复核人必填：整批进入复核后要有人签收' }
    }

    const rectRows = listRows(RECT_KEY)
    const batches = listRows(BATCH_KEY)
    const today = todayText()

    // 幂等：同一批任务已存在待复核批次，视为重复提交，只认首次
    const ids = input.items.map((item) => item.taskId).sort((a, b) => a - b)
    const idKey = ids.join(',')
    const duplicated = batches.find(
      (batch) => batch.status === BATCH_FLOW[0] && String(batch['任务ID集合'] ?? '') === idKey,
    )
    if (duplicated) {
      return {
        ok: false,
        message: `这些任务已在督办批「${duplicated['批次号']}」中待复核，重复提交已被拒绝`,
      }
    }

    // 逐条校验：任一阻断，整批不写（先校验后落库，天然不会写一半）
    const previews = input.items.map((draft) => {
      const row = rectRows.find((item) => Number(item.id) === draft.taskId)
      return row ? evaluateItem(row, draft, input, today) : null
    })
    const missingIndex = previews.findIndex((item) => item === null)
    if (missingIndex >= 0) {
      return { ok: false, message: `编号 ${input.items[missingIndex].taskId} 的整改任务不存在，整批未提交` }
    }
    const settled = previews as SupervisionPreviewItem[]
    const blocks = settled.flatMap((item) =>
      item.risks.filter((risk) => risk.level === 'block').map((risk) => `${item.任务编号}：${risk.text}`),
    )
    if (blocks.length) {
      return {
        ok: false,
        message: `整批未提交：${blocks[0]}${blocks.length > 1 ? ` 等 ${blocks.length} 项阻断` : ''}`,
      }
    }

    // 整批回写：先构造全量新数据，再一次落库
    const byId = new Map(settled.map((item) => [item.taskId, item]))
    const nextRect = rectRows.map((row) => {
      const preview = byId.get(Number(row.id))
      if (!preview) {
        return row
      }
      return {
        ...row,
        责任单位: preview.生效责任单位,
        整改期限: preview.生效期限,
        复核人,
        status: TASK_FLOW[2], // 整改中 → 已整改：依次推进一格，整批进入复核
        pending: true,
      }
    })
    const batchNo = nextCode('SUP', batches, '批次号')
    const batchRow: EntryRow = {
      id: nextId(batches),
      status: BATCH_FLOW[0],
      pending: true,
      abnormal: false,
      批次号: batchNo,
      签发单位,
      复核人,
      默认期限: input.默认期限.trim(),
      任务数: ids.length,
      任务清单: settled.map((item) => item.任务编号).join('、'),
      任务ID集合: idKey,
      提交时间: nowText(),
      复核时间: '',
    }

    saveRows(RECT_KEY, nextRect)
    try {
      saveRows(BATCH_KEY, [...batches, batchRow])
    } catch (error) {
      rollback(RECT_KEY, rectRows) // 批次写失败，任务表回滚
      throw error
    }
    return { ok: true, message: `督办批 ${batchNo} 已提交，${ids.length} 条任务整批进入复核` }
  } catch (error) {
    return {
      ok: false,
      message: `督办批写入失败，整批已回滚：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    submitInFlight = false
  }
}

let reviewInFlight = false

/** 复核通过：批次内任务推进到「已复核」，验收台账同步增一条记录，三张表同一事务。 */
export function reviewBatch(batchId: number): ActionResult {
  if (reviewInFlight) {
    return { ok: false, message: '已有复核操作正在处理，并发请求仅首次有效' }
  }
  reviewInFlight = true
  try {
    const batches = listRows(BATCH_KEY)
    const batch = batches.find((item) => Number(item.id) === batchId)
    if (!batch) {
      return { ok: false, message: `没有找到编号为 ${batchId} 的督办批` }
    }
    if (batch.status !== BATCH_FLOW[0]) {
      return { ok: false, message: `督办批当前为「${batch.status}」，批次状态只可依次推进` }
    }
    const ids = String(batch['任务ID集合'] ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)
    const rectRows = listRows(RECT_KEY)
    const acceptRows = listRows(ACCEPT_KEY)

    // 状态只可依次推进：批次内任务必须都停在「已整改」，才能一格走到「已复核」
    const notReady = rectRows.filter(
      (row) => ids.includes(Number(row.id)) && String(row.status) !== TASK_FLOW[2],
    )
    if (notReady.length) {
      return {
        ok: false,
        message: `任务 ${notReady[0]['任务编号']} 当前为「${notReady[0].status}」，不是「已整改」，整批复核未执行`,
      }
    }

    const nextRect = rectRows.map((row) =>
      ids.includes(Number(row.id)) ? { ...row, status: TASK_FLOW[3], pending: false } : row,
    )
    const acceptCode = nextCode('ACCE', acceptRows, '验收编号')
    const acceptRow: EntryRow = {
      id: nextId(acceptRows),
      status: '验收通过',
      pending: false,
      abnormal: false,
      验收编号: acceptCode,
      项目编号: String(batch['批次号']),
      验收类型: '整改复核',
      验收日期: todayText(),
      验收组成员: String(batch['复核人']),
      验收结论: '复核通过',
      整改意见: `督办批 ${batch['批次号']} 复核通过，关联任务：${batch['任务清单']}`,
      验收状态: '验收通过',
    }
    const nextBatches = batches.map((item) =>
      Number(item.id) === batchId
        ? { ...item, status: BATCH_FLOW[1], pending: false, 复核时间: nowText() }
        : item,
    )

    // 三张表同一事务：任一写入失败，已写的按快照回滚
    saveRows(RECT_KEY, nextRect)
    try {
      saveRows(ACCEPT_KEY, [...acceptRows, acceptRow])
    } catch (error) {
      rollback(RECT_KEY, rectRows)
      throw error
    }
    try {
      saveRows(BATCH_KEY, nextBatches)
    } catch (error) {
      rollback(RECT_KEY, rectRows)
      rollback(ACCEPT_KEY, acceptRows)
      throw error
    }
    return {
      ok: true,
      message: `督办批 ${batch['批次号']} 复核通过，验收台账已同步登记 ${acceptCode}`,
    }
  } catch (error) {
    return {
      ok: false,
      message: `复核写入失败，整批已回滚：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    reviewInFlight = false
  }
}

/** 回滚尽力而为：回滚本身也失败时保留原始异常，不掩盖真正的错误。 */
function rollback(key: string, snapshot: EntryRow[]): void {
  try {
    saveRows(key, snapshot)
  } catch {
    // localStorage 写不进去时（如容量满），回滚也可能失败，只能放弃
  }
}

export function listBatches(): EntryRow[] {
  return listRows(BATCH_KEY)
}
