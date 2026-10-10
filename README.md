# Sent to E-ink Reader

作者：**ifRecyclable** · 版本 **0.1.5**

在 Obsidian 中一键将当前 Markdown 笔记发送到坚果云指定文件夹，再由电子墨水屏阅读器下载阅读。配合 [Pico Reader IF Edition](https://github.com/yiifanrecyclable/PicoReader-ifEdition) 使用。

[下载安装包](https://github.com/yiifanrecyclable/Sent-to-E-ink-Reader/releases/latest) · [安装与设置](INSTALL.md)

- 按原文件名保存，例如 `PicoBox/周记.md`；同名文件由后一次发送覆盖。
- 修改笔记后手动发送，发送窗口只显示进度与成功或失败结果。
- 第一版发送纯文本；图片和笔记嵌入转为文字说明，普通 Markdown 表格、标题、列表及文字样式保留。
- 读取当前笔记，不改动笔记原文。应用密码通过 Obsidian 的密码存储保存。

最低 Obsidian **1.11.5**。允许桌面、Android 和 iOS 使用；手机后台行为与各机型兼容性仍需实际验证。

## 快速使用

1. 在坚果云根目录建立 `PicoBox`（也可使用已有文件夹）。
2. 安装并启用插件，在设置中填写收件文件夹、坚果云账号与第三方应用密码，点击保存密码。
3. 打开笔记，从命令面板选择「发送至 E-ink Reader」，或使用文件/编辑器菜单。
4. 看到「发送成功」后，在阅读器上刷新同一个文件夹并下载文章。

同一文件夹或不同 Vault 中的同名笔记会相互覆盖；重命名后发送会新增文件。插件发送成功代表云端正文已确认，阅读器需另行下载。

[开发与验证说明](DEVELOPING.md) · [Apache-2.0 许可证](LICENSE)
