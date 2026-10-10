/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：插件入口、发送命令和菜单、凭据设置与状态窗口。
 * English: plugin lifecycle, send entrances, credential settings and progress UI.
 * 冻结：只读源笔记；凭据只存 SecretStorage；原文件名直写纯文本，取消后仍确认已发出的PUT。
 * 用户修订：第一版按原文件名覆盖纯文本；发送窗口只显示进度和结果，关闭窗口不取消发送。
 * Frozen: read notes only, use SecretStorage, send flat text filenames and verify dispatched PUTs even after cancellation.
 * User revision: v1 sends text-only original filenames; show simple progress/results, and closing the window does not cancel sending.
 */
import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type MarkdownView } from 'obsidian';
import { type TextExport } from './preprocess';
import { PublishError, type Cancellation } from './publish';
import { publishFlat } from './flat-publish';
import { ObsidianDavTransport } from './transport';
import { exportText } from './export-text';
import { endpointFolder, folderEndpoint } from './inbox-settings';

interface PicoSettings { endpoint: string; account: string; secretId: string }
const defaults: PicoSettings = { endpoint: folderEndpoint('PicoBox'), account: '', secretId: 'pico-webdav' };

// 中文：插件只读取笔记，凭据仅存 SecretStorage。/ English: read notes only; credentials live exclusively in SecretStorage.
export default class PicoPlugin extends Plugin {
  settings: PicoSettings = { ...defaults };
  private busy = false;
  private activeCancel?: Cancellation;
  async onload(): Promise<void> {
    const stored = await this.loadData() as Partial<PicoSettings> | null;
    // 中文：白名单读取配置，拒绝将历史密码键写回。/ English: whitelist settings and never persist legacy password keys.
    this.settings = Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
      [key, typeof stored?.[key as keyof PicoSettings] === 'string' ? stored[key as keyof PicoSettings] : value])) as unknown as PicoSettings;
    this.addSettingTab(new PicoSettingsTab(this.app, this));
    this.addCommand({
      id: 'send-to-pico', name: '发送至 E-ink Reader',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.send(file);
        return true;
      }
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item =>
        item.setTitle('发送至 E-ink Reader').setIcon('send').onClick(() => { void this.send(file); }));
    }));
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, _editor, info) => {
      if (info.file?.extension === 'md') menu.addItem(item =>
        item.setTitle('发送至 E-ink Reader').setIcon('send').onClick(() => { if (info.file) void this.send(info.file); }));
    }));
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  onunload(): void { if (this.activeCancel) this.activeCancel.requested = true; }
  private async send(file: TFile): Promise<void> {
    if (this.busy) { new Notice('已有发送任务，请等待完成。'); return; }
    this.busy = true;
    const cancel: Cancellation = { requested: false };
    this.activeCancel = cancel;
    const settings = { ...this.settings };
    const vaultPath = file.path;
    const fallbackTitle = file.basename;
    let progress: PublishModal | undefined;
    try {
      if (!this.app.secretStorage) throw new Error('需要 Obsidian 1.11.5 或更新版本及 SecretStorage。');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(settings.secretId)) throw new Error('凭据标识仅支持小写字母、数字和短横线。');
      const secret = this.app.secretStorage.getSecret(settings.secretId);
      if (!secret) throw new Error('请在插件设置中保存坚果云应用密码。');
      // 中文：读取当前编辑器的快照，其他文件读 Vault。/ English: snapshot the active editor; read other files through Vault.
      const leaf = this.app.workspace.getMostRecentLeaf();
      const view = leaf?.view as Partial<MarkdownView> | undefined;
      const snapshot = view?.file?.path === file.path && view.editor ? view.editor.getValue() : await this.app.vault.cachedRead(file);
      const exported = exportText(snapshot, fallbackTitle);
      if (exported.warnings.length && !await new ExportWarningModal(this.app, exported).ask()) return;
      if (cancel.requested) throw new PublishError('已取消发送，尚未写入云端文件。', 'cancelled');
      progress = new PublishModal(this.app);
      progress.open();
      const transport = new ObsidianDavTransport(settings.endpoint, settings.account, secret, cancel);
      await publishFlat(transport, { vaultPath, body: exported.body }, cancel);
      progress.finish('发送成功');
    } catch (error) {
      // 中文：不输出传输异常原文以免包含凭据。/ English: avoid raw transport errors that may contain credentials.
      const message = this.safeError(error);
      if (progress) progress.finish('发送失败', message); else new Notice(`发送失败：${message}`, 8000);
    } finally { this.busy = false; this.activeCancel = undefined; }
  }
  private safeError(error: unknown): string {
    if (error instanceof PublishError) {
      if (error.outcome === 'uncertain') return '云端结果未确认，请联网后重新发送。';
      if (error.outcome === 'cancelled') return '发送已停止，请重新发送。';
      if (/HTTP (401|403)/.test(error.message)) return '请检查账号、应用密码和文件夹权限。';
      if (/HTTP 404/.test(error.message)) return '请确认坚果云收件文件夹已创建。';
      if (/HTTP (429|503)/.test(error.message)) return '云服务暂时不可用，请稍后重试。';
      if (error.message.includes('256 KiB')) return '文档过大，请缩减正文后重试。';
      if (/另一端|正文与本次不同/.test(error.message)) return '云端内容发生变化，请重新发送。';
      return '请检查文档和网络后重试。';
    }
    const known = [
      '需要 Obsidian', '凭据标识', '请在插件设置', '目标必须', '账号或应用密码',
      '路径无效', '源文件名', '文本包含孤立'
    ];
    return error instanceof Error && known.some(prefix => error.message.startsWith(prefix))
      ? error.message : '请检查网络和插件设置后重试。';
  }
}

class PicoSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PicoPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('p', { text: '手动发送纯文本 Markdown，直接保存为收件文件夹中的原文件名.md；本次不发送图片。同名笔记由后一次发送更新，电脑和手机填写相同收件文件夹即可。修改后仍需手动发送。' });
    const addText = (name: string, key: keyof PicoSettings, description: string, parent = containerEl) =>
      new Setting(parent).setName(name).setDesc(description).addText(text =>
        text.setValue(this.plugin.settings[key]).onChange(async value => {
          this.plugin.settings[key] = value.trim(); await this.plugin.saveSettings();
        }));
    const folder = new Setting(containerEl).setName('收件文件夹');
    const showTarget = () => folder.setDesc(`先在坚果云创建此文件夹；Pico也填写同一路径。当前目标：${this.plugin.settings.endpoint}`);
    showTarget();
    folder.addText(text => text.setPlaceholder('PicoBox').setValue(endpointFolder(this.plugin.settings.endpoint) ?? '').onChange(async value => {
      try {
        const endpoint = folderEndpoint(value);
        this.plugin.settings.endpoint = endpoint; await this.plugin.saveSettings(); showTarget();
      } catch { folder.setDesc('路径尚未有效，原收件地址保持不变。填写例如 PicoBox 或 阅读/PicoBox；需先在坚果云创建。'); }
    }));
    addText('账号', 'account', '坚果云账号；使用第三方应用密码。');
    let password = '';
    const secretSetting = new Setting(containerEl).setName('应用密码').setDesc('保存在 Obsidian SecretStorage。密码不会写入插件 data.json。');
    secretSetting.addText(text => {
      text.inputEl.type = 'password'; text.setPlaceholder('输入新的应用密码');
      text.onChange(value => { password = value; });
      secretSetting.addButton(button => button.setButtonText('保存密码').onClick(() => {
        if (!password || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(this.plugin.settings.secretId) || !this.app.secretStorage) {
          new Notice('密码、凭据标识或 SecretStorage 不可用。'); return;
        }
        this.app.secretStorage.setSecret(this.plugin.settings.secretId, password);
        password = ''; text.setValue(''); new Notice('应用密码已保存。');
      }));
    });
    const advanced = containerEl.createEl('details');
    advanced.createEl('summary', { text: '高级兼容设置（通常无需修改）' });
    addText('完整 WebDAV 地址', 'endpoint', '保留旧地址或自定义服务；普通坚果云用户使用上方收件文件夹。', advanced);
    addText('密码存储标识', 'secretId', '默认 pico-webdav，无需填写。改动后须重新保存应用密码。', advanced);
  }
}

class ExportWarningModal extends Modal {
  private resolve?: (value: boolean) => void;
  private answered = false;
  constructor(app: App, private readonly exported: TextExport) { super(app); }
  ask(): Promise<boolean> { return new Promise(resolve => { this.resolve = resolve; this.open(); }); }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '发送前确认未支持内容' });
    this.contentEl.createEl('p', { text: '本次只发送纯文本，图片或嵌入已改为文字说明；未读取或上传图片，代码示例保留原样。源笔记不变。' });
    const list = this.contentEl.createEl('ul');
    for (const warning of this.exported.warnings) list.createEl('li', { text: warning });
    new Setting(this.contentEl).addButton(button => button.setButtonText('取消').onClick(() => this.close()))
      .addButton(button => button.setButtonText('继续发送').setCta().onClick(() => {
        this.answered = true; this.resolve?.(true); this.close();
      }));
  }
  onClose(): void { if (!this.answered) this.resolve?.(false); this.contentEl.empty(); }
}

class PublishModal extends Modal {
  private closed = false;
  onOpen(): void {
    this.closed = false;
    this.contentEl.createEl('h3', { text: '发送至 E-ink Reader' });
    this.contentEl.createEl('p', { text: '正在发送…' });
  }
  finish(message: string, reason?: string): void {
    // 中文：关闭只隐藏窗口；后台完成时通知一次，不重复显示技术回执。
    // English: closing only hides the window; notify once after background completion without technical receipts.
    if (this.closed) { new Notice(reason ? `${message}：${reason}` : message, 8000); return; }
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: '发送至 E-ink Reader' });
    this.contentEl.createEl('p', { text: message });
    if (reason) this.contentEl.createEl('p', { text: reason });
    new Setting(this.contentEl).addButton(button => button.setButtonText('完成').setCta().onClick(() => this.close()));
  }
  onClose(): void { this.closed = true; this.contentEl.empty(); }
}
