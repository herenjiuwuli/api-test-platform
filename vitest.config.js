import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // 在任何测试模块 import 前把 DB 切成内存，保证测试完全隔离、不碰真实库
    setupFiles: ['tests/setup.js'],
  },
})
