// 测试 setup：在所有测试模块 import 之前运行。
// 强制使用内存数据库，彻底杜绝测试把用例写成真实 data/app.db（生产库）。
// 即便 src/db.js 在某处提前读取 env，这里也是最先执行的，:memory: 必然生效。
process.env.DB_PATH = ':memory:'
// 测试旁路：关闭全局鉴权守卫，让既有 /api 测试无需 token 即可通过。
// 真实鉴权由 tests/auth.test.js 单独验证（该文件会覆盖此开关为启用）。
process.env.API_AUTH_DISABLED = '1'
