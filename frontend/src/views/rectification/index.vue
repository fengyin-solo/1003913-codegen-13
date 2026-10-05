<template>
  <section class="page" data-module="rectification">
    <header class="page-head">
      <div>
        <h2>整改跟踪管理</h2>
        <p class="page-desc">维护整改任务，围绕任务编号、验收编号、整改内容、责任单位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整改任务</button>
        <button class="btn" type="button" @click="toggleBench">
          {{ benchOpen ? '收起批量督办台' : `批量督办台（已选 ${selectedIds.size} 条）` }}
        </button>
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

    <section v-if="benchOpen" class="bench-panel">
      <h3>批量督办台</h3>
      <p class="page-desc">
        在下方表格勾选任务，回到这里逐条处理，最后一次提交整批回写；提交后整批进入复核。
        期限冲突时以人工修正为准，其次批次默认，最后任务原值。
      </p>
      <form class="bench-form" @submit.prevent="submitBench">
        <label class="filter-item">
          <span>签发单位（缺责任单位的任务按它回填）</span>
          <input v-model="benchForm.签发单位" placeholder="如：县地质灾害防治中心" />
        </label>
        <label class="filter-item">
          <span>复核人</span>
          <input v-model="benchForm.复核人" placeholder="复核通过后签收的人" />
        </label>
        <label class="filter-item">
          <span>批次默认整改期限</span>
          <input v-model="benchForm.默认期限" type="date" />
        </label>
        <button class="btn primary" type="submit" :disabled="submitting || !selectedIds.size">
          {{ submitting ? '提交中…' : `提交督办批（${selectedIds.size} 条）` }}
        </button>
        <span v-if="blockCount" class="error-text">{{ blockCount }} 项阻断，处理后才能提交</span>
      </form>

      <table v-if="previewItems.length" class="data-table">
        <thead>
          <tr>
            <th>任务编号</th>
            <th>整改内容</th>
            <th>责任单位</th>
            <th>整改期限</th>
            <th>风险提示</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in previewItems" :key="item.taskId">
            <td>{{ item.任务编号 }}</td>
            <td>{{ taskOf(item.taskId)?.['整改内容'] ?? '—' }}</td>
            <td>
              <span v-if="item.责任单位回填" class="missing">缺失 → {{ item.生效责任单位 }}</span>
              <span v-else>{{ item.生效责任单位 }}</span>
            </td>
            <td>
              <input
                type="date"
                :value="drafts.get(item.taskId)?.deadline"
                @input="onDeadlineEdit(item.taskId, $event)"
              />
              <span class="deadline-source">{{ item.期限来源 }}</span>
            </td>
            <td>
              <span
                v-for="(risk, index) in item.risks"
                :key="index"
                class="risk-tag"
                :class="risk.level"
              >
                {{ risk.text }}
              </span>
              <span v-if="!item.risks.length" class="risk-tag ok">无风险</span>
            </td>
            <td>
              <button class="link" type="button" @click="removeFromBench(item.taskId)">移出批次</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">尚未勾选任务：在下方表格勾选后，回到这里逐条处理、整批提交。</p>
    </section>

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
          <th>督办</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :checked="selectedIds.has(Number(row.id))"
              @change="toggleSelect(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
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

    <section v-if="batches.length" class="bench-panel">
      <h3>督办批</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>签发单位</th>
            <th>复核人</th>
            <th>任务数</th>
            <th>任务清单</th>
            <th>提交时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="String(batch.id)">
            <td>{{ batch['批次号'] }}</td>
            <td>{{ batch['签发单位'] }}</td>
            <td>{{ batch['复核人'] }}</td>
            <td>{{ batch['任务数'] }}</td>
            <td>{{ batch['任务清单'] }}</td>
            <td>{{ batch['提交时间'] }}</td>
            <td>{{ batch.status }}</td>
            <td>
              <button
                v-if="batch.status === '待复核'"
                class="link"
                type="button"
                :disabled="reviewing"
                @click="review(batch)"
              >
                复核通过
              </button>
              <span v-else>已办结（{{ batch['复核时间'] }}）</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条整改跟踪记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listBatches, previewBatch, reviewBatch, submitBatch } from '@/api/supervision-service'
import type { EntryRow, SupervisionDraftItem, SupervisionSubmitInput } from '@/data/types'

const meta = moduleMeta('rectification')
const columns = ["任务编号", "验收编号", "整改内容", "责任单位", "整改期限", "整改措施", "复核人", "整改状态"]
const actions = ["开始整改", "提交复核", "确认复核"]
const statuses = ["待整改", "整改中", "已整改", "已复核", "逾期未改"]
const stats = [{"label": "待整改数", "value": 0}, {"label": "整改中数", "value": 0}, {"label": "逾期未改数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 批量督办台：勾选 → 逐条处理 → 整批提交，都在这一条操作里完成
const benchOpen = ref(false)
const selectedIds = reactive(new Set<number>())
const drafts = reactive(new Map<number, SupervisionDraftItem>())
const benchForm = reactive({ 签发单位: '', 复核人: '', 默认期限: '' })
const submitting = ref(false)
const reviewing = ref(false)
const batches = ref<EntryRow[]>([])

function taskOf(id: number): EntryRow | undefined {
  return rows.value.find((row) => Number(row.id) === id)
}

function toggleSelect(row: EntryRow) {
  const id = Number(row.id)
  if (selectedIds.has(id)) {
    removeFromBench(id)
    return
  }
  selectedIds.add(id)
  drafts.set(id, {
    taskId: id,
    deadline: benchForm.默认期限 || String(row['整改期限'] ?? ''),
    touched: false,
  })
}

function removeFromBench(id: number) {
  selectedIds.delete(id)
  drafts.delete(id)
}

// 批次默认期限变化：只覆盖未人工修正的行；人工修正过的以人工为准
watch(
  () => benchForm.默认期限,
  (value) => {
    for (const [id, draft] of drafts) {
      if (!draft.touched) {
        draft.deadline = value || String(taskOf(id)?.['整改期限'] ?? '')
      }
    }
  },
)

function onDeadlineEdit(id: number, event: Event) {
  const draft = drafts.get(id)
  if (!draft) {
    return
  }
  draft.deadline = (event.target as HTMLInputElement).value
  draft.touched = true
}

const benchInput = computed<SupervisionSubmitInput>(() => ({
  签发单位: benchForm.签发单位,
  复核人: benchForm.复核人,
  默认期限: benchForm.默认期限,
  items: [...drafts.values()],
}))

// 风险实时预览：责任单位、期限、证据完整度有任何改动都立刻重算
const previewItems = computed(() => previewBatch(rows.value, benchInput.value))
const blockCount = computed(
  () => previewItems.value.flatMap((item) => item.risks).filter((risk) => risk.level === 'block').length,
)

function toggleBench() {
  benchOpen.value = !benchOpen.value
}

function submitBench() {
  errorMessage.value = ''
  noticeMessage.value = ''
  submitting.value = true
  try {
    const result = submitBatch(benchInput.value)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    selectedIds.clear()
    drafts.clear()
    reload()
    reloadBatches()
  } finally {
    submitting.value = false
  }
}

function review(batch: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  reviewing.value = true
  try {
    const result = reviewBatch(Number(batch.id))
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    reload()
    reloadBatches()
  } finally {
    reviewing.value = false
  }
}

function reloadBatches() {
  batches.value = listBatches()
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

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '整改跟踪列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadBatches()
})
</script>
