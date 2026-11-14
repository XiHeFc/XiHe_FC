/**
 * XiHe GCS PRO · 插件内核公共类型。
 *
 * 这一层只放“契约”，不放实现：扩展清单（manifest）、贡献点（contribution）、
 * 权限词表、以及内核暴露给扩展的 API 形状。任何新增贡献点都必须先在这里
 * 定义类型，避免又一次长成 window 上的面条。
 */

export type Disposable = { dispose(): void };

/** 贡献点名字。内置扩展与第三方扩展共用同一张表。 */
export type ContributionPoint =
  | 'commands'
  | 'menus'
  | 'keybindings'
  | 'views'
  | 'viewContainers'
  | 'statusBar'
  | 'configuration'
  | 'themes'
  | 'protocols'
  | 'operators'
  | 'dataSources'
  | 'designerWidgets'
  | 'aiTools';

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  /** 命令执行前的可用性条件，例如 `view == wave`。 */
  when?: string;
}

export interface MenuContribution {
  /** rail = 左侧活动栏；view/title = 视图标题栏；context = 右键菜单；statusbar = 状态栏 */
  location: 'rail' | 'view/title' | 'context' | 'statusbar';
  command: string;
  when?: string;
  group?: string;
  order?: number;
  label?: string;
  icon?: string;
}

export interface KeybindingContribution {
  key: string;
  command: string;
  when?: string;
  mac?: string;
}

export interface ViewContribution {
  id: string;
  name: string;
  icon?: string;
  container?: string;
  order?: number;
  when?: string;
  /** 视图渲染入口在插件代码里的导出名，默认与 id 同名。 */
  exportName?: string;
}

export interface StatusBarContribution {
  id: string;
  text: string;
  alignment?: 'left' | 'right';
  priority?: number;
  command?: string;
  tooltip?: string;
  /** 语义色：default | info | warn | error | ok */
  tone?: 'default' | 'info' | 'warn' | 'error' | 'ok';
  /** 显示条件，例如 `simulation == true` */
  when?: string;
}

export type ConfigurationType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object';

export interface ConfigurationProperty {
  type: ConfigurationType;
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

export interface ConfigurationContribution {
  title?: string;
  properties: Record<string, ConfigurationProperty>;
}

export interface ThemeContribution {
  id: string;
  label: string;
  tokens: Record<string, string>;
}

export interface ProtocolContribution {
  id: string;
  label: string;
  description?: string;
  /** 帧规格描述（给 UI 表单与 AI 提示词共用），具体编解码由插件注册。 */
  frameSpec?: Record<string, unknown>;
  exportName?: string;
}

export interface OperatorContribution {
  id: string;
  label: string;
  category?: string;
  inputs?: string[];
  outputs?: string[];
  parameters?: ConfigurationContribution['properties'];
  exportName?: string;
}

export interface DataSourceContribution {
  id: string;
  label: string;
  exportName?: string;
}

export interface DesignerWidgetContribution {
  id: string;
  label: string;
  icon?: string;
  group?: string;
  defaultSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
  /** 属性面板 100% 由它生成，缺省时该控件没有可编辑属性。 */
  propSchema?: Record<string, ConfigurationProperty>;
  defaults?: Record<string, unknown>;
  exportName?: string;
}

export interface AiToolContribution {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 工具实现导出名；也可由插件在 activate 时用 ctx.api.ai.registerTool 注册。 */
  exportName?: string;
}

/** 扩展清单。字段与 `xhgcs.extension.json` 一一对应。 */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  /** 内核 API 大版本，当前只接受 "1"。 */
  apiVersion?: string;
  engines?: { xhgcs?: string };
  /** 插件入口：相对路径的 .js 文件，或 "inline"（配合 inlineScript 使用）。 */
  main?: string;
  /** main === "inline" 时的代码文本（AI 现场生成、存量视图插件使用）。 */
  inlineScript?: string;
  activationEvents?: string[];
  dependencies?: string[];
  permissions?: string[];
  contributes?: Contributions;
}

export interface Contributions {
  commands?: CommandContribution[];
  menus?: MenuContribution[];
  keybindings?: KeybindingContribution[];
  views?: ViewContribution[];
  viewContainers?: Array<{ id: string; label: string }>;
  statusBar?: StatusBarContribution[];
  configuration?: ConfigurationContribution;
  themes?: ThemeContribution[];
  protocols?: ProtocolContribution[];
  operators?: OperatorContribution[];
  dataSources?: DataSourceContribution[];
  designerWidgets?: DesignerWidgetContribution[];
  aiTools?: AiToolContribution[];
}

export type ExtensionStatus =
  | 'discovered'
  | 'resolved'
  | 'pending'
  | 'activating'
  | 'active'
  | 'degraded'
  | 'failed'
  | 'disabled';

export interface ExtensionRecord {
  manifest: ExtensionManifest;
  status: ExtensionStatus;
  /** 可读的失败/降级原因，直接进扩展面板，不要只写 console。 */
  message: string;
  /** 来源：bundled = 随包/内置（默认信任）；user = 用户扩展目录（需要授权） */
  source: 'bundled' | 'user';
  activatedAt: number;
  activatedBy: string;
  lastError: string;
  disposables: Disposable[];
  /** 真实模块引用：deactivate 钩子只能从这里拿（exports 是过滤后的快照） */
  module: { activate?: (ctx: unknown) => unknown; deactivate?: () => unknown } | null;
  exports: Record<string, unknown> | null;
}

/** 内核初始化上下文：宿主的运行时环境，扩展拿到的 api 由它投影而来。 */
export interface HostEnvironment {
  now(): number;
  log(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void;
  toast(message: string): void;
}
