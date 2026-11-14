/**
 * 扩展宿主。
 *
 * 生命周期只有四步，但每一步都必须是可观测、可回滚的：
 *   discover（读清单、校验、纯数据注册贡献）
 *     → resolve（拓扑排序、依赖与版本、缺失依赖标记 degraded）
 *     → activate（加载代码、投影 api、跑 activate()）
 *     → deactivate（dispose 订阅、注销贡献、清 api）
 *
 * 三条硬要求：
 *   - 代码只在激活事件命中时才加载；
 *   - 任何一个扩展抛异常都不能影响启动和其他扩展；
 *   - 失败原因必须是人话，直接进扩展面板。
 */
import { DisposableStore, Emitter } from './events';
import { ContributionRegistry, registry as defaultRegistry } from './registry';
import { executeCommand, installKeybindingListener, registerCommandContribution, registerKeybinding } from './commands';
import { configuration } from './config';
import { parseDependency, validateManifest, CORE_API_VERSION, CORE_VERSION } from './manifest';
import { satisfies } from './semver';
import { createExtensionApi } from './api';
import { createStorage, type ExtensionStorage } from './storage';
import { evaluateWhen } from './when';
import { defaultGrant, grantedPermissions, isDisabled, isGranted, grant as grantConsent, revoke as revokeConsent, setDisabled } from './consent';
import type {
  Disposable,
  ExtensionManifest,
  ExtensionRecord,
  ExtensionStatus,
  HostEnvironment
} from './types';

export interface ExtensionViewRuntime {
  mount?(ctx: unknown): void;
  update?(ctx: unknown): void;
  resize?(ctx: unknown): void;
  unmount?(ctx: unknown): void;
}

export interface HostChange {
  extId: string;
  status: ExtensionStatus;
  message: string;
}

/** 运行时注册表：需要“代码”而不是“数据”的贡献点都放这里。 */
export interface RuntimeRegistries {
  views: Map<string, unknown>;
  widgets: Map<string, unknown>;
  protocols: Map<string, unknown>;
  operators: Map<string, unknown>;
  dataSources: Map<string, unknown>;
  aiTools: Map<string, unknown>;
}

function createRuntimeRegistries(): RuntimeRegistries {
  return {
    views: new Map(),
    widgets: new Map(),
    protocols: new Map(),
    operators: new Map(),
    dataSources: new Map(),
    aiTools: new Map()
  };
}

const LOAD_TIMEOUT_MS = 12000;

function loadClassicScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-xhgcs-ext="${url}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.dataset.xhgcsExt = url;
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`加载超时：${url}`));
    }, LOAD_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };
    script.onload = () => {
      cleanup();
      resolve();
    };
    script.onerror = () => {
      cleanup();
      reject(new Error(`加载失败：${url}`));
    };
    document.head.appendChild(script);
  });
}

interface ExtensionModule {
  activate?: (ctx: unknown) => unknown;
  deactivate?: () => unknown;
}

export class ExtensionHost {
  readonly registry: ContributionRegistry;
  readonly runtime: RuntimeRegistries = createRuntimeRegistries();
  private readonly records = new Map<string, ExtensionRecord>();
  private readonly onChange = new Emitter<HostChange>();
  private keybindingDisposer: Disposable | null = null;
  private contextProvider: () => Record<string, unknown> = () => ({});
  private started = false;

  constructor(private readonly env: HostEnvironment, options: { registry?: ContributionRegistry } = {}) {
    this.registry = options.registry || defaultRegistry;
  }

  onDidChange(listener: (change: HostChange) => void): Disposable {
    return this.onChange.on(listener);
  }

  setContextProvider(provider: () => Record<string, unknown>): void {
    this.contextProvider = provider;
  }

  getContext(): Record<string, unknown> {
    try {
      return this.contextProvider() || {};
    } catch {
      return {};
    }
  }

  list(): ExtensionRecord[] {
    return Array.from(this.records.values());
  }

  get(extId: string): ExtensionRecord | undefined {
    return this.records.get(extId);
  }

