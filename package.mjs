/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：仅打包本地插件文件，不读取 vault 或配置，不安装或发布。
 * English: package local plugin files only; never read vault/configuration, install or publish.
 */
import { readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (manifest.id !== 'sent-to-e-ink-reader' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid package identity');
const directory = `build/${manifest.id}`;
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
// 中文：白名单防止把 data.json、凭据、依赖或笔记带入测试包。
// English: whitelist excludes data.json, secrets, dependencies and notes.
for (const file of ['main.js', 'manifest.json', 'INSTALL.md', 'README.md', 'DEVELOPING.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']) await copyFile(file, `${directory}/${file}`);
const archive = `Send-to-E-ink-Reader-${manifest.version}.zip`;
await rm(`build/${archive}`, { force: true });
const zipped = spawnSync('/usr/bin/zip', ['-q', '-r', archive, manifest.id], { cwd: 'build', stdio: 'inherit' });
if (zipped.status !== 0) throw new Error('Local zip packaging failed');
console.log(`Plugin package: build/${archive}`);
