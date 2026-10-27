# Send to E-ink Reader

作者：**ifRecyclable** · 版本 **0.1.8**

在 Obsidian 中一键将当前 Markdown 笔记发送到坚果云指定文件夹，再由电子墨水屏阅读器下载阅读。配合 [if-ink OS](https://github.com/yiifanrecyclable/if-ink-OS) 使用。

[下载安装包](https://github.com/yiifanrecyclable/Send-to-E-ink-Reader/releases/latest) · [安装与设置](INSTALL.md)

- 按原文件名保存，例如 `PicoBox/周记.md`；同名文件由后一次发送覆盖。
- 修改笔记后手动发送，发送窗口只显示进度与成功或失败结果。
- 支持本地 PNG、JPG/JPEG 插图，转换导出副本后保存到收件目录的单层 `attachments`；不修改源笔记或原图。图片发送默认关闭，开启后才会上传图片，沿用纯文本模式无需更改设置。
- 设备分辨率和灰阶可自行设置，默认 Pico 的 **684×1216、16灰阶**。输出为标准非交错灰度PNG；接收设备仍须支持所选格式。
- 普通 Markdown 表格、标题、列表及文字样式保留；远程图片、其他格式及笔记嵌入会在确认后转为文字说明。
- 读取当前笔记，不改动笔记原文。应用密码通过 Obsidian 的密码存储保存。

最低 Obsidian **1.11.5**。允许桌面、Android 和 iOS 使用；手机后台行为与各机型兼容性仍需实际验证。

## Network, accounts and privacy

Send the current Markdown note as a `.md` file with optional optimized local images to a user-configured HTTPS WebDAV inbox. This plugin is intended for compatible e-ink readers, including if-ink OS, that can download ordinary Markdown files from that inbox. It does not connect directly to every reader or automatically synchronize edits.

- Sending is manual. By default, only the selected note's processed text is uploaded. When you enable local images, referenced PNG/JPEG attachments are read from the vault, converted in memory and uploaded to the configured WebDAV attachments folder. Source notes/images are not modified. Remote images, unsupported formats and embedded notes are replaced by text notices after confirmation; no remote images are fetched.
- The plugin connects only to the WebDAV service configured in its settings. Nutstore (坚果云) is the default example; a WebDAV account, an existing inbox folder and an application password are required. The service can receive note text, selected image copies, filenames and authentication information and handles them under its own terms and privacy policy.
- This plugin is free and includes no paid features. Your chosen WebDAV provider may have paid plans or usage limits. Nutstore offers both free and paid plans; an Obsidian Sync subscription is not required.
- Application passwords are stored using Obsidian SecretStorage, not in the plugin's `data.json`. The account, endpoint and secret identifier are saved as ordinary plugin settings. The plugin includes no analytics, telemetry or advertising, and does not read files outside the vault.
- Sending a note with the same filename replaces the cloud file, including when it comes from another folder or vault. A successful send confirms the cloud text at that moment; download it separately on the reader.

The community-compatible plugin ID is `sent-to-e-ink-reader`. Existing manual installations using `obsidian-pico` must follow the [migration instructions](INSTALL.md); settings, secrets and shortcuts are not automatically migrated across IDs.

## 快速使用

1. 在坚果云根目录建立 `PicoBox`（也可使用已有文件夹）。
2. 安装并启用插件，在设置中填写收件文件夹、坚果云账号与第三方应用密码，点击保存密码。
3. 需要图文时，在插件设置开启「发送本地图片」，并确认阅读器固件已支持 Markdown 插图；Pico已发布的 if-ink OS 0.1.4 暂不支持本功能，需等待后续固件。
4. 打开笔记，从命令面板选择「发送至 E-ink Reader」，或使用文件/编辑器菜单。
5. 看到「发送成功」后，在阅读器上刷新同一个文件夹并下载文章。

同一文件夹或不同 Vault 中的同名笔记会相互覆盖；重命名后发送会新增文件。插件发送成功代表云端正文已确认，阅读器需另行下载。

图片用“文章名＋转换结果内容指纹”命名，同文同图重发不会重复写入，改图采用新名称。先核验所有附件，最后写正文；附件失败不更新正文，不自动删除云端旧图。单张导出图片≤2MiB、≤4Mi像素、高≤8192；每篇≤16MiB、≤64个图片引用。超限或转换失败会在发送前提示，需确认省略。

不使用坚果云时，可运行「导出至本地文件夹」。产物在库内 `E-ink Reader导出/`，将其中的 `.md` 和 `attachments/` 复制到设备文档目录；Pico对应TF的 `markdown/`。导出目录同名正文会更新，不能把导出文件当原笔记再次导出。

[开发与验证说明](DEVELOPING.md) · [Apache-2.0 许可证](LICENSE)
