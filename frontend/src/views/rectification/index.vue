<template>
  <section class="page" data-module="rectification">
    <header class="page-head">
      <div>
        <h2>整改跟踪管理</h2>
        <p class="page-desc">维护整改任务，围绕任务编号、验收编号、整改内容、责任单位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整改任务</button>
        <button class="btn" type="button" @click="exportRows">导出整改跟踪清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th class="check-col">
            <input
              type="checkbox"
              :checked="allEligibleChecked"
              :disabled="eligibleRows.length === 0"
              title="勾选全部「整改中」任务"
              @change="toggleSelectAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="check-col">
            <input
              v-if="String(row.status) === '整改中'"
              type="checkbox"
              :checked="selectedIds.has(Number(row.id))"
              @change="toggleSelect(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canRun(action, row)"
              :title="actionTitle(action, row)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无整改跟踪数据，可先登记整改任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条整改跟踪记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="supervision-desk">
      <header class="desk-head">
        <div>
          <h3>批量督办台</h3>
          <p class="page-desc">一次勾选多条「整改中」任务组成督办批，按责任单位、期限与证据完整度提示风险；提交后整批进入复核。</p>
        </div>
        <span class="desk-count">已勾选 {{ selectedRows.length }} 条</span>
      </header>

      <div v-if="!selectedRows.length" class="desk-empty">
        请在上表勾选处于「整改中」的任务；其他状态不可组批，状态只可依次推进。
      </div>

      <template v-else>
        <div class="desk-toolbar">
          <label class="filter-item">
            <span>批次默认整改期限</span>
            <input v-model="deadlineDefault" type="date" />
          </label>
          <button class="btn ghost" type="button" @click="clearManualDeadlines">清空全部人工修正</button>
          <p class="desk-rule">期限取舍规则：逐条填了人工修正期限的以人工值为准，未填的回落批次默认值。</p>
        </div>

        <table class="data-table">
          <thead>
            <tr>
              <th>任务编号</th>
              <th>整改内容</th>
              <th>责任单位（提交值）</th>
              <th>原期限</th>
              <th>人工修正期限</th>
              <th>最终期限</th>
              <th>证据完整度</th>
              <th>风险提示</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in selectedRows" :key="String(item.id)">
              <td>{{ item['任务编号'] }}</td>
              <td>{{ item['整改内容'] }}</td>
              <td>
                {{ effectiveUnit(item) }}
                <span v-if="isMissingUnit(item)" class="tag tag-warn">按签发单位回填</span>
              </td>
              <td>{{ item['整改期限'] || '—' }}</td>
              <td>
                <input
                  v-model="manualDeadlines[Number(item.id)]"
                  type="date"
                  :aria-label="`${item['任务编号']}人工修正期限`"
                />
              </td>
              <td>{{ effectiveDeadline(item) }}</td>
              <td>
                <span class="tag" :class="evidenceClass(item)">{{ riskOf(item).evidence }}</span>
              </td>
              <td>
                <span class="tag" :class="riskClass(item)">风险{{ riskOf(item).level }}</span>
                <ul class="risk-reasons">
                  <li v-for="reason in riskOf(item).reasons" :key="reason">{{ reason }}</li>
                  <li v-if="!riskOf(item).reasons.length">无明显风险</li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="desk-foot">
          <p class="desk-rule">
            高风险 {{ riskCount('高') }} 条 · 中风险 {{ riskCount('中') }} 条 ·
            需回填责任单位 {{ backfillCount }} 条
          </p>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitBatch">
            {{ submitting ? '正在整批提交…' : `组批提交（${selectedRows.length} 条整批进入复核）` }}
          </button>
        </div>
        <p v-if="deskMessage" :class="deskOk ? 'ok-text' : 'error-text'">{{ deskMessage }}</p>
      </template>
    </section>

    <section class="review-queue">
      <header class="desk-head">
        <div>
          <h3>督办批复核</h3>
          <p class="page-desc">复核通过后批次内任务依次推进到「已复核」，验收台账同步增记；任一条写入失败整批回滚。</p>
        </div>
      </header>
      <p v-if="!batches.length" class="desk-empty">暂无督办批，组批提交后在此复核。</p>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>组批时间</th>
            <th>默认期限</th>
            <th>条数</th>
            <th>高/中风险</th>
            <th>状态</th>
            <th>复核人/时间</th>
            <th>包含任务</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>{{ batch.batchNo }}</td>
            <td>{{ formatTime(batch.submittedAt) }}</td>
            <td>{{ batch.deadlineDefault }}</td>
            <td>{{ batch.items.length }}</td>
            <td>{{ batchRiskCount(batch, '高') }} / {{ batchRiskCount(batch, '中') }}</td>
            <td>{{ batch.status }}</td>
            <td>
              <template v-if="batch.reviewer">{{ batch.reviewer }} · {{ formatTime(batch.reviewedAt) }}</template>
              <span v-else>—</span>
            </td>
            <td>{{ batchTaskNos(batch) }}</td>
            <td>
              <button
                v-if="batch.status === '待复核'"
                class="link"
                type="button"
                :disabled="reviewingId === batch.id"
                @click="reviewBatch(batch.id)"
              >
                {{ reviewingId === batch.id ? '复核写入中…' : '复核通过' }}
              </button>
              <span v-else class="desk-rule">已联动验收台账</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="reviewMessage" :class="reviewOk ? 'ok-text' : 'error-text'">{{ reviewMessage }}</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  evaluateRisk,
  reviewSupervisionBatch,
  submitSupervisionBatch,
  supervisionBatches,
} from '@/api/supervision'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, RiskLevel, SupervisionBatch } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('rectification')
const columns = ["任务编号", "验收编号", "整改内容", "责任单位", "签发单位", "整改期限", "整改措施", "整改证据", "复核人", "整改状态"]
const actions = ["开始整改", "提交复核", "确认复核"]
// 逐条动作也受状态链约束：只有停在前一状态时才允许推进一格。
const actionGate: Record<string, string> = {
  开始整改: '待整改',
  提交复核: '整改中',
  确认复核: '已整改',
}
const statuses = ["待整改", "整改中", "已整改", "已复核", "逾期未改"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 批量督办台状态
const selectedIds = reactive(new Set<number>())
const manualDeadlines = reactive<Record<number, string>>({})
const deadlineDefault = ref(defaultDeadline())
const submitting = ref(false)
const deskMessage = ref('')
const deskOk = ref(false)

// 复核队列状态
const batches = ref<SupervisionBatch[]>([])
const reviewingId = ref<number | null>(null)
const reviewMessage = ref('')
const reviewOk = ref(false)

const stats = computed(() => [
  { label: '待整改数', value: countByStatus('待整改') },
  { label: '整改中数', value: countByStatus('整改中') },
  { label: '逾期未改数', value: countByStatus('逾期未改') },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({ status, count: countByStatus(status) })),
)

const eligibleRows = computed(() => rows.value.filter((row) => String(row.status) === '整改中'))
const allEligibleChecked = computed(
  () => eligibleRows.value.length > 0 && eligibleRows.value.every((row) => selectedIds.has(Number(row.id))),
)
const selectedRows = computed(() =>
  rows.value.filter((row) => selectedIds.has(Number(row.id))),
)

// 待复核批次内的任务集合：锁定单条「确认复核」，只能随整批复核一起推进。
const pendingBatchTaskIds = computed(
  () =>
    new Set(
      batches.value
        .filter((batch) => batch.status === '待复核')
        .flatMap((batch) => batch.items.map((item) => item.taskId)),
    ),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function defaultDeadline(): string {
  // 默认期限取今天起第 7 天，给责任单位留足整改窗口。
  const date = new Date()
  date.setDate(date.getDate() + 7)
  return date.toISOString().slice(0, 10)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '整改任务登记入口尚未接入审批流'
}

function canRun(action: string, row: EntryRow): boolean {
  if (String(row.status) !== actionGate[action]) {
    return false
  }
  // 在待复核批次内的任务只能随整批复核推进，单条动作锁住，避免绕过验收台账联动。
  if (action === '确认复核' && pendingBatchTaskIds.value.has(Number(row.id))) {
    return false
  }
  return true
}

function actionTitle(action: string, row: EntryRow): string {
  if (canRun(action, row)) {
    return action
  }
  if (action === '确认复核' && pendingBatchTaskIds.value.has(Number(row.id))) {
    return '该任务已在待复核督办批内，需在下方复核台整批复核'
  }
  return `需处于「${actionGate[action]}」才能${action}，状态只可依次推进`
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (!canRun(action, row)) {
    errorMessage.value = `任务当前为「${row.status}」，需处于「${actionGate[action]}」才能${action}，状态只可依次推进`
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function toggleSelect(id: number) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id)
    delete manualDeadlines[id]
  } else {
    selectedIds.add(id)
  }
}

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.clear()
  if (checked) {
    eligibleRows.value.forEach((row) => selectedIds.add(Number(row.id)))
  } else {
    Object.keys(manualDeadlines).forEach((key) => delete manualDeadlines[Number(key)])
  }
}

