# Changelog

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
