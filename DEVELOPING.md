# Sent to E-ink Reader 0.1.6：原名 Markdown 纯文本发送

第一阶段只发送正文：源笔记 `周记1.md` 直接保存为坚果云收件文件夹 `PicoBox/周记1.md`。同一收件目录内，同名笔记由后一次实际写入覆盖；不同文件夹或 Vault 的同名笔记也相互覆盖。重命名发送为新文件，修改笔记后须手动发送。

只读源笔记，当前编辑器使用未保存正文快照。frontmatter剥离、普通Obsidian双链转可读文字。图片、远程图及笔记嵌入转成正确转义的文字说明，明确提示“本次未发送图片”；标准、引用式及Obsidian图片均不上传。代码块、缩进代码及行内代码示例保留原样，动态查询保留源码而不执行。不会读取附件内容、解码或转换图片。

新入口只GET/PUT原文件名.md，不创建 `_pico`、版本目录、清单或 `attachments`，不自动备份或删除云文件。旧开发版云文件保留；历史协议源码与离线fixture测试保留，不被当前入口调用。本阶段不能显示文章图片。

## 安装、设置和使用

见[安装指南](INSTALL.md)。最低Obsidian **1.11.5**，允许移动端，桌面/Android/iPhone共享浏览器代码。命令面板、文件/编辑器菜单已实现，移动端长按菜单及真实安装仍需实测。SecretStorage API同步调用，不会静默把密码写入data.json。

普通设置只有收件文件夹（默认PicoBox）、账号、应用密码。先在坚果云建立收件文件夹，在插件中保存独立第三方应用密码。文件夹支持中文与子路径，自动生成HTTPS WebDAV地址；高级设置保留完整URL和密码存储标识，0.1.5及以前需要按INSTALL.md迁移，跨ID不保证设置或SecretStorage自动延续。不提供namespace分组。

运行“发送至 E-ink Reader”，接受图片省略提示。发送时显示“正在发送…”，成功后只显示“发送成功”与“完成”按钮；失败附一句简短原因。不再显示文件路径、回读步骤或取消后续发送按钮。收件路径可在插件设置中查看。在坚果云刷新同一账号的此文件夹查看，再在Pico云列表手动选择.md下载。插件成功表示云文件回读通过，设备仍需单独下载。重新下载同名更新后进度归零及独立本地删除由固件负责验收。

## 写入和确认契约

1. 拒绝NUL、孤立UTF-16代理项及超过256 KiB的准确UTF-8正文，合法中文/emoji保留。原名采用源basename（含.md），NFC归一化，最大240 UTF-8字节，禁止控制字符和路径分隔符；URL逐段编码一次。
2. GET云端同名文件，正文相同则再GET确认期间未变化，不写文件。
3. 需要写入时直接无条件PUT原名.md，不依赖ETag；缺失、弱、裸或带引号ETag均不阻止顺序更新。此阶段按用户要求等价于手动拖入同名文件覆盖，**同时发送以最后实际写入为准，不提供并发丢更新保护**。
4. PUT已发出后无论取消或连接异常，都GET同一文件确认结果。校验原始ArrayBuffer准确字节数及SHA256（仅text的测试transport采用严格UTF-8）。响应成功但内容缺失、不同或字节损坏不能报成功；响应丢失但准确正文已保存可确认成功；无法回读则报告结果不确定。

回读不同提示可能被其他发送覆盖，需刷新后重试。回读只确认当时内容，不保证其他发送稍后不会再覆盖。HTTP拒绝显示简短原因，不自动重放写请求。关闭窗口只隐藏界面，发送继续且完成后通知一次；窗口仍开着时不重复通知。停用插件会停止尚未发出的写入，在途PUT仍确认结果，不能宣称撤销。一个插件实例串行发送，各端不共享锁。

GET带no-cache请求头，429/503最多退避重试两次，每次最多10秒；不保证绕过云服务限额。URL要求无内嵌凭据/查询/片段的HTTPS。不记录密码、响应正文或原始网络异常。

## 构建与验证

```sh
npm ci --ignore-scripts
npm test
npm run package
```

Node仅用于构建/测试，运行时使用requestUrl、SecretStorage及浏览器Web Crypto。白名单生成 `build/Sent-to-E-ink-Reader-0.1.6.zip`（zip工具），包含main.js、manifest.json、README/INSTALL/DEVELOPING/CHANGELOG/LICENSE/NOTICE，无styles.css、凭据、笔记或个人配置。打包不安装到用户Vault。

76项离线测试含历史协议回归。发送窗口覆盖成功、无变化、认证失败、结果未确认和提前关闭；当前入口覆盖中文原名编码、首次/更新/无变化、同名跨Vault、所有ETag形式、最后写入覆盖、取消、响应丢失、正文不一致、认证/写入失败、文本限额及图片占位。三端浏览器替身确认只GET/PUT/GET同一个.md，不读附件，runtime bundle不含exportImages/convertImage函数。历史图文协议通过不代表当前支持图片。用户已确认0.1.3与if.6的基本推送、下载及阅读可用；新版窗口、移动端安装和后台挂起仍需实测。

官方API参考：[requestUrl](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl)、[SecretStorage类型](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)、[移动1.11.5 Keychain](https://obsidian.md/changelog/2026-01-20-mobile-v1.11.5/)。最低版本保持不变；社区ID迁移请见INSTALL.md。
