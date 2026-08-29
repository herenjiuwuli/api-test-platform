// 测试 setup：在所有测试模块 import 之前运行。
// 强制使用内存数据库，彻底杜绝测试把用例写成真实 data/app.db（生产库）。
// 即便 src/db.js 在某处提前读取 env，这里也是最先执行的，:memory: 必然生效。
process.env.DB_PATH = ':memory:'