  /** 发现：把清单读进来、校验、注册纯数据贡献。不执行任何插件代码。 */
  add(manifest: ExtensionManifest, opts: { source?: string } = {}): ExtensionRecord {
    const existing = this.records.get(manifest.id);
    if (existing) return existing;
    const issues = this.validateAgainstCore(manifest);
    const record: ExtensionRecord = {
      manifest,
      status: 'resolved',
      message: issues.join('；'),
      source: opts.source === 'user' ? 'user' : 'bundled',
      activatedAt: 0,
      activatedBy: '',
      lastError: '',
      disposables: [],
      module: null,
      exports: null
    };
    record.disposables.push(createStorageDisposer(manifest.id));
    this.records.set(manifest.id, record);
    this.registerContributions(record);
    if (issues.length) {
      record.status = 'degraded';
      this.emit(record);
    }
    return record;
  }

  /** 从 plugins/index.json 读取清单列表。index 里既可以直接内联清单，也可以给清单路径。 */
  async discover(indexUrl = 'plugins/index.json'): Promise<ExtensionRecord[]> {
    let entries: unknown[] = [];
    try {
      const response = await fetch(indexUrl, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      entries = Array.isArray(payload) ? payload : Array.isArray(payload?.extensions) ? payload.extensions : [];
    } catch (err) {
      if (!(err instanceof TypeError)) {
        // file:// 或没有插件目录都走这里，属于正常情况
        console.info('[XHGCS_CORE] 未发现外部插件目录', indexUrl);
      }
      return [];
    }
    const out: ExtensionRecord[] = [];
    for (const entry of entries) {
      try {
        const raw = await this.resolveEntry(entry, indexUrl);
        if (!raw) continue;
        const validation = validateManifest(raw);
        if (!validation.ok || !validation.manifest) {
          console.warn('[XHGCS_CORE] 清单校验失败', entry, validation.issues);
          continue;
        }
        out.push(this.add(validation.manifest, { source: indexUrl }));
      } catch (err) {
        console.warn('[XHGCS_CORE] 读取插件清单失败', entry, err);
      }
    }
    return out;
  }

  /**
   * 用户扩展目录（装机版）：由 Electron 主进程扫描并返回已改写好的清单，
   * 入口文件通过 /ext 路由提供。Web 模式下没有这个 API，直接跳过。
   */
  async discoverUserExtensions(): Promise<ExtensionRecord[]> {
    const desktop = (window as unknown as {
      XHGCS_DESKTOP?: { extensions?: { list?: () => Promise<{ items?: Array<{ manifest?: unknown; error?: string }> }> } };
    }).XHGCS_DESKTOP;
    const list = desktop && desktop.extensions && desktop.extensions.list;
    if (typeof list !== 'function') return [];
    let payload: { items?: Array<{ manifest?: unknown; error?: string }> } | null = null;
    try {
      payload = await list();
    } catch (err) {
      this.env.log('warn', '读取用户插件目录失败', err);
      return [];
    }
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const out: ExtensionRecord[] = [];
    for (const item of items) {
      if (!item) continue;
      if (item.error) {
        this.env.log('warn', `用户插件被拒绝：${item.error}`);
        continue;
      }
      const validation = validateManifest(item.manifest);
      if (!validation.ok || !validation.manifest) {
        this.env.log('warn', '用户插件清单校验失败', validation.issues);
        continue;
      }
      const manifest = validation.manifest;
      if (this.records.has(manifest.id)) {
        this.env.log('warn', `用户插件 id 与已加载扩展冲突，保留内置：${manifest.id}`);
        continue;
      }
      out.push(this.add(manifest, { source: 'user' }));
    }
    return out;
  }

  private async resolveEntry(entry: unknown, indexUrl: string): Promise<unknown> {
    if (!entry || typeof entry !== 'object') return entry;
    const record = entry as Record<string, unknown>;
    if (typeof record.manifest === 'string') {
      const base = new URL(indexUrl, location.href);
      const url = new URL(record.manifest, base).toString();
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      const manifest = await response.json();
      if (manifest && typeof manifest === 'object' && typeof (manifest as Record<string, unknown>).main === 'string') {
        const mainPath = String((manifest as Record<string, unknown>).main);
        if (mainPath !== 'inline') (manifest as Record<string, unknown>).main = new URL(mainPath, url).toString();
      }
      return manifest;
    }
    return entry;
  }

  private validateAgainstCore(manifest: ExtensionManifest): string[] {
    const issues: string[] = [];
    if (!satisfies(CORE_VERSION, manifest.engines?.xhgcs || '*')) {
      issues.push(`需要内核 ${manifest.engines?.xhgcs}，当前 ${CORE_VERSION}`);
    }
    if ((manifest.apiVersion || CORE_API_VERSION) !== CORE_API_VERSION) {
      issues.push(`清单 apiVersion ${manifest.apiVersion} 与内核 ${CORE_API_VERSION} 不符`);
    }
    for (const dep of manifest.dependencies || []) {
      const parsed = parseDependency(dep);
      if (!parsed.id) issues.push(`依赖写法不合法：${dep}`);
    }
    return issues;
  }

  /** 纯数据贡献：清单里声明的命令、视图、状态栏、配置、快捷键…… 一拍注册完。 */
  private registerContributions(record: ExtensionRecord): void {
    const { manifest } = record;
    const owner = manifest.id;
    const contributes = manifest.contributes || {};

    for (const command of contributes.commands || []) {
      record.disposables.push(registerCommandContribution(owner, command));
    }
    for (const binding of contributes.keybindings || []) {
      record.disposables.push(registerKeybinding(owner, binding));
    }
    for (const view of contributes.views || []) {
      record.disposables.push(this.registry.register('views', view.id, view, owner));
    }
    for (const item of contributes.statusBar || []) {
      record.disposables.push(this.registry.register('statusBar', item.id, item, owner));
    }
    for (const item of contributes.menus || []) {
      record.disposables.push(this.registry.register('menus', `${item.location}:${item.command}:${item.order ?? 100}`, item, owner));
    }
    for (const item of contributes.themes || []) {
      record.disposables.push(this.registry.register('themes', String(item.id), item, owner));
    }
    for (const item of contributes.protocols || []) {
      record.disposables.push(this.registry.register('protocols', String(item.id), item, owner));
    }
    for (const item of contributes.operators || []) {
      record.disposables.push(this.registry.register('operators', String(item.id), item, owner));
    }
    for (const item of contributes.dataSources || []) {
      record.disposables.push(this.registry.register('dataSources', String(item.id), item, owner));
    }
    for (const item of contributes.aiTools || []) {
      record.disposables.push(this.registry.register('aiTools', String(item.name), item, owner));
    }
    for (const item of contributes.designerWidgets || []) {
      record.disposables.push(this.registry.register('designerWidgets', String(item.id), item, owner));
    }
    if (contributes.configuration) {
      record.disposables.push(configuration.register(owner, contributes.configuration));
    }
  }

  /** 启动：安装快捷键监听，激活所有 onStartup / * 扩展。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.applyPersistedState();
    this.keybindingDisposer = installKeybindingListener(() => this.getContext());
    const pending = this.list().filter((record) => record.status !== 'disabled' && this.shouldActivateOnStartup(record.manifest));
    // 不要 await 整串：任何一个慢扩展都不该阻塞首屏
    await this.activateAll(pending, 'onStartup');
  }

  private shouldActivateOnStartup(manifest: ExtensionManifest): boolean {
    const events = manifest.activationEvents || ['onStartup'];
    return events.includes('*') || events.includes('onStartup') || events.includes('onStartupFinished');
  }

  /** 触发某个激活事件（onView / onCommand / onPanel …）。 */
  async fireEvent(event: string, arg = ''): Promise<void> {
    const targets: ExtensionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status === 'active' || record.status === 'activating' || record.status === 'disabled') continue;
      if (!record.manifest.activationEvents) continue;
      if (record.manifest.activationEvents.some((raw) => matchesEvent(raw, event, arg))) targets.push(record);
    }
    if (targets.length) console.info(`[XHGCS_CORE] ${event}${arg ? ':' + arg : ''} → ${targets.map((r) => r.manifest.id).join(', ')}`);
    await this.activateAll(targets, `${event}${arg ? ':' + arg : ''}`);
  }

  private async activateAll(targets: ExtensionRecord[], reason: string): Promise<void> {
    // 依赖优先：先激活被依赖者
    const ordered = this.sortByDependencies(targets);
    for (const record of ordered) {
      await this.activate(record.manifest.id, reason);
    }
  }

  private sortByDependencies(list: ExtensionRecord[]): ExtensionRecord[] {
    const byId = new Map(list.map((record) => [record.manifest.id, record]));
    const visited = new Set<string>();
    const out: ExtensionRecord[] = [];
    const visit = (record: ExtensionRecord, stack: Set<string>): void => {
      const id = record.manifest.id;
      if (visited.has(id)) return;
      if (stack.has(id)) {
        console.warn('[XHGCS_CORE] 扩展依赖成环', Array.from(stack).concat(id).join(' → '));
        return;
      }
      stack.add(id);
      for (const dep of record.manifest.dependencies || []) {
        const parsed = parseDependency(dep);
        const target = byId.get(parsed.id) || this.records.get(parsed.id);
        if (target) visit(target, stack);
      }
      stack.delete(id);
      visited.add(id);
      out.push(record);
    };
    list.forEach((record) => visit(record, new Set()));
    return out;
  }

  async activate(extId: string, reason = 'manual'): Promise<boolean> {
    const record = this.records.get(extId);
    if (!record) throw new Error(`未发现的扩展：${extId}`);
    if (record.status === 'active') return true;
    if (record.status === 'disabled') return false;

    // 用户扩展：声明的权限必须经过用户同意。没有授权就停在 pending，不加载代码。
    if (record.source === 'user' && (record.manifest.permissions || []).length && !isGranted(record.manifest)) {
      record.status = 'pending';
      record.message = '需要授权：' + (record.manifest.permissions || []).join(' / ');
      this.emit(record);
      return false;
    }

    // 依赖必须已经就绪，否则降级而不是崩
    for (const dep of record.manifest.dependencies || []) {
      const parsed = parseDependency(dep);
      const target = this.records.get(parsed.id);
      if (!target) {
        this.markDegraded(record, `缺少依赖扩展 ${parsed.id}`);
        return false;
      }
      if (!satisfies(target.manifest.version, parsed.range)) {
        this.markDegraded(record, `依赖 ${parsed.id} 需要 ${parsed.range}，实际 ${target.manifest.version}`);
        return false;
      }
      if (target.status !== 'active') {
        const ok = await this.activate(parsed.id, `dependency:${extId}`);
        if (!ok) {
          this.markDegraded(record, `依赖 ${parsed.id} 激活失败`);
          return false;
        }
      }
    }

    record.status = 'activating';
    this.emit(record);
    const store = new DisposableStore();
    try {
      const module = await this.loadModule(record);
      // exports 是过滤后的快照（不含 activate/deactivate）；生命周期钩子必须用真实模块引用
      record.module = module;
      record.exports = this.snapshotExports(module);
      const context = this.createContext(record, store);
      if (typeof module.activate === 'function') {
        await module.activate(context);
      }
      record.disposables.push(store);
      record.status = 'active';
      record.message = '';
      record.activatedAt = Date.now();
      record.activatedBy = reason;
      record.lastError = '';
      this.emit(record);
      return true;
    } catch (err) {
      record.status = 'failed';
      record.module = null;
      record.lastError = err instanceof Error ? err.message : String(err);
      record.message = `激活失败：${record.lastError}`;
      console.error(`[XHGCS_CORE] 扩展 ${extId} 激活失败`, err);
      store.dispose();
      this.emit(record);
      return false;
    }
  }

  private markDegraded(record: ExtensionRecord, message: string): void {
    record.status = 'degraded';
    record.message = message;
    this.emit(record);
  }

  private async loadModule(record: ExtensionRecord): Promise<ExtensionModule> {
    const { manifest } = record;
    if (!manifest.main || manifest.main === 'inline') {
      return this.compileInline(record);
    }
    await loadClassicScript(manifest.main);
    const bucket = (window as unknown as Record<string, unknown>).XHGCS_EXTENSIONS as
      | Record<string, ExtensionModule>
      | undefined;
    const module = bucket?.[manifest.id];
    if (!module) {
      throw new Error(`插件 ${manifest.id} 未注册 window.XHGCS_EXTENSIONS["${manifest.id}"]`);
    }
    return module;
  }

  /**
   * inline 形态：AI 现场生成的插件与存量视图插件共用这一条路。
   * 代码里写 `function activate(ctx){}` / `function deactivate(){}` 即可。
   */
  private compileInline(record: ExtensionRecord): ExtensionModule {
    const code = record.manifest.inlineScript || '';
    if (!code.trim()) throw new Error('inline 插件没有代码');
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      `'use strict';\n${code}\n;return {\n  activate: typeof activate === 'function' ? activate : undefined,\n  deactivate: typeof deactivate === 'function' ? deactivate : undefined\n};`
    );
    return factory() as ExtensionModule;
  }

  private snapshotExports(module: ExtensionModule): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(module)) {
      if (key === 'activate' || key === 'deactivate') continue;
      out[key] = value;
    }
    return out;
  }

  private createContext(record: ExtensionRecord, store: DisposableStore): Record<string, unknown> {
    const { manifest } = record;
    const granted = record.source === 'user' ? grantedPermissions(manifest) : manifest.permissions;
    const api = createExtensionApi(
      {
        host: this,
        registry: this.registry,
        configuration,
        commands: { execute: executeCommand },
        storage: createStorage(manifest.id),
        env: this.env,
        getContext: () => this.getContext(),
        activateOnEvent: (event, arg) => this.fireEvent(event, arg)
      },
      manifest,
      store,
      granted
    );
    return {
      extensionId: manifest.id,
      extensionPath: `plugins/${manifest.id}/`,
      api,
      subscriptions: store,
      storage: createStorage(manifest.id),
      log: (message: string, detail?: unknown) => this.env.log('info', `[${manifest.id}] ${message}`, detail),
      exports: record.exports || {},
      utils: {
        when: evaluateWhen
      }
    };
  }

  async deactivate(extId: string): Promise<void> {
    const record = this.records.get(extId);
    if (!record) return;
    const module = (record.module as ExtensionModule | null) || null;
    try {
      if (module && typeof module.deactivate === 'function') await module.deactivate();
    } catch (err) {
      console.warn(`[XHGCS_CORE] 扩展 ${extId} deactivate 抛错`, err);
    }
    const disposables = record.disposables.splice(0, record.disposables.length);
    for (let i = disposables.length - 1; i >= 0; i--) {
      try {
        disposables[i].dispose();
      } catch (err) {
        console.warn('[XHGCS_CORE] 释放扩展资源失败', err);
      }
    }
    this.registry.unregisterAll(extId);
    this.dropRuntime(extId);
    record.status = 'resolved';
    record.module = null;
    record.exports = null;
    record.activatedAt = 0;
    this.emit(record);
  }

  private dropRuntime(extId: string): void {
    for (const bucket of Object.values(this.runtime) as Array<Map<string, unknown>>) {
      for (const [key, value] of Array.from(bucket.entries())) {
        const owner = (value as { owner?: string } | undefined)?.owner;
        if (owner === extId) bucket.delete(key);
      }
    }
  }

  async reload(extId: string): Promise<boolean> {
    const record = this.records.get(extId);
    if (!record) return false;
    const wasActive = record.status === 'active';
    await this.deactivate(extId);
    // 文件型插件：删掉旧 script 标签与全局注册，下一次 activate 才会重新 fetch。
    // 只清引用不删脚本的话，loadClassicScript 看到同 URL 的 script 就直接 resolve（假重载）。
    const main = record.manifest.main;
    if (main && main !== 'inline') {
      const existing = document.querySelector('script[data-xhgcs-ext="' + main + '"]');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      const bucket = (window as unknown as Record<string, unknown>).XHGCS_EXTENSIONS as Record<string, unknown> | undefined;
      if (bucket) delete bucket[record.manifest.id];
    }
    // 重新注册贡献（deactivate 已把它们清掉）
    this.registerContributions(record);
    record.status = 'resolved';
    record.message = '';
    if (wasActive) return this.activate(extId, 'reload');
    this.emit(record);
    return true;
  }

  /** 禁用：卸载 + 记住禁用状态（由调用方持久化）。 */
  async disable(extId: string): Promise<void> {
    await this.deactivate(extId);
    this.registry.unregisterAll(extId);
    const record = this.records.get(extId);
    if (record) {
      record.status = 'disabled';
      record.message = '已停用（用户设置）';
      setDisabled(extId, true);
      this.emit(record);
    }
  }

  async enable(extId: string): Promise<boolean> {
    const record = this.records.get(extId);
    if (!record) return false;
    setDisabled(extId, false);
    // 用户扩展重新启用时，权限没变过就直接回到待激活；变过则要求重新授权
    record.status = record.source === 'user' && (record.manifest.permissions || []).length && !isGranted(record.manifest) ? 'pending' : 'resolved';
    record.message = record.status === 'pending' ? '权限已变化，需要重新授权' : '';
    this.registerContributions(record);
    this.emit(record);
    return true;
  }

  /** 启动时应用「用户上次停用了哪些插件」。 */
  applyPersistedState(): void {
    for (const record of this.records.values()) {
      if (!isDisabled(record.manifest.id)) continue;
      record.status = 'disabled';
      record.message = '已停用（用户设置）';
      this.emit(record);
    }
  }

  /** 授权页调用：勾选后写入授权并回到可激活状态。 */
  grantAccess(extId: string, permissions?: string[]): boolean {
    const record = this.records.get(extId);
    if (!record) return false;
    grantConsent(record.manifest, permissions || defaultGrant(record.manifest));
    record.status = 'resolved';
    record.message = '';
    this.emit(record);
    return true;
  }

  /** 撤销授权：已激活的先停掉，再回到待授权。 */
  async revokeAccess(extId: string): Promise<void> {
    const record = this.records.get(extId);
    revokeConsent(extId);
    if (record) {
      await this.deactivate(extId);
      record.status = 'pending';
      record.message = '授权已撤销';
      this.emit(record);
    }
  }

  dispose(): void {
    this.keybindingDisposer?.dispose();
    this.keybindingDisposer = null;
    for (const record of this.records.values()) {
      const disposables = record.disposables.splice(0, record.disposables.length);
      disposables.forEach((item) => {
        try {
          item.dispose();
        } catch {
          /* ignore */
        }
      });
    }
    this.records.clear();
    this.onChange.clear();
  }

  private emit(record: ExtensionRecord): void {
    this.onChange.emit({ extId: record.manifest.id, status: record.status, message: record.message });
  }
}

/** 激活事件匹配。`onView:*` 只匹配同一事件族，`*` 匹配一切。 */
export function matchesEvent(spec: string, event: string, arg: string): boolean {
  const text = String(spec || '').trim();
  if (!text) return false;
  if (text === '*') return true;
  if (text === event && !arg) return true;
  if (text === `${event}:*`) return true;
  if (arg && text === `${event}:${arg}`) return true;
  return false;
}

function createStorageDisposer(owner: string): Disposable {
  // 占位：存储本身不持有资源，真正的清理在扩展面板里显式调用 clearStorageOf
  return { dispose: () => void owner };
}

export type { ExtensionStorage };
