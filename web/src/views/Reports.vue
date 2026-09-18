<template>
  <div class="reports">
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-num">{{ summary.totalCases }}</div>
        <div class="stat-label">用例总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ summary.totalRuns }}</div>
        <div class="stat-label">执行次数</div>
      </div>
      <div class="stat-card" :class="passRateClass">
        <div class="stat-num">{{ summary.passRate }}%</div>
        <div class="stat-label">通过率</div>
      </div>
      <div class="stat-card danger">
        <div class="stat-num">{{ summary.failedRuns }}</div>
        <div class="stat-label">失败次数</div>
      </div>
    </div>

    <el-card class="sec" shadow="never">
      <template #header>
        <span>🌐 按运行环境汇总</span>
        <span class="head-hint">同一组用例跨了两个环境时，通过率要分开看 —— 混在一起的平均值会掩盖「换个环境就全红」</span>
      </template>
      <el-table :data="summary.byEnv" border size="small" v-loading="loading">
        <el-table-column prop="name" label="环境" min-width="150" show-overflow-tooltip />
        <el-table-column label="地址（当时实际打的）" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.baseUrl || '—' }}</template>
        </el-table-column>
        <el-table-column prop="runs" label="执行" width="70" />
        <el-table-column label="通过/失败" width="120">
          <template #default="{ row }">
            <span class="pass-text">{{ row.passed }}</span> / <span class="fail-text">{{ row.failed }}</span>
          </template>
        </el-table-column>
        <el-table-column label="通过率" width="140">
          <template #default="{ row }">
            <el-progress :percentage="row.passRate" :stroke-width="10" />
          </template>
        </el-table-column>
        <el-table-column prop="lastRunAt" label="最近运行" width="160" />
        <template #empty>还没有执行记录——先建用例并运行一次</template>
      </el-table>
      <div class="foot-hint">
        这里的名字和地址是<strong>执行当时</strong>的快照：以后改了环境地址，历史记录不会跟着变，
        「那次实际打的是哪个地址」永远查得到（显示「(未记录环境)」= 那一轮跑的记录里还没这一项）。
      </div>
    </el-card>

    <el-card class="sec" shadow="never">
      <template #header>
        <span>🏷️ 按业务分组汇总</span>
        <span class="head-hint">用例打了分组标签后，按主题看通过率 —— 一眼看出「附件全周期」这组最近是不是在红</span>
      </template>
      <el-table :data="summary.byGroup" border size="small" v-loading="loading">
        <el-table-column prop="group" label="分组" min-width="150" show-overflow-tooltip />
        <el-table-column prop="runs" label="执行" width="70" />
        <el-table-column label="通过/失败" width="120">
          <template #default="{ row }">
            <span class="pass-text">{{ row.passed }}</span> / <span class="fail-text">{{ row.failed }}</span>
          </template>
        </el-table-column>
        <el-table-column label="通过率" width="140">
          <template #default="{ row }">
            <el-progress :percentage="row.passRate" :stroke-width="10" />
          </template>
        </el-table-column>
        <el-table-column prop="lastRunAt" label="最近运行" width="160" />
        <template #empty>还没有执行记录——先建用例并运行一次</template>
      </el-table>
    </el-card>

    <el-card class="sec" shadow="never">
      <template #header>📊 按用例汇总</template>
      <el-table :data="summary.byCase" border size="small" v-loading="loading">
        <el-table-column prop="name" label="用例" min-width="180" show-overflow-tooltip />
        <el-table-column prop="runs" label="执行" width="70" />
        <el-table-column label="通过/失败" width="120">
          <template #default="{ row }">
            <span class="pass-text">{{ row.passed }}</span> / <span class="fail-text">{{ row.failed }}</span>
          </template>
        </el-table-column>
        <el-table-column label="通过率" width="140">
          <template #default="{ row }">
            <el-progress :percentage="row.passRate" :stroke-width="10" />
          </template>
        </el-table-column>
        <el-table-column label="最近结果" width="90">
          <template #default="{ row }">
            <el-tag :type="row.lastPass ? 'success' : 'danger'" size="small">{{ row.lastPass ? '通过' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastRunAt" label="最近运行" width="160" />
        <template #empty>还没有执行记录——先建用例并运行一次</template>
      </el-table>
    </el-card>

    <el-card class="sec" shadow="never">
      <template #header>🕐 最近执行明细</template>
      <el-table :data="summary.recentRuns" border size="small">
        <el-table-column prop="caseName" label="用例" min-width="160" show-overflow-tooltip />
        <el-table-column label="结果" width="80">
          <template #default="{ row }">
            <el-tag :type="row.pass ? 'success' : 'danger'" size="small">{{ row.pass ? '通过' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态码" width="70" />
        <el-table-column label="运行环境" width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.env" size="small" type="success" effect="plain">{{ row.env.name || row.env.baseUrl }}</el-tag>
            <span v-else class="detail-text">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="durationMs" label="耗时(ms)" width="90" />
        <el-table-column label="明细" min-width="220">
          <template #default="{ row }">
            <span class="detail-text">{{ (row.detail || []).join('；') || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="ranAt" label="时间" width="160" />
      </el-table>
    </el-card>

    <el-card class="sec" shadow="never">
      <template #header>📣 通知出口（webhook，可选）</template>
      <div class="sched-form">
        <el-input
          v-model="whForm.url"
          data-t="webhook-url"
          placeholder="https://…（失败侧通知会 POST 到该地址；清空保存 = 关闭出口）"
          style="flex: 1"
          clearable
        />
        <el-button type="primary" :loading="whSaving" data-t="webhook-save" @click="onSaveWebhook">保存</el-button>
      </div>
      <p class="webhook-hint">
        配置后，定时任务跑出的 <b>断言失败（warn）</b> 和 <b>运行异常（error）</b> 通知会以 JSON POST 到该地址
        （3s 超时、尽力而为——出口挂了不影响任务本体），可指向飞书机器人 webhook 或 hermes 网关。success 永不转发。
      </p>
    </el-card>

    <el-card class="sec" shadow="never">
      <template #header>⏰ 定时任务（node-cron）</template>
      <div class="sched-form">
        <el-radio-group v-model="schedForm.target" size="small">
          <el-radio-button label="case">单条用例</el-radio-button>
          <el-radio-button label="group">分组</el-radio-button>
        </el-radio-group>
        <el-select v-if="schedForm.target === 'case'" v-model="schedForm.caseId" placeholder="选择要定时跑的用例" style="width: 240px">
          <el-option v-for="c in cases" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-select v-else v-model="schedForm.group" placeholder="选择要定时跑的分组" style="width: 240px">
          <el-option v-for="g in groups" :key="g" :label="g" :value="g" />
        </el-select>
        <el-input v-model="schedForm.cron" placeholder="cron 表达式，如 */5 * * * *" style="flex: 1" />
        <el-tooltip content="开启后任务跑成功不再发通知，只有断言失败（warn）或没跑成（error）才提醒——监控跑得勤时铃铛不会被「一切正常」刷屏" placement="top">
          <label class="notify-switch"><el-switch v-model="schedForm.notifyFailure" size="small" /> 只在失败时通知</label>
        </el-tooltip>
        <el-button type="primary" :loading="schedSaving" @click="onAddSchedule">添加</el-button>
      </div>
      <el-table :data="schedules" border size="small" v-loading="schedLoading">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="目标" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.group">🏷️ {{ row.group }}</span>
            <span v-else>{{ row.caseName || '（用例已删除）' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="cron" label="cron" min-width="140" />
        <el-table-column label="通知" width="90">
          <template #default="{ row }">
            <el-tag :type="row.notifyOn === 'failure' ? 'warning' : 'info'" size="small">
              {{ row.notifyOn === 'failure' ? '只看失败' : '全部' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="160" />
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button size="small" @click="onToggleSchedule(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button size="small" type="danger" @click="onDeleteSchedule(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>还没有定时任务——选「单条用例」或「分组」+ cron 表达式添加</template>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const loading = ref(false)
const schedLoading = ref(false)
const schedSaving = ref(false)
const summary = ref({ totalCases: 0, totalRuns: 0, passedRuns: 0, failedRuns: 0, passRate: 0, byCase: [], byEnv: [], byGroup: [], recentRuns: [] })
const schedules = ref([])
const cases = ref([])
const schedForm = ref({ target: 'case', caseId: null, group: '', cron: '', notifyFailure: false })
const whForm = ref({ url: '' })
const whSaving = ref(false)

// 从用例列表派生出可选分组（分组标签来自每条用例的 group 字段）
const groups = computed(() => {
  const set = new Set()
  for (const c of cases.value) if (c.group) set.add(c.group)
  return [...set]
})

const passRateClass = computed(() =>
  summary.value.passRate >= 80 ? 'good' : summary.value.passRate >= 50 ? 'warn' : 'danger',
)

async function load() {
  loading.value = true
  schedLoading.value = true
  try {
    const [s, sch, cs] = await Promise.all([api.getReportSummary(), api.listSchedules(), api.listCases()])
    summary.value = s
    schedules.value = sch
    cases.value = cs
  } catch (e) {
    ElMessage.error('加载失败：' + (e.response?.data?.error || e.message))
  } finally {
    loading.value = false
    schedLoading.value = false
  }
}

async function onAddSchedule() {
  const form = schedForm.value
  if (form.target === 'group') {
    if (!form.group) return ElMessage.warning('请选择分组')
  } else {
    if (!form.caseId) return ElMessage.warning('请选择用例')
  }
  if (!form.cron.trim()) return ElMessage.warning('请填写 cron 表达式')
  schedSaving.value = true
  try {
    const notifyOn = form.notifyFailure ? 'failure' : 'all'
    const payload =
      form.target === 'group'
        ? { group: form.group, cron: form.cron.trim(), notifyOn }
        : { caseId: form.caseId, cron: form.cron.trim(), notifyOn }
    await api.createSchedule(payload)
    ElMessage.success('已添加定时任务')
    schedForm.value.cron = ''
    await load()
  } catch (e) {
    ElMessage.error('添加失败：' + (e.response?.data?.error || e.message))
  } finally {
    schedSaving.value = false
  }
}

async function onToggleSchedule(row) {
  try {
    await api.updateSchedule(row.id, { enabled: !row.enabled })
    await load()
  } catch (e) {
    ElMessage.error('操作失败：' + (e.response?.data?.error || e.message))
  }
}

async function onDeleteSchedule(row) {
  try {
    await api.deleteSchedule(row.id)
    ElMessage.success('已删除')
    await load()
  } catch (e) {
    ElMessage.error('删除失败：' + (e.response?.data?.error || e.message))
  }
}

onMounted(async () => {
  await load()
  // 通知出口地址单独拉（读 settings，和报告数据无关）
  try {
    const r = await api.getNotifyWebhook()
    whForm.value.url = r.url || ''
  } catch {
    // 读不到就保持空——出口是可选能力，加载失败不该吵用户
  }
})

async function onSaveWebhook() {
  whSaving.value = true
  try {
    const r = await api.setNotifyWebhook(whForm.value.url.trim())
    whForm.value.url = r.url || ''
    ElMessage.success(r.url ? '已保存通知出口' : '已关闭通知出口')
  } catch (e) {
    ElMessage.error('保存失败：' + (e.response?.data?.error || e.message))
  } finally {
    whSaving.value = false
  }
}
</script>

<style scoped>
.stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 16px; }
.stat-card {
  background: #fff; border: 1px solid #e4e7ed; border-radius: 10px;
  padding: 16px; text-align: center;
}
.stat-num { font-size: 26px; font-weight: 700; color: #303133; }
.stat-card.good .stat-num { color: #67c23a; }
.stat-card.warn .stat-num { color: #e6a23c; }
.stat-card.danger .stat-num { color: #f56c6c; }
.stat-label { font-size: 12px; color: #909399; margin-top: 4px; }
.sec { margin-bottom: 16px; }
.head-hint { font-size: 12px; color: #909399; font-weight: 400; margin-left: 8px; }
.foot-hint { font-size: 12px; color: #909399; line-height: 1.7; margin-top: 10px; }
.pass-text { color: #67c23a; font-weight: 600; }
.fail-text { color: #f56c6c; font-weight: 600; }
.detail-text { font-size: 12px; color: #909399; }
.sched-form { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
.notify-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--el-text-color-regular); cursor: pointer; white-space: nowrap; }
.webhook-hint { margin: 4px 0 0; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
</style>
