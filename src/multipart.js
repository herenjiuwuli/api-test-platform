// multipart/form-data 请求体（M8）——手搓。
//
// 为什么手搓、不引 form-data 或直接用 undici 的 FormData：
//   ① 平台的原则是「零第三方依赖」（除了 Fastify 与 node-cron，其余全是 Node 内置能力）；
//   ② 手搓才能把 boundary / CRLF / 结尾的 `--` / Content-Length 这些细节摆在明面上
//      —— 而这几个细节恰恰是这一层最容易写错的地方，写错了服务端就是「解析不出文件」。
//
// ⚠️ 一个必须记住的约定：multipart 的 Content-Type **必须带 boundary**。
//    所以执行器会覆盖掉用例里手填的 Content-Type —— 否则服务端根本切不开分段。
import crypto from 'node:crypto'
import { fixtureNames, getFixture } from './fixtures.js'

/** 生成 boundary：随机 24 位十六进制，长到几乎不可能出现在文件内容里 */
export function makeBoundary() {
  return `----apiTestPlatform${crypto.randomBytes(12).toString('hex')}`
}

// 文件名里的引号/换行会把 header 撕开（和 office-oa 那边 safeDownloadName 是同一类问题）。
// 这里不清洗「显示名」，只保证**发出去的 header 是合法的**：引号转义、换行直接去掉。
function escapeHeaderValue(s) {
  return String(s ?? '')
    .replace(/"/g, '%22')
    .replace(/[\r\n]/g, '')
}

// 单个文本字段的分段
function textPart(boundary, name, value) {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeHeaderValue(name)}"\r\n\r\n` +
      `${value ?? ''}\r\n`,
    'utf8',
  )
}

// 单个文件字段的分段：header + **原始字节** + CRLF（字节必须原样拼，不能经过字符串编码）
function filePartHead(boundary, { name, filename, contentType }) {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeHeaderValue(name)}"; filename="${escapeHeaderValue(filename)}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  )
}

/**
 * 拼一个 multipart/form-data 请求体。
 * @param {Array<{name:string,value:string}>} fields 文本字段
 * @param {Array<{name:string,filename:string,contentType:string,bytes:Buffer}>} files 文件字段
 * @param {string} [boundary]
 * @returns {{body:Buffer, boundary:string, contentType:string}}
 */
export function buildMultipart(fields = [], files = [], boundary = makeBoundary()) {
  const chunks = []
  for (const f of fields) chunks.push(textPart(boundary, f.name, f.value))
  for (const f of files) {
    chunks.push(filePartHead(boundary, f))
    chunks.push(Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  // 结束分隔符：注意是 `--boundary--`（尾部多两个短横），漏了它很多实现会认为请求没结束
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return {
    body: Buffer.concat(chunks),
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/**
 * 把用例里的 files 声明解析成真实字节。
 * 支持两种来源：`fixture`（内置夹具名）或 `base64`（临时塞一段内容）。
 * @returns {{files:Array, unknown:string[]}} unknown = 引用了但不存在的夹具名
 */
export function resolveFiles(decls = []) {
  const files = []
  const unknown = []
  for (const d of Array.isArray(decls) ? decls : []) {
    const name = (d && d.name ? String(d.name) : '').trim() || 'file'
    if (d && d.fixture) {
      const fx = getFixture(d.fixture)
      if (!fx) {
        unknown.push(String(d.fixture))
        continue
      }
      files.push({
        name,
        filename: (d.filename ? String(d.filename) : '').trim() || fx.filename,
        contentType: (d.contentType ? String(d.contentType) : '').trim() || fx.contentType,
        bytes: fx.bytes,
      })
      continue
    }
    if (d && d.base64) {
      files.push({
        name,
        filename: (d.filename ? String(d.filename) : '').trim() || 'inline.bin',
        contentType: (d.contentType ? String(d.contentType) : '').trim() || 'application/octet-stream',
        bytes: Buffer.from(String(d.base64), 'base64'),
      })
      continue
    }
    // 既没有 fixture 也没有 base64：当成写错了，别静默发一个空文件出去
    unknown.push('(空声明：既没有 fixture 也没有 base64)')
  }
  return { files, unknown }
}

/** 引用到不存在的夹具时的错误文案（把可选值列出来，省一次翻文档） */
export function unknownFixtureMessage(unknown) {
  return `用例引用了不存在的文件夹具：${unknown.join('、')} —— 可选：${fixtureNames().join(' / ')}（或用 base64 直接给内容）`
}

/** 把用例的 body 转成 form-data 的文本字段列表 */
export function toFields(body) {
  if (body === undefined || body === null) return []
  if (typeof body === 'object' && !Array.isArray(body)) {
    return Object.entries(body).map(([name, value]) => ({
      name,
      value: value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
    }))
  }
  throw new Error('form-data 的文本字段请写成 JSON 对象（如 {"a":1}）；要发原始文本请把请求体类型改成 raw')
}
