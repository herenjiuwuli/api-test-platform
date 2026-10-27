import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 覆盖率：只统计后端（UI 由 E2E 与真机断言覆盖，不用单测数字充数）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.js'],
      exclude: ['**/node_modules/**', 'tests/**', 'dist/**'],
      // 基线锁：当前实测值向下取整，改代码时不许把覆盖偷偷降下去
      thresholds: {
        // 2026-10-27 实测（补齐 src/ai.js 单测后）：语句 91.66 / 分支 84.27 / 函数 96.73 / 行 94.62
        lines: 94,
        statements: 91,
        functions: 96,
        branches: 84,
      },
    },
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // 在任何测试模块 import 前把 DB 切成内存，保证测试完全隔离、不碰真实库
    setupFiles: ['tests/setup.js'],
  },
})
