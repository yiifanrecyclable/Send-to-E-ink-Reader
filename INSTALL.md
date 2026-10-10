# 安装与设置

## 首次安装

1. 从 [GitHub Releases](https://github.com/yiifanrecyclable/Sent-to-E-ink-Reader/releases/latest) 下载 `Sent-to-E-ink-Reader-0.1.5.zip` 并解压。
2. 将解压得到的 **obsidian-pico** 文件夹放入笔记库的 `.obsidian/plugins/` 中。最终应有 `.obsidian/plugins/obsidian-pico/main.js` 和同目录的 `manifest.json`。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 **Sent to E-ink Reader**。

手机也使用同样的笔记库内路径，可用文件管理器或电脑复制插件文件。最低 Obsidian 1.11.5；移动端后台发送和安装方式需按设备验证。

## 从 Send to Pico 升级

先停用旧插件，只覆盖原 `obsidian-pico` 文件夹里的 `main.js` 和 `manifest.json`，再启用新版。保留原来的 `data.json` 和 Obsidian 密码存储，原账号、文件夹及已保存的应用密码继续使用。为兼容旧版本，安装文件夹仍使用 `obsidian-pico`。

## 坚果云设置

1. 在坚果云根目录建立收件文件夹，例如 `PicoBox`。
2. 在坚果云「设置 → 第三方应用管理」中添加应用，生成应用密码。
3. 打开插件设置，填写收件文件夹和坚果云账号，输入应用密码并点击「保存密码」。应用密码不同于坚果云登录密码。
4. 阅读器端填写相同账号和文件夹，然后分别执行插件发送、阅读器刷新与下载。

普通用户无需修改折叠的高级设置。

## 使用

打开 Markdown 笔记，从命令面板或文件/编辑器菜单选择「发送至 E-ink Reader」。图片或嵌入会先提示转成文字说明，确认后发送。文章修改后需再次手动发送。

成功时显示「发送成功」；失败时显示简短原因。若失败，先检查网络、应用密码，以及收件文件夹是否已存在。关闭发送窗口后任务仍继续，完成时会通知。
