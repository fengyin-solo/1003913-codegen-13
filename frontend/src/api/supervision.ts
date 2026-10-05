import {
  commitAtomic,
  listBatches,
  listRows,
  restoreSnapshot,
  takeSnapshot,
} from '@/data/local-store'
import type {
  EntryRow,
  EvidenceLevel,
  RiskLevel,
  SupervisionBatch,
  SupervisionItem,
  SupervisionSubmitResult,
  TaskRisk,
} from '@/data/types'

// 整改状态只可依次推进：待整改 → 整改中 → 已整改 → 已复核（逾期未改为旁路告警态，不参与前进）。
const RECTIFICATION_FLOW = ['待整改', '整改中', '已整改', '已复核']
const SUBMIT_FROM_STATUS = '整改中'
const REVIEW_FROM_STATUS = '已整改'
const REVIEW_TARGET_STATUS = '已复核'

// 临期窗口：距整改期限不足该天数按中风险提示。
const NEAR_DEADLINE_DAYS = 3
const MS_PER_DAY = 24 * 60 * 60 * 1000

const RECTIFICATION_KEY = 'rectification'
const ACCEPTANCE_KEY = 'acceptance'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 并发提交只认首次请求：提交与复核各持一把进程内互斥锁，重复请求直接拒绝。
let submitLocked = false
let reviewLocked = false

