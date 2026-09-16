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

      <el-form-item label="请求体类型">
        <el-select v-model="bodyType" style="width: 220px">
          <el-option v-for="t in bodyTypes" :key="t" :label="t" :value="t" />
        </el-select>
        <p class="json-hint">{{ bodyTypeHint }}</p>
      </el-form-item>

      <el-form-item :label="bodyLabel">
        <el-input v-model="bodyText" type="textarea" :rows="5" :placeholder="bodyPlaceholder" />
      </el-form-item>

      <el-form-item v-if="bodyType === 'form-data'" label="文件字段">
        <div v-for="(f, i) in fileRows" :key="i" class="kv-row">
          <el-input v-model="f.name" placeholder="字段名 如 file" style="width: 130px" />
          <el-select v-model="f.fixture" placeholder="选夹具" style="width: 260px">
            <el-option v-for="fx in fixtures" :key="fx.name" :value="fx.name" :label="fx.name + ' — ' + fx.label" />
          </el-select>
          <el-input v-model="f.filename" :placeholder="fixturePlaceholder(f.fixture)" style="flex: 1" />
          <el-button text type="danger" @click="fileRows.splice(i, 1)">移除</el-button>
        </div>
        <el-button size="small" @click="fileRows.push(newFileRow())">+ 添加文件</el-button>
        <p class="json-hint">
          Content-Type 与 boundary 由平台自动设置（会覆盖你手填的那个）｜ 文件内容来自内置夹具，每次跑字节都一样，断言才可重复
        </p>
        <p v-if="otherFiles.length" class="json-hint">
          另有 {{ otherFiles.length }} 个用 base64 定义的字段（界面暂不支持编辑，保存时会原样保留）
        </p>
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

      <el-form-item label="JSON 断言">
        <div v-for="(j, i) in jsonChecksRows" :key="i" class="kv-row">
          <el-input v-model="j.path" placeholder="路径 如 $.data.code" style="width: 240px" />
          <el-select v-model="j.op" style="width: 120px">
            <el-option v-for="o in jsonOps" :key="o" :label="o" :value="o" />
          </el-select>
          <el-input v-model="j.value" placeholder="期望值" style="flex: 1" />
          <el-button text type="danger" @click="jsonChecksRows.splice(i, 1)">移除</el-button>
        </div>
        <el-button size="small" @click="jsonChecksRows.push({ path: '', op: 'eq', value: '' })">+ 添加 JSON 断言</el-button>
        <p class="json-hint">路径：$.a.b / $.arr[0] / $.arr[*] / .length ｜ 操作符：eq ne gt gte lt lte contains exists</p>
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        <el-button @click="$router.push('/')">取消</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const isEdit = computed(() => !!route.params.id)

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const jsonOps = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']

// M8：请求体类型与文件夹具的可选值来自后端（唯一事实来源），这里只留一份兜底
const bodyTypes = ref(['json', 'raw', 'form-data'])
const fixtures = ref([])
const metaLoaded = ref(false)
const bodyType = ref('json')
const fileRows = ref([])
const otherFiles = ref([]) // 用 base64 定义的字段：界面不编辑，保存时原样带回

const HINTS = {
  json: 'JS 值会 JSON.stringify 后发出，Content-Type 请自己写（如 application/json）',
  raw: '原样发一段文本，不做任何包装 —— 适合 XML / CSV / GraphQL',
  'form-data': 'multipart/form-data：文本字段填在下面（JSON 对象），文件从内置夹具里选',
}
const PLACEHOLDERS = {
  json: 'JSON 或原始文本（如 {"page": 1}）',
  raw: '原始文本（如 a=1&b=2）',
  'form-data': '文本字段，写成 JSON 对象（如 {"note": "hello"}）；没有就留空',
}
const bodyTypeHint = computed(() => HINTS[bodyType.value] || HINTS.json)
const bodyPlaceholder = computed(() => PLACEHOLDERS[bodyType.value] || PLACEHOLDERS.json)
const bodyLabel = computed(() => (bodyType.value === 'form-data' ? '文本字段' : '请求体'))

const form = ref({ name: '', method: 'GET', url: '' })
const headersRows = ref([{ key: '', value: '' }])
const jsonChecksRows = ref([{ path: '', op: 'eq', value: '' }])
const bodyText = ref('')
const expected = ref({ status: '', contains: '', maxTimeMs: '' })
const saving = ref(false)

function newFileRow() {
  return { name: 'file', fixture: '', filename: '' }
}

/** 选中的夹具对应的默认文件名，当作输入框的占位提示 */
function fixturePlaceholder(name) {
  const fx = fixtures.value.find((f) => f.name === name)
  return fx ? fx.filename : '文件名（留空就用夹具默认名）'
}

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