function clearManualDeadlines() {
  selectedRows.value.forEach((row) => {
    delete manualDeadlines[Number(row.id)]
  })
}

function isMissingUnit(row: EntryRow): boolean {
  return String(row['责任单位'] ?? '').trim() === ''
}

function effectiveUnit(row: EntryRow): string {
  // 历史缺责任单位的任务按签发单位回填展示，提交时同样按此值写入。
  if (!isMissingUnit(row)) {
    return String(row['责任单位'])
  }
  return String(row['签发单位'] ?? '').trim() || '（无签发单位，提交将报错回滚）'
}

function effectiveDeadline(row: EntryRow): string {
  const manual = (manualDeadlines[Number(row.id)] ?? '').trim()
  return manual !== '' ? manual : deadlineDefault.value
}

function riskOf(row: EntryRow) {
  return evaluateRisk({
    ...row,
    责任单位: effectiveUnit(row),
    整改期限: effectiveDeadline(row),
  })
}

function evidenceClass(row: EntryRow): string {
  const level = riskOf(row).evidence
  return level === '完整' ? 'tag-ok' : level === '部分' ? 'tag-warn' : 'tag-danger'
}

function riskClass(row: EntryRow): string {
  const level = riskOf(row).level
  return level === '高' ? 'tag-danger' : level === '中' ? 'tag-warn' : 'tag-ok'
}

