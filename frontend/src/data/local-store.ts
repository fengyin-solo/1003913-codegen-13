import { SEED_ROWS } from './seed'
import type { EntryRow, SupervisionBatch } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'
// 督办批次单独存一份键，避免与模块行数据合并时被种子兜底覆盖。
const BATCH_STORAGE_KEY = 'geohazard-monitor-prevention:supervision-batches'

/** 整批写入前的快照：任一条写入失败都按快照整体回滚。 */
export type StoreSnapshot = {
  entries: Record<string, EntryRow[]>
  batches: SupervisionBatch[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null
let batchCache: SupervisionBatch[] | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

function readBatches(): SupervisionBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(BATCH_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    return JSON.parse(raw) as SupervisionBatch[]
  } catch {
    return []
  }
}

export function listBatches(): SupervisionBatch[] {
  if (batchCache === null) {
    batchCache = readBatches()
  }
  return batchCache
}

export function saveBatches(batches: SupervisionBatch[]): void {
  batchCache = clone(batches)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batchCache))
  }
}

/** 抓取整库快照（整改任务、验收台账、督办批次），供整批提交失败时回滚。 */
export function takeSnapshot(): StoreSnapshot {
  return { entries: clone(allRows()), batches: clone(listBatches()) }
}

/** 原子提交：整改任务回写、验收台账新增与批次落库一次写入，中途失败则回滚快照。 */
export function commitAtomic(
  entries: Record<string, EntryRow[]>,
  batches: SupervisionBatch[],
  snapshot: StoreSnapshot,
): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      // 先写批次再写台账：任一步抛错都恢复快照，保证不留半截数据。
      window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches))
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    }
    cache = entries
    batchCache = batches
  } catch (error) {
    cache = snapshot.entries
    batchCache = snapshot.batches
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.entries))
      window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(snapshot.batches))
    }
    throw error instanceof Error ? error : new Error('整批写入失败，已回滚')
  }
}

export function restoreSnapshot(snapshot: StoreSnapshot): void {
  cache = snapshot.entries
  batchCache = snapshot.batches
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.entries))
    window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(snapshot.batches))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
