<template>
  <el-dialog
    v-model="visible"
    title="AI 生成用例"
    width="820"
    :close-on-click-modal="false"
    @closed="resetAll"
  >
    <!-- 表单：接口信息 -->
    <el-form :model="form" label-width="80px">
      <el-form-item label="Method" required>
        <el-select v-model="form.method" style="width: 140px">
          <el-option v-for="m in ['GET', 'POST', 'PUT', 'DELETE']" :key="m" :label="m" :value="m" />
        </el-select>
      </el-form-item>
      <el-form-item label="URL" required>
        <el-input v-model="form.url" placeholder="如 /api/cases 或 https://api.example.com/users" />
      </el-form-item>
      <el-form-item label="Body">
        <el-input
          v-model="form.body"
          type="textarea"
          :rows="3"
          placeholder='JSON 请求体（可选），如 {"username": "test"}'
        />
      </el-form-item>
      <el-form-item label="接口说明">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="2"
          placeholder="接口用途、参数含义等（可选，有助于 AI 设计更贴切的用例）"
        />
      </el-form-item>
    </el-form>

    <div class="gen-bar">
      <el-button type="primary" :loading="generating" @click="onGenerate">
        {{ generating ? '生成中…' : '生成' }}
      </el-button>
      <span class="gen-tip">AI 将设计 5-8 条正常/边界/异常用例，生成后可编辑、勾选再保存</span>
    </div>

    <!-- 预览表格 -->
    <el-table
      v-if="cases.length"
      ref="tableRef"
      :data="cases"
      border
      size="small"
      max-height="360"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="42" />
      <el-table-column label="用例名" min-width="200">
        <template #default="{ row }">
          <el-input v-model="row.name" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="方法" width="80">
        <template #default="{ row }">
          <el-tag :type="methodTag(row.method)" size="small">{{ row.method }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="url" label="URL" min-width="180" show-overflow-tooltip />
      <el-table-column label="期望状态码" width="110">
        <template #default="{ row }">
          <el-input-number v-model="row.expected.status" size="small" :min="0" :max="599" :controls="false" style="width: 80px" />
        </template>
      </el-table-column>
      <el-table-column label="断言摘要" min-width="160">
        <template #default="{ row }">
          <span class="assert-summary">{{ assertSummary(row.expected) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="70" fixed="right">
        <template #default="{ $index }">
          <el-button size="small" type="danger" link @click="removeRow($index)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <span v-if="cases.length" class="selected-count">已选 {{ selected.length }} / {{ cases.length }}</span>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!selected.length"
        :loading="saving"
        @click="onSaveSelected"
      >
        保存选中（{{ selected.length }}）
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const form = ref({ method: 'GET', url: '', body: '', description: '' })
const generating = ref(false)
const saving = ref(false)
const cases = ref([])
const selected = ref([])
const tableRef = ref(null)

function methodTag(m) {
  return { GET: 'success', POST: 'primary', PUT: 'warning', DELETE: 'danger' }[m] || 'info'
}

function assertSummary(expected = {}) {
  const parts = []
  if (expected.contains) parts.push(`包含「${expected.contains}」`)
  if (expected.maxTimeMs) parts.push(`≤${expected.maxTimeMs}ms`)
  if (expected.jsonChecks?.length) parts.push(`${expected.jsonChecks.length} 条 JSON 断言`)
  return parts.join('；') || '—'
}

function onSelectionChange(rows) {
  selected.value = rows
}

// 新结果默认全选
watch(cases, async () => {
  if (!cases.value.length) return
  await nextTick()
  cases.value.forEach((row) => tableRef.value?.toggleRowSelection(row, true))
})

async function onGenerate() {
  if (!form.value.url.trim()) {
    ElMessage.warning('请填写接口 URL')
    return
  }
  let body = null
  if (form.value.body.trim()) {
    try {
      body = JSON.parse(form.value.body)
    } catch {
      ElMessage.error('Body 不是合法 JSON，请检查')
      return
    }
  }
  generating.value = true
  cases.value = []
  try {
    const res = await api.aiGenerateCases({
      method: form.value.method,
      url: form.value.url.trim(),
      body,
      description: form.value.description.trim(),
    })
    cases.value = (res.cases || []).map((c) => ({
      ...c,
      expected: { ...c.expected },
    }))
    ElMessage.success(`已生成 ${cases.value.length} 条用例，请预览并勾选`)
  } catch (e) {
    ElMessage.error('AI 生成失败：' + (e.response?.data?.error || e.message))
  } finally {
    generating.value = false
  }
}

function removeRow(index) {
  const row = cases.value[index]
  tableRef.value?.toggleRowSelection(row, false)
  cases.value.splice(index, 1)
}

async function onSaveSelected() {
  saving.value = true
  let ok = 0
  let fail = 0
  for (const c of selected.value) {
    try {
      await api.createCase({
        name: c.name,
        method: c.method,
        url: c.url,
        headers: c.headers || {},
        body: c.body,
        expected: c.expected || {},
      })
      ok++
    } catch {
      fail++
    }
  }
  saving.value = false
  if (ok) ElMessage.success(`已保存 ${ok} 条用例${fail ? `，${fail} 条失败` : ''}`)
  if (fail && !ok) ElMessage.error('保存失败，请重试')
  if (ok) {
    visible.value = false
    emit('saved')
  }
}

function resetAll() {
  form.value = { method: 'GET', url: '', body: '', description: '' }
  cases.value = []
  selected.value = []
  generating.value = false
  saving.value = false
}
</script>

<style scoped>
.gen-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.gen-tip { font-size: 12px; color: #909399; }
.assert-summary { font-size: 12px; color: #606266; }
.selected-count { margin-right: auto; font-size: 13px; color: #606266; }
</style>
