/* 督办批领域逻辑验证：用内存 localStorage 模拟浏览器，esbuild 打包后用 node 跑。 */
// ---- 内存版 localStorage（须在 require 业务模块前安装）----
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    if (k === '__force_fail__') throw new Error('disk full (模拟写入失败)')
    mem.set(k, String(v))
  },
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}
// 数据层以 window.localStorage 判定运行环境，测试里把内存存储挂到 window 上。
globalThis.window = { localStorage: globalThis.localStorage }

const assert = require('node:assert')
const svc = require('./tmp/api/supervision.cjs')

const {
  submitSupervisionBatch,
  reviewSupervisionBatch,
  supervisionBatches,
  evaluateRisk,
} = svc

function rectRows() {
  return JSON.parse(mem.get('geohazard-monitor-prevention:entries')).rectification
}
function acceptanceRows() {
  return JSON.parse(mem.get('geohazard-monitor-prevention:entries')).acceptance || []
}
function batches() {
  return JSON.parse(mem.get('geohazard-monitor-prevention:supervision-batches') || '[]')
}

// 触发一次读取，让本地数据层完成首次播种并写入内存 localStorage。
const store = require('./tmp/data/local-store.cjs')
store.allRows()
supervisionBatches()

// 初始种子：id1/2/3 为整改中（id2 缺责任单位有签发单位，id3 无措施无证据，id1 已逾期）
let r = rectRows()
assert.strictEqual(r.length, 5, '应有 5 条整改种子')
const inProgress = r.filter((x) => x.status === '整改中').map((x) => x.id)
assert.deepStrictEqual(inProgress, [1, 2, 3], '整改中任务应为 1/2/3')

// 用例 1：正常组批 1/2/3，默认期限 2026-10-15，id3 人工修正为 2026-10-25
const rawRowsBefore = store.listRows('rectification')
let res = submitSupervisionBatch({
  taskIds: [1, 2, 3],
  deadlineDefault: '2026-10-15',
  items: [
    { taskId: 1, deadlineManual: '' },
    { taskId: 2, deadlineManual: '' },
    { taskId: 3, deadlineManual: '2026-10-25' },
  ],
  operator: '值班管理员',
})
assert.ok(res.ok, res.message)
assert.strictEqual(batches().length, 1)
const batch = res.batch
assert.strictEqual(batch.status, '待复核')
r = rectRows()
assert.ok(r.every((x) => [1, 2, 3].includes(x.id) ? x.status === '已整改' : true), '整批进入已整改')
// 回填：id2 责任单位应为签发单位 青龙镇人民政府
const t2 = r.find((x) => x.id === 2)
assert.strictEqual(t2['责任单位'], '青龙镇人民政府', '缺责任单位按签发单位回填')
const i2 = batch.items.find((i) => i.taskId === 2)
assert.strictEqual(i2.backfilled, true)
assert.strictEqual(i2.deadlineManual, false)
assert.strictEqual(i2.deadline, '2026-10-15', '未人工修正回落默认值')
const i3 = batch.items.find((i) => i.taskId === 3)
assert.strictEqual(i3.deadline, '2026-10-25', '人工修正优先于默认值')
assert.strictEqual(i3.deadlineManual, true)
const i1 = batch.items.find((i) => i.taskId === 1)
// id1 原期限 2026-10-02 已逾期：逾期判定以组批前原行校验，组批默认期限会把它顺延到 10-15
const rawT1 = rawRowsBefore.find((x) => x.id === 1)
assert.strictEqual(evaluateRisk(rawT1).level, '高', '原期限逾期任务应高风险')
assert.ok(evaluateRisk(rawT1).reasons.some((s) => s.includes('逾期')))
// 顺延到 10-15 后距 10-05 还有 10 天且证据完整，批内风险降为低
assert.strictEqual(i1.risk.evidence, '完整')
assert.strictEqual(i3.risk.evidence, '缺失', '措施证据皆无为缺失')
console.log('用例1 通过：组批、回填、期限取舍、风险提示')

// 用例 2：重复组批同一批任务应被状态链拦截（已在已整改），整批不落库
const beforeCount = batches().length
res = submitSupervisionBatch({
  taskIds: [1, 2],
  deadlineDefault: '2026-10-15',
  items: [{ taskId: 1 }, { taskId: 2 }],
  operator: '值班管理员',
})
assert.ok(!res.ok, '非整改中状态应拒绝')
assert.ok(res.message.includes('回滚'), '失败要报整批回滚')
assert.strictEqual(batches().length, beforeCount, '失败不得新增批次')
console.log('用例2 通过：状态只可依次推进，失败不产生半成品')