function today(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) {
    return null
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function textOf(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 证据完整度：整改措施 + 整改证据两项都有内容为完整，缺一为部分，皆无为缺失。 */
export function evidenceLevel(row: EntryRow): EvidenceLevel {
  const measure = textOf(row, '整改措施') !== ''
  const evidence = textOf(row, '整改证据') !== ''
  if (measure && evidence) {
    return '完整'
  }
  if (measure || evidence) {
    return '部分'
  }
  return '缺失'
}

/**
 * 按责任单位、期限和证据完整度评估单条任务风险。
 * 责任单位缺失时给出按签发单位回填的建议值，回填动作在提交时才落库。
 */
export function evaluateRisk(row: EntryRow, now: Date = today()): TaskRisk {
  const reasons: string[] = []
  let score = 0

  const responsible = textOf(row, '责任单位')
  const issuer = textOf(row, '签发单位')
  const backfillUnit = responsible === '' ? issuer : responsible
  if (responsible === '') {
    if (issuer === '') {
      reasons.push('责任单位与签发单位均缺失，无法自动回填')
      score = Math.max(score, 3)
    } else {
      reasons.push(`责任单位缺失，将按签发单位「${issuer}」回填`)
      score = Math.max(score, 2)
    }
  }

  const deadline = textOf(row, '整改期限')
  const date = parseDate(deadline)
  if (!date) {
    reasons.push('整改期限缺失或格式无效')
    score = Math.max(score, 3)
  } else {
    const diffDays = Math.round((date.getTime() - now.getTime()) / MS_PER_DAY)
    if (diffDays < 0) {
      reasons.push(`已逾期 ${Math.abs(diffDays)} 天`)
      score = Math.max(score, 3)
    } else if (diffDays === 0) {
      reasons.push('今日到期')
      score = Math.max(score, 2)
    } else if (diffDays <= NEAR_DEADLINE_DAYS) {
      reasons.push(`距期限仅剩 ${diffDays} 天`)
      score = Math.max(score, 2)
    }
  }

  const evidence = evidenceLevel(row)
  if (evidence === '缺失') {
    reasons.push('整改措施与证据均缺失')
    score = Math.max(score, 2)
  } else if (evidence === '部分') {
    reasons.push('证据不完整，仅提交了部分整改材料')
    score = Math.max(score, 1)
  }

  const level: RiskLevel = score >= 3 ? '高' : score === 2 ? '中' : '低'
  return { level, reasons, evidence, backfillUnit }
}

export type SupervisionDraftItem = {
  taskId: number
  /** 人工在督办台上逐条修正的期限；留空表示沿用批量默认值。 */
  deadlineManual?: string
}

export type SupervisionSubmitInput = {
  taskIds: number[]
  deadlineDefault: string
  items: SupervisionDraftItem[]
  operator: string
}

function nextBatchNo(existing: SupervisionBatch[]): string {
  const serial = existing.length + 1
  return `DB-${today().getFullYear()}${String(today().getMonth() + 1).padStart(2, '0')}${String(
    today().getDate(),
  ).padStart(2, '0')}-${String(serial).padStart(3, '0')}`
}

/** 状态只可沿 RECTIFICATION_FLOW 逐格前进：批次提交要求停在 from，不允许跳格或回退。 */
function assertStatusFlow(row: EntryRow, expected: string): void {
  const current = String(row.status)
  const currentIndex = RECTIFICATION_FLOW.indexOf(current)
  const expectedIndex = RECTIFICATION_FLOW.indexOf(expected)
  if (currentIndex === -1) {
    throw new Error(`任务「${textOf(row, '任务编号') || row.id}」状态「${current}」不在整改流转链上`)
  }
  if (currentIndex !== expectedIndex) {
    throw new Error(
      `任务「${textOf(row, '任务编号') || row.id}」当前为「${current}」，需处于「${expected}」才能组批，状态只可依次推进`,
    )
  }
}

/**
 * 提交督办批：批量选择、逐条处理（人工期限优先、缺失责任单位按签发单位回填）
 * 与整批回写在同一次调用内完成。任一条写入失败整批回滚；并发调用只认首次。
 */
export function submitSupervisionBatch(input: SupervisionSubmitInput): SupervisionSubmitResult {
  if (submitLocked) {
    return { ok: false, message: '已有督办批正在提交，并发请求只认首次提交，请稍后刷新查看' }
  }
  submitLocked = true
  const snapshot = takeSnapshot()
  try {
    const ids = [...new Set(input.taskIds)]
    if (ids.length === 0) {
      return { ok: false, message: '请至少勾选一条整改任务再组批' }
    }
    if (!parseDate(input.deadlineDefault)) {
      return { ok: false, message: '批量默认期限格式无效，应为 YYYY-MM-DD' }
    }

    const rectRows = listRows(RECTIFICATION_KEY)
    const manualMap = new Map(input.items.map((item) => [item.taskId, item.deadlineManual?.trim() ?? '']))

    const itemResults: SupervisionItem[] = []
    const nextRectRows = clone(rectRows)

    for (const taskId of ids) {
      const index = nextRectRows.findIndex((row) => Number(row.id) === taskId)
      if (index < 0) {
        throw new Error(`编号为 ${taskId} 的整改任务不存在`)
      }
      const row = nextRectRows[index]
      assertStatusFlow(row, SUBMIT_FROM_STATUS)

      // 期限取舍：人工修正值优先，未修正（含空串）才回落批量默认值。
      const manualDeadline = manualMap.get(taskId) ?? ''
      const deadlineManual = manualDeadline !== '' && parseDate(manualDeadline) !== null
      if (manualMap.get(taskId) !== '' && !deadlineManual) {
        throw new Error(
          `任务「${textOf(row, '任务编号')}」人工修正期限格式无效，应为 YYYY-MM-DD`,
        )
      }
      const deadline = deadlineManual ? manualDeadline : input.deadlineDefault

      // 历史缺责任单位的任务按签发单位回填，已有责任单位保持不动。
      const responsible = textOf(row, '责任单位')
      const issuer = textOf(row, '签发单位')
      const backfilled = responsible === '' && issuer !== ''
      const responsibleUnit = backfilled ? issuer : responsible
      if (responsible === '' && issuer === '') {
        throw new Error(
          `任务「${textOf(row, '任务编号')}」缺责任单位且无签发单位可回填，不能进入督办批`,
        )
      }

      const risk = evaluateRisk({ ...row, 责任单位: responsibleUnit, 整改期限: deadline })

      const updated: EntryRow = {
        ...row,
        status: REVIEW_FROM_STATUS,
        pending: true,
        责任单位: responsibleUnit,
        整改期限: deadline,
      }
      nextRectRows[index] = updated
      itemResults.push({
        taskId,
        deadline,
        deadlineManual,
        responsibleUnit,
        backfilled,
        risk,
      })
    }

    const batches = listBatches()
    const batch: SupervisionBatch = {
      id: batches.reduce((max, item) => Math.max(max, item.id), 0) + 1,
      batchNo: nextBatchNo(batches),
      status: '待复核',
      submittedAt: new Date().toISOString(),
      reviewedAt: '',
      reviewer: '',
      deadlineDefault: input.deadlineDefault,
      items: itemResults,
    }

    const entries = { ...snapshot.entries, [RECTIFICATION_KEY]: nextRectRows }
    const nextBatches = [...batches, batch]
    commitAtomic(entries, nextBatches, snapshot)

    const backfillCount = itemResults.filter((item) => item.backfilled).length
    const highCount = itemResults.filter((item) => item.risk.level === '高').length
    return {
      ok: true,
      batch,
      message:
        `督办批 ${batch.batchNo} 已提交，${itemResults.length} 条任务整批进入复核` +
        (backfillCount ? `，其中 ${backfillCount} 条已按签发单位回填责任单位` : '') +
        (highCount ? `，提示高风险 ${highCount} 条，请复核重点关注` : ''),
    }
  } catch (error) {
    // 任一条写入失败：内存与 localStorage 全部恢复提交前快照。
    restoreSnapshot(snapshot)
    return {
      ok: false,
      message: error instanceof Error ? `整批提交失败，已回滚：${error.message}` : '整批提交失败，已回滚',
    }
  } finally {
    submitLocked = false
  }
}

function acceptanceId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function acceptanceCode(rows: EntryRow[]): string {
  return `ACCE-R${String(acceptanceId(rows)).padStart(4, '0')}`
}

/**
 * 复核督办批：仅「待复核」批次可复核，且批次内任务必须都停在「已整改」。
 * 复核通过后整批任务沿状态链推进到「已复核」，并按条联动写入验收台账，
 * 任一条失败整批回滚。状态只可依次推进，不提供驳回回退动作。
 */
export function reviewSupervisionBatch(
  batchId: number,
  reviewer: string,
): SupervisionSubmitResult {
  if (reviewLocked) {
    return { ok: false, message: '该批次正在复核，并发请求只认首次操作，请刷新后重试' }
  }
  reviewLocked = true
  const snapshot = takeSnapshot()
  try {
    const batches = listBatches()
    const batchIndex = batches.findIndex((item) => item.id === batchId)
    if (batchIndex < 0) {
      return { ok: false, message: `没有找到编号为 ${batchId} 的督办批` }
    }
    const batch = batches[batchIndex]
    if (batch.status !== '待复核') {
      return { ok: false, message: `督办批 ${batch.batchNo} 已${batch.status}，不能重复复核` }
    }

    const rectRows = listRows(RECTIFICATION_KEY)
    const acceptanceRows = listRows(ACCEPTANCE_KEY)
    const nextRectRows = clone(rectRows)
    const nextAcceptanceRows = clone(acceptanceRows)

    for (const item of batch.items) {
      const index = nextRectRows.findIndex((row) => Number(row.id) === item.taskId)
      if (index < 0) {
        throw new Error(`任务 ${item.taskId} 已不存在，台账可能被其他操作改动`)
      }
      const row = nextRectRows[index]
      assertStatusFlow(row, REVIEW_FROM_STATUS)

      nextRectRows[index] = {
        ...row,
        status: REVIEW_TARGET_STATUS,
        pending: false,
        复核人: reviewer,
      }
      // 复核通过联动验收台账：一批通过几条就同步新增几条，状态只可依次推进。
      nextAcceptanceRows.push({
        id: acceptanceId(nextAcceptanceRows),
        status: '验收通过',
        pending: false,
        abnormal: false,
        验收编号: acceptanceCode(nextAcceptanceRows),
        项目编号: textOf(row, '验收编号'),
        验收类型: '整改复核验收',
        验收日期: today().toISOString().slice(0, 10),
        验收组成员: reviewer,
        验收结论: `督办批 ${batch.batchNo} 复核通过，整改任务 ${textOf(row, '任务编号')} 验收合格`,
        整改意见: `责任单位：${item.responsibleUnit}；风险等级：${item.risk.level}`,
        验收状态: '验收通过',
        来源督办批: batch.batchNo,
        来源任务编号: textOf(row, '任务编号'),
      })
    }

    const reviewedBatch: SupervisionBatch = {
      ...batch,
      status: '复核通过',
      reviewedAt: new Date().toISOString(),
      reviewer,
    }
    const nextBatches = [...batches]
    nextBatches[batchIndex] = reviewedBatch

    const entries = {
      ...snapshot.entries,
      [RECTIFICATION_KEY]: nextRectRows,
      [ACCEPTANCE_KEY]: nextAcceptanceRows,
    }
    commitAtomic(entries, nextBatches, snapshot)

    return {
      ok: true,
      batch: reviewedBatch,
      message: `督办批 ${batch.batchNo} 复核通过，${batch.items.length} 条任务已复核，验收台账同步新增 ${batch.items.length} 条记录`,
    }
  } catch (error) {
    restoreSnapshot(snapshot)
    return {
      ok: false,
      message: error instanceof Error ? `整批复核失败，已回滚：${error.message}` : '整批复核失败，已回滚',
    }
  } finally {
    reviewLocked = false
  }
}

export function supervisionBatches(): SupervisionBatch[] {
  // 新提交的批次排在最前，复核台优先处理最近一批。
  return [...listBatches()].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
}