function riskCount(level: RiskLevel): number {
  return selectedRows.value.filter((row) => riskOf(row).level === level).length
}

const backfillCount = computed(
  () => selectedRows.value.filter((row) => isMissingUnit(row) && String(row['签发单位'] ?? '').trim() !== '').length,
)

function submitBatch() {
  deskMessage.value = ''
  submitting.value = true
  try {
    const result = submitSupervisionBatch({
      taskIds: selectedRows.value.map((row) => Number(row.id)),
      deadlineDefault: deadlineDefault.value,
      items: selectedRows.value.map((row) => ({
        taskId: Number(row.id),
        deadlineManual: manualDeadlines[Number(row.id)] ?? '',
      })),
      operator: session.operator,
    })
    deskOk.value = result.ok
    deskMessage.value = result.message
    if (result.ok) {
      selectedIds.clear()
      Object.keys(manualDeadlines).forEach((key) => delete manualDeadlines[Number(key)])
      deadlineDefault.value = defaultDeadline()
      reload()
      loadBatches()
    }
  } finally {
    submitting.value = false
  }
}

function batchRiskCount(batch: SupervisionBatch, level: RiskLevel): number {
  return batch.items.filter((item) => item.risk.level === level).length
}

function batchTaskNos(batch: SupervisionBatch): string {
  const byId = new Map(rows.value.map((row) => [Number(row.id), String(row['任务编号'] ?? row.id)]))
  return batch.items.map((item) => byId.get(item.taskId) ?? `#${item.taskId}`).join('、')
}

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function reviewBatch(batchId: number) {
  reviewMessage.value = ''
  reviewingId.value = batchId
  try {
    const result = reviewSupervisionBatch(batchId, session.operator)
    reviewOk.value = result.ok
    reviewMessage.value = result.message
    if (result.ok) {
      reload()
      loadBatches()
    }
  } finally {
    reviewingId.value = null
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 已不在列表（筛选/状态变更）的勾选项同步清掉，避免提交幻影任务。
    rows.value
      .filter((row) => String(row.status) !== '整改中')
      .forEach((row) => selectedIds.delete(Number(row.id)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '整改跟踪列表读取失败'
  }
}

function loadBatches() {
  batches.value = supervisionBatches()
}

onMounted(() => {
  reload()
  loadBatches()
})
</script>

<style scoped>
.supervision-desk,
.review-queue {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.desk-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.desk-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.desk-count {
  background: #e8f0fe;
  color: var(--brand);
  border-radius: 999px;
  padding: 2px 12px;
  font-size: 12px;
  white-space: nowrap;
}
.desk-empty {
  color: var(--muted);
  font-size: 13px;
  padding: 14px 0;
}
.desk-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin: 10px 0;
}
.desk-rule {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
  flex-basis: 100%;
}
.desk-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
  gap: 12px;
}
.check-col {
  width: 36px;
  text-align: center;
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  white-space: nowrap;
}
.tag-ok {
  background: #e6f7ed;
  color: #1a7f37;
}
.tag-warn {
  background: #fdf3e0;
  color: #b35c00;
}
.tag-danger {
  background: #fde8e8;
  color: #b42318;
}
.risk-reasons {
  margin: 4px 0 0;
  padding-left: 16px;
  color: var(--muted);
  font-size: 12px;
}
.ok-text {
  color: #1a7f37;
}
.link:disabled {
  color: #9aa4b2;
  cursor: not-allowed;
}
</style>