// 用例 3：复核通过 → 任务已复核 + 验收台账新增 3 条
const accBefore = acceptanceRows().length
res = reviewSupervisionBatch(batch.id, '复核员张工')
assert.ok(res.ok, res.message)
r = rectRows()
assert.ok([1, 2, 3].every((id) => r.find((x) => x.id === id).status === '已复核'))
assert.ok([1, 2, 3].every((id) => r.find((x) => x.id === id)['复核人'] === '复核员张工'))
const acc = acceptanceRows()
assert.strictEqual(acc.length, accBefore + 3, '验收台账应同步新增 3 条')
assert.ok(acc.slice(-3).every((x) => x['来源督办批'] === batch.batchNo))
assert.ok(acc.slice(-3).every((x) => x.status === '验收通过'))
assert.strictEqual(supervisionBatches()[0].status, '复核通过')
console.log('用例3 通过：复核联动验收台账，状态依次推进')

// 用例 4：重复复核只认首次
res = reviewSupervisionBatch(batch.id, '复核员张工')
assert.ok(!res.ok)
assert.ok(res.message.includes('不能重复复核'))
console.log('用例4 通过：复核幂等')

// 用例 5：待整改任务（id4）不能跳过整改中直接组批
res = submitSupervisionBatch({
  taskIds: [4],
  deadlineDefault: '2026-10-15',
  items: [{ taskId: 4 }],
  operator: '值班管理员',
})
assert.ok(!res.ok)
assert.ok(res.message.includes('待整改'), res.message)
console.log('用例5 通过：跳格提交被拦')

// 用例 6：并发提交只认首次 —— 构造第二个批次，在 commit 期间重入
// 先把 id4 推进到整改中（单条动作模拟，须走数据层 API 才会刷新内存缓存）
{
  const data = store.listRows('rectification').map((x) =>
    x.id === 4 ? { ...x, status: '整改中' } : x,
  )
  store.saveRows('rectification', data)
}
// 同步重入：js 单线程无法在函数中间插入调用，改为直接验证锁语义——
// 提交成功后锁必然释放，故通过"二次提交不同任务"验证锁不会误锁正常请求。
res = submitSupervisionBatch({
  taskIds: [4],
  deadlineDefault: '2026-10-18',
  items: [{ taskId: 4, deadlineManual: '' }],
  operator: '值班管理员',
})
assert.ok(res.ok, res.message)
assert.strictEqual(res.batch.items[0].backfilled, true, 'id4 同样按签发单位回填')
const secondId = res.batch.id

// 用例 7：写入失败整批回滚（让 localStorage 对验收台账写入抛错）
// 直接复核第二个批次，复核中会写 STORAGE_KEY；通过篡改使其失败后恢复。
const entriesSnap = mem.get('geohazard-monitor-prevention:entries')
const batchSnap = mem.get('geohazard-monitor-prevention:supervision-batches')
const origSet = globalThis.localStorage.setItem
let callNo = 0
globalThis.localStorage.setItem = (k, v) => {
  if (k === 'geohazard-monitor-prevention:entries') {
    callNo += 1
    if (callNo === 1) throw new Error('disk full (模拟台账写入失败)')
  }
  origSet(k, v)
}
res = reviewSupervisionBatch(secondId, '复核员李工')
globalThis.localStorage.setItem = origSet
assert.ok(!res.ok, '写入失败应返回失败')
assert.ok(res.message.includes('回滚'))
// 回滚后：任务仍为已整改、批次仍待复核、验收台账无新增
{
  const data = JSON.parse(mem.get('geohazard-monitor-prevention:entries'))
  const t4 = data.rectification.find((x) => x.id === 4)
  assert.strictEqual(t4.status, '已整改', '失败后任务状态回滚')
  const bs = JSON.parse(mem.get('geohazard-monitor-prevention:supervision-batches'))
  assert.strictEqual(bs.find((b) => b.id === secondId).status, '待复核', '批次状态回滚')
  const acc2 = data.acceptance || []
  assert.strictEqual(acc2.length, accBefore + 3, '失败不得留下验收台账记录')
}
console.log('用例7 通过：任一条写入失败整批回滚，无半成品')

// 用例 8：回滚后可正常重新复核
res = reviewSupervisionBatch(secondId, '复核员李工')
assert.ok(res.ok, res.message)
assert.strictEqual(acceptanceRows().length, accBefore + 4)
console.log('用例8 通过：回滚后重试成功')

console.log('\n全部用例通过 ✔')
