/**
 * XiHe_GCS 插件作者类型声明（手写，与 src/ 的实现保持同步）。
 *
 * 用法：把本文件复制到你的插件工程，或在编辑器里通过 tsconfig 的 "types"/"files" 引入，
 * 在 main.js 里写 `/** @type {XhgcsExtension} *\/` 即可获得补全与校验。
 */

export interface XhgcsDisposable {
  dispose(): void;
}

export interface XhgcsChannel {
  id: string;
  name: string;
  unit: string;
  color: string;
}

export interface XhgcsCommandContribution {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  when?: string;
}

export interface XhgcsViewContribution {
  id: string;
  name: string;
  icon?: string;
  container?: string;
  order?: number;
  when?: string;
}

export interface XhgcsStatusBarContribution {
  id: string;
  text: string;
  alignment?: 'left' | 'right';
  priority?: number;
  command?: string;
  tooltip?: string;
  tone?: 'default' | 'info' | 'warn' | 'error' | 'ok';
  when?: string;
}

export interface XhgcsConfigurationProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object';
  default: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  enum?: Array<string | number>;
  enumLabels?: string[];
  group?: string;
  order?: number;
}

export interface XhgcsManifest {
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  apiVersion?: '1';
  engines?: { xhgcs?: string };
  main?: string;
  inlineScript?: string;
  activationEvents?: string[];
  dependencies?: string[];
  permissions?: string[];
  contributes?: {
    commands?: XhgcsCommandContribution[];
    menus?: Array<{ location: 'rail' | 'view/title' | 'context' | 'statusbar'; command: string; when?: string; group?: string; order?: number; label?: string; icon?: string }>;
    keybindings?: Array<{ key: string; command: string; when?: string; mac?: string }>;
    views?: XhgcsViewContribution[];
    statusBar?: XhgcsStatusBarContribution[];
    configuration?: { title?: string; properties: Record<string, XhgcsConfigurationProperty> };
    themes?: Array<{ id: string; label: string; tokens: Record<string, string> }>;
    protocols?: Array<{ id: string; label: string; description?: string }>;
    operators?: Array<{ id: string; label: string; category?: string }>;
    dataSources?: Array<{ id: string; label: string }>;
    designerWidgets?: Array<{ id: string; label: string; icon?: string; group?: string }>;
    aiTools?: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>;
  };
}

/** 视图实现契约：四个钩子都可选。 */
export interface XhgcsViewImplementation {
  mount?(ctx: XhgcsViewContext): void;
  update?(ctx: XhgcsViewContext): void;
  resize?(ctx: XhgcsViewContext): void;
  unmount?(ctx: XhgcsViewContext): void;
}

export interface XhgcsViewContext {
  id: string;
  host: HTMLElement;
  readonly width: number;
  readonly height: number;
  theme(): { fg: string; dim: string; line: string; acc: string; warn: string; ok: string; danger: string; bg: string };
  channels(): XhgcsChannel[];
  latest(channelId: string): number;
  series(channelId: string, limit?: number): number[];
  canvas(): { ctx: CanvasRenderingContext2D; width: number; height: number; dpr: number } | null;
  toast(message: string): void;
  esc(text: string): string;
  onSample(listener: () => void): () => void;
  onResize(listener: () => void): () => void;
  requestRender(): void;
}

export interface XhgcsConfigApi {
  get<T = unknown>(key: string): T;
  all(): Record<string, unknown>;
  has(key: string): boolean;
  update?(key: string, value: unknown): void;
  onDidChange(listener: (key: string, value: unknown, previous: unknown) => void): XhgcsDisposable;
}

export interface XhgcsExtensionApi {
  version: string;
  extension: { id: string; version: string; path: string };
  env: { platform: string; core: string };
  log(message: string, detail?: unknown): void;
  when(expression: string | undefined, context?: Record<string, unknown>): boolean;
  commands: {
    register(id: string, handler: (...args: unknown[]) => unknown): XhgcsDisposable;
    execute?(id: string, ...args: unknown[]): Promise<unknown>;
  };
  statusBar?: {
    add(item: XhgcsStatusBarContribution): XhgcsDisposable;
    update(id: string, patch: Partial<XhgcsStatusBarContribution>): void;
    remove(id: string): void;
  };
  views?: {
    register(id: string, implementation: XhgcsViewImplementation): XhgcsDisposable;
    get<T = unknown>(id: string): T | undefined;
  };
  widgets?: { register(id: string, implementation: unknown): void };
  data?: {
    channels(): XhgcsChannel[];
    latest(id: string): number | undefined;
    series(id: string, limit?: number): number[];
    scriptChannels(): string[];
  };
  dataWrite?: { push(channelId: string, value: number): boolean };
  config?: XhgcsConfigApi;
  storage?: { get<T>(key: string, fallback?: T): T; set(key: string, value: unknown): void; remove(key: string): void };
  toast?(message: string): void;
  ai?: { registerTool(tool: { name: string; description: string; parameters?: Record<string, unknown>; run: (...args: unknown[]) => unknown }): XhgcsDisposable };
  protocols?: { register(adapter: unknown): XhgcsDisposable };
  operators?: { register(impl: unknown): XhgcsDisposable };
  pipeline?: {
    registerOperator(operator: { id: string; label: string; order?: number; process(frame: XhgcsFrame): XhgcsFrame | null }): XhgcsDisposable;
    registerSink(sink: { id: string; label: string; write(frame: XhgcsFrame): void }): XhgcsDisposable;
    metrics(): unknown;
  };
  activation: { fire(event: string, arg?: string): Promise<void> };
}

export interface XhgcsFrame {
  t: number;
  wall: number;
  source: string;
  values: Record<string, number>;
  filled?: string[];
}

export interface XhgcsExtensionContext {
  extensionId: string;
  extensionPath: string;
  api: XhgcsExtensionApi;
  subscriptions: { add<T extends XhgcsDisposable>(item: T): T };
  storage: { get<T>(key: string, fallback?: T): T; set(key: string, value: unknown): void };
  log(message: string, detail?: unknown): void;
  exports: Record<string, unknown>;
}

export interface XhgcsExtension {
  activate(context: XhgcsExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

declare global {
  interface Window {
    XHGCS_EXTENSIONS?: Record<string, XhgcsExtension>;
    XHGCS_CORE?: {
      version: string;
      host: { list(): Array<{ manifest: XhgcsManifest; status: string; message: string }>; reload(id: string): Promise<boolean> };
      commands: { execute(id: string, ...args: unknown[]): Promise<unknown>; list(): Array<{ id: string; title: string; category: string }> };
      config: { get(owner: string, key: string): unknown; update(owner: string, key: string, value: unknown): void };
      ui: {
        openPalette(): void;
        openExtensions(): void;
        openExtensionSettings(): void;
        openPipeline(): void;
        openViews(id?: string): void;
        openDesigner(): void;
        openBoard(): void;
      };
    };
  }
}
