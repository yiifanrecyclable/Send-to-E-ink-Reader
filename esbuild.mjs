/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：插件独立浏览器构建工具。
 * English: standalone browser bundle builder.
 * 冻结：产物只写插件目录，不安装至用户 vault。
 * Frozen: write outputs only inside the plugin; never install into user vaults.
 */
import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts'], outfile: 'main.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['obsidian'],
  sourcemap: false, logLevel: 'info'
});
