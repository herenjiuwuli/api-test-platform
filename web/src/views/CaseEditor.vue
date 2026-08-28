<template>
  <el-card class="editor-card">
    <template #header>
      <div class="editor-head">
        <span>{{ isEdit ? '编辑用例 #' + id : '新建用例' }}</span>
        <el-button text type="primary" @click="$router.push('/')">← 返回列表</el-button>
      </div>
    </template>

    <el-form :model="form" label-width="90px" @submit.prevent>
      <el-form-item label="名称" required>
        <el-input v-model="form.name" placeholder="如：健康检查" />
      </el-form-item>

      <el-form-item label="请求" required>
        <div class="request-row">
          <el-select v-model="form.method" style="width: 120px">
            <el-option v-for="m in methods" :key="m" :label="m" :value="m" />
          </el-select>
          <el-input v-model="form.url" placeholder="https://api.example.com/path" />
        </div>
      </el-form-item>

      <el-form-item label="请求头">
        <div v-for="(h, i) in headersRows" :key="i" class="kv-row">
          <el-input v-model="h.key" placeholder="Header 名" style="width: 220px" />
          <el-input v-model="h.value" placeholder="值" style="flex: 1" />
          <el-button text type="danger" @click="headersRows.splice(i, 1)">移除</el-button>
        </div>
        <el-button size="small" @click="headersRows.push({ key: '', value: '' })">+ 添加请求头</el-button>
      </el-form-item>

      <el-form-item label="请求体">
        <el-input
          v-model="bodyText"
          type="textarea"
          :rows="5"
          placeholder='JSON 或原始文本（如 {"page": 1}）'
        />
      </el-form-item>

      <el-divider content-position="left">断言期望（expected）</el-divider>

      <el-form-item label="状态码">
        <el-input v-model="expected.status" type="number" placeholder="如 200（可选）" style="width: 220px" />
      </el-form-item>
      <el-form-item label="包含文本">
        <el-input v-model="expected.contains" placeholder="响应体需包含的字符串（可选）" />
      </el-form-item>
      <el-form-item label="耗时上限">
        <el-input v-model="expected.maxTimeMs" type="number" placeholder="毫秒，如 1000（可选）" style="width: 220px" />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        <el-button @click="$router.push('/')">取消</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const isEdit = computed(() => !!route.params.id)

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const form = ref({ name: '', method: 'GET', url: '' })
const headersRows = ref([{ key: '', value: '' }])
const bodyText = ref('')
const expected = ref({ status: '', contains: '', maxTimeMs: '' })
const saving = ref(false)

function headersFromRows(rows) {
  const out = {}
  for (const { key, value } of rows) {
    if (key && key.trim()) out[key.trim()] = value || ''
  }
  return out
}

function rowsFromHeaders(headers) {
  const rows = Object.entries(headers || {}).map(([key, value]) => ({ key, value }))
  return rows.length ? rows : [{ key: '', value: '' }]
}

async function load() {
  if (!isEdit.value) return
  const c = await api.getCase(id.value)
  form.value = { name: c.name, method: c.method, url: c.url }
  headersRows.value = rowsFromHeaders(c.headers)
  bodyText.value =
    c.body !== undefined ? (typeof c.body === 'string' ? c.body : JSON.stringify(c.body, null, 2)) : ''
  expected.value = {
    status: c.expected?.status ?? '',
    contains: c.expected?.contains || '',
    maxTimeMs: c.expected?.maxTimeMs ?? '',
  }
}

function buildPayload() {
  const exp = {}
  if (expected.value.status !== '') exp.status = Number(expected.value.status)
  if (expected.value.contains) exp.contains = String(expected.value.contains)
  if (expected.value.maxTimeMs !== '') exp.maxTimeMs = Number(expected.value.maxTimeMs)

  const payload = {
    name: form.value.name.trim(),
    method: form.value.method,
    url: form.value.url.trim(),
    headers: headersFromRows(headersRows.value),
    expected: exp,
  }
  const t = bodyText.value.trim()
  if (t) {
    try {
      payload.body = JSON.parse(t)
    } catch {
      payload.body = t
    }
  }
  return payload
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写名称')
  if (!form.value.url.trim()) return ElMessage.warning('请填写 URL')
  saving.value = true
  try {
    if (isEdit.value) {
      await api.updateCase(id.value, buildPayload())
      ElMessage.success('已更新')
    } else {
      await api.createCase(buildPayload())
      ElMessage.success('已创建')
    }
    router.push('/')
  } catch (e) {
    ElMessage.error('保存失败：' + (e.response?.data?.error || e.message))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.editor-card { max-width: 760px; margin: 0 auto; }
.editor-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.request-row { display: flex; gap: 10px; width: 100%; }
.kv-row { display: flex; gap: 10px; width: 100%; margin-bottom: 8px; align-items: center; }
</style>
