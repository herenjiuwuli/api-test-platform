// 内置文件夹具（M8）。
//
// 为什么是内置而不是「让用户上传一个文件当夹具」：
//   自动化要的是**可重复**。每次跑都发一模一样的字节，断言才有意义；
//   而夹具又小到可以躺在代码库里 —— 这比让每个人各自准备一份文件省事得多。
//
// 字节内容刻意与 office-oa 的测试夹具保持一致（PNG 魔数 / %PDF 头 / MZ 头），
// 这样「只认真实字节、不看扩展名」这类断言在平台侧也能复现。

// 真魔数 PNG + 一段可读文本：文本部分让「下载回来内容对不对」可以用 contains 断言
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('iVBORw0KGgo-fake-png-body-content'),
])
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj\n<< >>\nendobj\n%%EOF')])
// MZ 开头（Windows 可执行文件），却故意起个图片扩展名 —— 用来验「认字节不认名字」
const FAKE_EXE = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0x90)])

export const FIXTURES = {
  png: { label: 'PNG 图片（真实魔数）', filename: 'fixture.png', contentType: 'image/png', bytes: PNG },
  pdf: { label: 'PDF 文档（真实魔数）', filename: 'fixture.pdf', contentType: 'application/pdf', bytes: PDF },
  'fake-exe': {
    label: '伪装成图片的可执行文件（MZ 头）——验「只认字节」',
    filename: 'fake.png',
    contentType: 'image/png',
    bytes: FAKE_EXE,
  },
}

export const fixtureNames = () => Object.keys(FIXTURES)

/** 按名字取夹具；不认识返回 null（调用方负责报错，不要静默当空文件发出去） */
export function getFixture(name) {
  return FIXTURES[String(name || '').trim()] || null
}
