<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" @click="$router.push('/cases/new')">新建用例</el-button>
      <el-button @click="aiVisible = true">AI 生成用例</el-button>
      <el-button :loading="runAllLoading" @click="onRunAll">全部运行</el-button>
      <el-button @click="load">刷新</el-button>
    </div>

    <el-table :data="cases" v-loading="loading" border stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
      <el-table-column label="方法" width="90">
        <template #default="{ row }">
          <el-tag :type="methodTag(row.method)" size="small">{{ row.method }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="url" label="URL" min-width="240" show-overflow-tooltip />
      <el-table-column prop="createdAt" label="创建时间" width="165" />
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="success" :loading="runningId === row.id" @click="onRun(row)">运行</el-button>
          <el-button size="small" @click="$router.push(`/cases/${row.id}/edit`)">编辑</el-button>
          <el-button size="small" type="danger" @click="onDelete(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>暂无用例，点上方「新建用例」开始</template>
    </el-table>

    <!-- 单条运行结果 -->
    <el-dialog v-model="resultVisible" title="运行结果" width="640">
      <template v-if="lastResult">
        <div class="result-head">
          <el-tag :type="lastResult.pass ? 'success' : 'danger'" size="large">
            {{ lastResult.pass ? '✓ 通过' : '✗ 失败' }}
          </el-tag>
          <span class="result-meta">状态码 <b>{{ lastResult.status || '—' }}</b></span>
          <span class="result-meta">耗时 <b>{{ lastResult.durationMs }}ms</b></span>
        </div>
        <el-alert
          v-if="lastResult.error"
          type="error"
          :title="(lastResult.detail || [])[0] || '请求失败'"
          :closable="false"
          class="result-alert"
        />
        <ul v-else-if="lastResult.detail && lastResult.detail.length" class="detail-list">
          <li v-for="(d, i) in lastResult.detail" :key="i" class="detail-item">⚠ {{ d }}</li>
        </ul>
        <div v-else class="pass-note">所有断言通过 ✔</div>
        <div class="resp-title">响应预览（前 200 字符）</div>
        <pre class="resp-body">{{ lastResult.bodyPreview || '(空)' }}</pre>
      </template>
    </el-dialog>

    <!-- 全部运行汇总 -->
    <el-dialog v-model="allVisible" title="全部运行汇总" width="720">
      <template v-if="allResult">
        <div class="result-head">
          <el-tag :type="allResult.failed === 0 ? 'success' : 'danger'" size="large">
            通过 {{ allResult.passed }} / {{ allResult.total }}
          </el-tag>
          <span class="result-meta">失败 {{ allResult.failed }}</span>
        </div>
        <el-table :data="allResult.results" border size="small" max-height="400">
          <el-table-column prop="name" label="用例" min-width="170" show-overflow-tooltip />
          <el-table-column label="结果" width="80">
            <template #default="{ row }">
              <el-tag :type="row.pass ? 'success' : 'danger'" size="small">{{ row.pass ? '通过' : '失败' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态码" width="76" />
          <el-table-column prop="durationMs" label="耗时(ms)" width="90" />
          <el-table-column label="说明" min-width="200">
            <template #default="{ row }">
              <span class="detail-inline">{{ (row.detail || []).join('；') || (row.error ? '请求失败' : '—') }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>

    <!-- AI 生成用例 -->
    <AiGenerateDialog v-model="aiVisible" @saved="load" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import AiGenerateDialog from '../components/AiGenerateDialog.vue'

const cases = ref([])
const loading = ref(false)
const runningId = ref(null)
const runAllLoading = ref(false)
const resultVisible = ref(false)
const lastResult = ref(null)
const allVisible = ref(false)
const allResult = ref(null)
const aiVisible = ref(false)

function methodTag(m) {
  return { GET: 'success', POST: 'primary', PUT: 'warning', DELETE: 'danger' }[m] || 'info'
}

async function load() {
  loading.value = true
  try {
    cases.value = await api.listCases()
  } catch (e) {
    ElMessage.error('加载用例失败：' + (e.response?.data?.error || e.message))
  } finally {
    loading.value = false
  }
}

async function onRun(row) {
  runningId.value = row.id
  try {
    lastResult.value = await api.runCase(row.id)
    resultVisible.value = true
  } catch (e) {
    ElMessage.error('运行失败：' + (e.response?.data?.error || e.message))
  } finally {
    runningId.value = null
  }
}

async function onRunAll() {
  runAllLoading.value = true
  try {
    allResult.value = await api.runAll()
    allVisible.value = true
  } catch (e) {
    ElMessage.error('运行失败：' + (e.response?.data?.error || e.message))
  } finally {
    runAllLoading.value = false
  }
}

async function onDelete(row) {
  try {
    await ElMessageBox.confirm(`确定删除用例「${row.name}」？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await api.deleteCase(row.id)
  ElMessage.success('已删除')
  load()
}

onMounted(load)
</script>

<style scoped>
.toolbar { margin-bottom: 14px; display: flex; gap: 10px; }
.result-head { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.result-meta { font-size: 13px; color: #606266; }
.result-alert { margin-bottom: 10px; }
.detail-list { margin: 0 0 10px; padding-left: 18px; }
.detail-item { font-size: 13px; color: #e6a23c; margin-bottom: 4px; }
.pass-note { font-size: 13px; color: #67c23a; margin-bottom: 10px; }
.resp-title { font-size: 12px; color: #909399; margin-bottom: 6px; }
.resp-body {
  margin: 0; padding: 10px; background: #f5f7fa; border: 1px solid #e4e7ed;
  border-radius: 6px; font-size: 12px; max-height: 260px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
}
.detail-inline { font-size: 12px; color: #909399; }
</style>
