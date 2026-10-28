# Changelog

## 0.1.10

- Detect PNG/JPEG/WebP from file signatures before validation and browser decoding. Imported attachments with a misleading extension (such as JPEG/PNG named `.webp`) now convert normally without renaming or changing the source.
- Retain format/size/animation checks, existing settings, text-only behavior and verified attachment-first publication.

## 0.1.9

- Support static WebP attachments (lossy, lossless and alpha), converting export copies to the configured screen resolution and grayscale PNG profile. Transparent pixels are composited over white.
- Validate WebP dimensions and container boundaries before decoding; animated WebP and failed conversions require confirmation before omission.
- Preserve source notes/images, text-only sending, existing PNG/JPEG handling, plugin ID, settings and credentials.

## 0.1.8

- Add optional local PNG/JPEG export with configurable screen resolution and grayscale levels; default profile is Pico 684×1216 / 16 levels. Image sending defaults off, preserving existing text-only behavior.
- Publish verified, immutable images in a flat `attachments` folder before updating Markdown; image failures preserve the previous cloud document. Source notes/images are unchanged.
- Add local-folder export for readers that do not use WebDAV. A receiving reader must support Markdown images; unsupported or remote images require confirmation before omission.
- Keep the name **Send to E-ink Reader** and existing plugin ID/settings/credentials.

## 0.1.7

- Correct the display name to **Send to E-ink Reader**.
- Keep plugin ID `sent-to-e-ink-reader`, settings, commands and text-only sending behavior unchanged; no reinstall or migration is needed from 0.1.6.

## 0.1.6

- Adopt community-compatible ID `sent-to-e-ink-reader`; existing manual installations need the migration steps in INSTALL.md.
- Add explicit network, account, pricing and privacy disclosures for community submission.
- Resolve static type/regex warnings without changing runtime behavior; defensive path validation is retained.
- Keep the verified text-only sending behavior of 0.1.5; image export is not included.

## 0.1.5

- 插件命名为 Sent to E-ink Reader，作者 ifRecyclable；命令与发送窗口同步更新名称。
- 保留原插件目录与设置标识，已有账号、文件夹、密码及快捷键可继续使用。
- 独立 GitHub 发布，提供安装包、源码、安装指南与构建说明。
- 延续 0.1.4 的纯文本原名发送、同名覆盖与云端回读确认。