/** 把表单恢复成「新建」的初始状态 —— 换用例时必须先清，否则会残留上一条的内容 */
function resetForm() {
  form.value = { name: '', method: 'GET', url: '' }
  headersRows.value = [{ key: '', value: '' }]
  jsonChecksRows.value = [{ path: '', op: 'eq', value: '' }]
  bodyText.value = ''
  bodyType.value = 'json'
  fileRows.value = []
  otherFiles.value = []
  expected.value = { status: '', contains: '', maxTimeMs: '' }
}

async function load() {
  // 可选值只需要取一次（同一份 meta 在会话里不会变）
  if (!metaLoaded.value) {
    try {
      const meta = await api.bodyOptions()
      if (meta && Array.isArray(meta.bodyTypes) && meta.bodyTypes.length) bodyTypes.value = meta.bodyTypes
      if (meta && Array.isArray(meta.fixtures)) fixtures.value = meta.fixtures
    } catch {
      // 拿不到就用兜底值，不因为一个下拉框的选项挡住编辑
    }
    metaLoaded.value = true
  }
  resetForm()
  if (!isEdit.value) return
  const c = await api.getCase(id.value)
  form.value = { name: c.name, method: c.method, url: c.url }
  headersRows.value = rowsFromHeaders(c.headers)
  bodyType.value = c.bodyType || 'json'
  bodyText.value =
    c.body !== undefined ? (typeof c.body === 'string' ? c.body : JSON.stringify(c.body, null, 2)) : ''
  const files = Array.isArray(c.files) ? c.files : []
  fileRows.value = files
    .filter((f) => f && f.fixture)
    .map((f) => ({ name: f.name || 'file', fixture: f.fixture, filename: f.filename || '' }))
  otherFiles.value = files.filter((f) => f && !f.fixture)
  expected.value = {
    status: c.expected?.status ?? '',
    contains: c.expected?.contains || '',
    maxTimeMs: c.expected?.maxTimeMs ?? '',
  }
  jsonChecksRows.value = (c.expected?.jsonChecks?.length
    ? c.expected.jsonChecks
    : [{ path: '', op: 'eq', value: '' }]
  ).map((j) => ({ path: j.path || '', op: j.op || 'eq', value: j.value !== undefined ? String(j.value) : '' }))
}

function buildPayload() {
  const exp = {}
  if (expected.value.status !== '') exp.status = Number(expected.value.status)
  if (expected.value.contains) exp.contains = String(expected.value.contains)
  if (expected.value.maxTimeMs !== '') exp.maxTimeMs = Number(expected.value.maxTimeMs)
  const checks = jsonChecksRows.value
    .filter((j) => j.path && j.path.trim())
    .map((j) => ({ path: j.path.trim(), op: j.op, value: j.value }))
  if (checks.length) exp.jsonChecks = checks

  const payload = {
    name: form.value.name.trim(),
    method: form.value.method,
    url: form.value.url.trim(),
    headers: headersFromRows(headersRows.value),
    bodyType: bodyType.value,
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
  if (bodyType.value === 'form-data') {
    payload.files = [
      ...fileRows.value
        .filter((f) => f.fixture)
        .map((f) => ({
          name: (f.name || 'file').trim(),
          fixture: f.fixture,
          ...(f.filename && f.filename.trim() ? { filename: f.filename.trim() } : {}),
        })),
      ...otherFiles.value,
    ]
  }
  return payload
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写名称')
  if (!form.value.url.trim()) return ElMessage.warning('请填写 URL')
  // 前端先拦一道：form-data 的文本字段必须是 JSON 对象，不然发出去后端只会给一句「请写成对象」
  if (bodyType.value === 'form-data' && bodyText.value.trim()) {
    let ok = false
    try {
      const v = JSON.parse(bodyText.value)
      ok = !!v && typeof v === 'object' && !Array.isArray(v)
    } catch {
      ok = false
    }
    if (!ok) return ElMessage.warning('form-data 的文本字段要写成 JSON 对象，如 {"note": "hello"}')
  }
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

// ⚠️ `/cases/:id/edit` 与 `/cases/new` 用的是**同一个组件**，vue-router 会复用实例、不再触发 onMounted。
//    真机验证时抓到的：从「编辑」直接切到「新建」，表单会残留上一条用例的内容（连 bodyType 都还是 form-data）。
//    所以必须盯住路由参数自己重载 —— 组件复用不会帮你重置状态。
watch(
  () => id.value,
  () => {
    load()
  },
)
</script>

<style scoped>
.editor-card { max-width: 760px; margin: 0 auto; }
.editor-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.request-row { display: flex; gap: 10px; width: 100%; }
.kv-row { display: flex; gap: 10px; width: 100%; margin-bottom: 8px; align-items: center; }
.json-hint { font-size: 12px; color: #909399; margin: 6px 0 0; line-height: 1.6; }
</style>
