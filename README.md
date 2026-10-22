# Sent to E-ink Reader

作者：**ifRecyclable** · 版本 **0.1.6**

在 Obsidian 中一键将当前 Markdown 笔记发送到坚果云指定文件夹，再由电子墨水屏阅读器下载阅读。配合 [if-ink OS](https://github.com/yiifanrecyclable/if-ink-OS) 使用。

[下载安装包](https://github.com/yiifanrecyclable/Sent-to-E-ink-Reader/releases/latest) · [安装与设置](INSTALL.md)

- 按原文件名保存，例如 `PicoBox/周记.md`；同名文件由后一次发送覆盖。
- 修改笔记后手动发送，发送窗口只显示进度与成功或失败结果。
- 第一版发送纯文本；图片和笔记嵌入转为文字说明，普通 Markdown 表格、标题、列表及文字样式保留。
- 读取当前笔记，不改动笔记原文。应用密码通过 Obsidian 的密码存储保存。

最低 Obsidian **1.11.5**。允许桌面、Android 和 iOS 使用；手机后台行为与各机型兼容性仍需实际验证。

## Network, accounts and privacy

Send the current Markdown note as a text-only `.md` file to a user-configured HTTPS WebDAV inbox. This plugin is intended for compatible e-ink readers, including if-ink OS, that can download ordinary Markdown files from that inbox. It does not connect directly to every reader or automatically synchronize edits.

- Sending is manual. Only the selected note's processed text is uploaded; the source note is not modified. Images and embedded notes are replaced by text notices after confirmation, and attachment contents are not uploaded.
- The plugin connects only to the WebDAV service configured in its settings. Nutstore (坚果云) is the default example; a WebDAV account, an existing inbox folder and an application password are required. The service can receive note text, filenames and authentication information and handles them under its own terms and privacy policy.
- This plugin is free and includes no paid features. Your chosen WebDAV provider may have paid plans or usage limits. Nutstore offers both free and paid plans; an Obsidian Sync subscription is not required.
- Application passwords are stored using Obsidian SecretStorage, not in the plugin's `data.json`. The account, endpoint and secret identifier are saved as ordinary plugin settings. The plugin includes no analytics, telemetry or advertising, and does not read files outside the vault.
- Sending a note with the same filename replaces the cloud file, including when it comes from another folder or vault. A successful send confirms the cloud text at that moment; download it separately on the reader.

The community-compatible plugin ID is `sent-to-e-ink-reader`. Existing manual installations using `obsidian-pico` must follow the [migration instructions](INSTALL.md); settings, secrets and shortcuts are not automatically migrated across IDs.

## 快速使用

1. 在坚果云根目录建立 `PicoBox`（也可使用已有文件夹）。
2. 安装并启用插件，在设置中填写收件文件夹、坚果云账号与第三方应用密码，点击保存密码。
3. 打开笔记，从命令面板选择「发送至 E-ink Reader」，或使用文件/编辑器菜单。
4. 看到「发送成功」后，在阅读器上刷新同一个文件夹并下载文章。

同一文件夹或不同 Vault 中的同名笔记会相互覆盖；重命名后发送会新增文件。插件发送成功代表云端正文已确认，阅读器需另行下载。

[开发与验证说明](DEVELOPING.md) · [Apache-2.0 许可证](LICENSE)
