<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" @click="$router.push('/cases/new')">新建用例</el-button>
      <el-button @click="aiVisible = true">AI 生成用例</el-button>
      <el-button :loading="runAllLoading" @click="onRunAll">全部运行</el-button>
      <el-button @click="load">刷新</el-button>
      <div class="toolbar-right">
        <el-button :loading="exporting" @click="onExport">导出套件</el-button>
        <el-button @click="openImport">导入套件</el-button>
      </div>
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

    <!-- 导入套件（M11） -->
    <el-dialog v-model="importVisible" title="导入套件" width="640" @closed="resetImport">
      <input ref="fileInput" type="file" accept=".json,application/json" class="hidden-file" @change="onFilePick" />

      <div class="imp-step">
        <el-button @click="fileInput && fileInput.click()">选择套件文件（.json）</el-button>
        <span v-if="importFile" class="imp-file">{{ importFile.name }}</span>
        <span v-else class="imp-hint">套件里含用例 + 环境；敏感请求头的值已脱敏，导入后需自己补</span>
      </div>

      <template v-if="importPreview">
        <div class="imp-preview">
          文件里有 <b>{{ importPreview.cases }}</b> 条用例、<b>{{ importPreview.environments }}</b> 个环境
          <span class="imp-hint">（导出时间 {{ importPreview.exportedAt.slice(0, 19).replace('T', ' ') }}）</span>
        </div>

        <div class="imp-label">碰到重名怎么办？</div>
        <el-radio-group v-model="onConflict" class="imp-radios">
          <el-radio value="rename">两个都留 —— 新的加「(2)」后缀</el-radio>
          <el-radio value="overwrite">用文件里的覆盖同名的</el-radio>
          <el-radio value="skip">同名的一律不动</el-radio>
        </el-radio-group>
      </template>

      <el-alert v-if="importError" type="error" :title="importError" :closable="false" class="imp-alert" />

      <template v-if="importResult">
        <el-alert
          type="success"
          :title="`导入完成：新增 ${importResult.created} · 更新 ${importResult.updated} · 跳过 ${importResult.skipped}`"
          :closable="false"
          class="imp-alert"
        />
        <ul v-if="(importResult.warnings || []).length" class="imp-list">
          <li v-for="(w, i) in importResult.warnings" :key="'w' + i">⚠ {{ w }}</li>
        </ul>
        <ul v-if="(importResult.failed || []).length" class="imp-list imp-list-bad">
          <li v-for="(f, i) in importResult.failed" :key="'f' + i">✗ {{ f.name }}：{{ f.reason }}</li>
        </ul>
      </template>

      <template #footer>
        <el-button @click="importVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :disabled="!importPreview || !!importResult"
          :loading="importing"
          @click="onImport"
        >
          开始导入
        </el-button>
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
// M11：套件导出 / 导入
const exporting = ref(false)
const importVisible = ref(false)
const importing = ref(false)
const importFile = ref(null)
const importPreview = ref(null)
const importPayload = ref(null)
const importResult = ref(null)
const importError = ref('')
const onConflict = ref('rename')
const fileInput = ref(null)

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

// M11：导出 —— 走 axios（要带 Authorization），拿到 JSON 后在前端落成文件
async function onExport() {
  exporting.value = true
  try {
    const suite = await api.exportSuite()
    const blob = new Blob([JSON.stringify(suite, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `api-test-suite-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    ElMessage.success(`已导出 ${suite.counts.cases} 条用例、${suite.counts.environments} 个环境`)
  } catch (e) {
    ElMessage.error('导出失败：' + (e.response?.data?.error || e.message))
  } finally {
    exporting.value = false
  }
}

function openImport() {
  resetImport()
  importVisible.value = true
}

function resetImport() {
  importFile.value = null
  importPreview.value = null
  importPayload.value = null
  importResult.value = null
  importError.value = ''
  onConflict.value = 'rename'
  if (fileInput.value) fileInput.value.value = ''
}

// 选文件时先做一次「是不是本平台导出的」预检 —— 把明显错的文件挡在选择阶段，
// 别让人点了「开始导入」才拿到一句 400。后端仍然会独立校验一次（这里只是早点告知）。
async function onFilePick(ev) {
  const file = (ev.target.files || [])[0]
  if (!file) return
  importFile.value = file
  importResult.value = null
  importError.value = ''
  try {
    const text = await file.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('这个文件不是合法 JSON')
    }
    if (!data || data.kind !== 'api-test-platform-suite') {
      throw new Error('这不像本平台导出的套件文件（缺少 kind 标记）')
    }
    importPayload.value = data
    importPreview.value = {
      cases: Array.isArray(data.cases) ? data.cases.length : 0,
      environments: Array.isArray(data.environments) ? data.environments.length : 0,
      exportedAt: String(data.exportedAt || ''),
    }
  } catch (e) {
    importPreview.value = null
    importPayload.value = null
    importError.value = e.message
  }
}

async function onImport() {
  if (!importPayload.value) return
  importing.value = true
  importError.value = ''
  try {
    importResult.value = await api.importSuite(importPayload.value, onConflict.value)
    load()
  } catch (e) {
    importError.value = e.response?.data?.error || e.message
  } finally {
    importing.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.toolbar { margin-bottom: 14px; display: flex; gap: 10px; }
.toolbar-right { margin-left: auto; display: flex; gap: 10px; }
.hidden-file { display: none; }
.imp-step { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.imp-file { font-size: 13px; color: #303133; }
.imp-hint { font-size: 12px; color: #909399; }
.imp-preview { font-size: 13px; margin-bottom: 14px; }
.imp-label { font-size: 13px; color: #606266; margin-bottom: 8px; }
.imp-radios { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-bottom: 12px; }
.imp-alert { margin-bottom: 10px; }
.imp-list { margin: 0 0 10px; padding-left: 18px; font-size: 13px; color: #e6a23c; }
.imp-list-bad { color: #f56c6c; }
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
