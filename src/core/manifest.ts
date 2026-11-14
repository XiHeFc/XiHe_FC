/**
 * 扩展清单的解析与校验。
 *
 * 校验器是整套机制的门禁：清单写错要在“发现阶段”就给出可读原因，
 * 而不是等到用户点了菜单才在控制台里炸。返回的 issues 会原样进扩展面板。
 */
import { isValidRange, parseVersion, satisfies } from './semver';
import { validateWhen } from './when';
import type { Contributions, ExtensionManifest } from './types';

export interface ManifestIssue {
  /** 出错位置，例如 `contributes.views[0].id` */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export const CORE_API_VERSION = '1';
export const CORE_VERSION = '0.31.0';

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/i;

export const KNOWN_PERMISSIONS = [
  'data:read',
  'data:write',
  'ui:view',
  'ui:panel',
  'ui:statusBar',
  'ui:toast',
  'ui:menu',
  'config:read',
  'config:write',
  'storage:own',
  'commands:execute',
  'protocols:own',
  'operators:own',
  'datasources:own',
  'pipeline:own',
  'network',
  'fs:own'
] as const;

export type Permission = (typeof KNOWN_PERMISSIONS)[number];

export interface ActivationSpec {
  /** 事件名，例如 onView / onCommand / onStartup / * */
  event: string;
  /** 事件参数，例如视图 id */
  arg: string;
  raw: string;
}

const SIMPLE_EVENTS = new Set(['*', 'onStartup', 'onStartupFinished', 'onCommand:*', 'onView:*']);

export function parseActivationEvent(raw: string): ActivationSpec | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (SIMPLE_EVENTS.has(text)) return { event: text, arg: '', raw: text };
  const index = text.indexOf(':');
  if (index <= 0) return null;
  const event = text.slice(0, index);
  const arg = text.slice(index + 1).trim();
  if (!arg) return null;
  const allowed = [
    'onView',
    'onPanel',
    'onCommand',
    'onProtocol',
    'onOperator',
    'onDataSource',
    'onConfig',
    'onDesignerWidget',
    'onTheme'
  ];
  if (!allowed.includes(event)) return null;
  return { event, arg, raw: text };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function issue(issues: ManifestIssue[], path: string, message: string, severity: 'error' | 'warning' = 'error'): void {
  issues.push({ path, message, severity });
}

function requireString(
  issues: ManifestIssue[],
  holder: Record<string, unknown>,
  key: string,
  path: string,
  maxLength = 120
): string | null {
  const value = holder[key];
  if (typeof value !== 'string' || !value.trim()) {
    issue(issues, `${path}.${key}`, '必须是非空字符串');
    return null;
  }
  if (value.length > maxLength) issue(issues, `${path}.${key}`, `长度不能超过 ${maxLength}`);
  return value.trim();
}

function validateCommands(issues: ManifestIssue[], raw: unknown): Contributions['commands'] {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    issue(issues, 'contributes.commands', '必须是数组');
    return undefined;
  }
  const out: NonNullable<Contributions['commands']> = [];
  raw.forEach((item, index) => {
    const path = `contributes.commands[${index}]`;
    if (!isPlainObject(item)) {
      issue(issues, path, '必须是对象');
      return;
    }
    const id = requireString(issues, item, 'id', path, 80);
    const title = requireString(issues, item, 'title', path, 80);
    if (item.when != null) {
      const check = validateWhen(String(item.when));
      if (!check.ok) issue(issues, `${path}.when`, check.error);
    }
    if (id && title) {
      out.push({
        id,
        title,
        category: typeof item.category === 'string' ? item.category : undefined,
        icon: typeof item.icon === 'string' ? item.icon : undefined,
        when: typeof item.when === 'string' ? item.when : undefined
      });
    }
  });
  return out;
}

function validateViews(issues: ManifestIssue[], raw: unknown): Contributions['views'] {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    issue(issues, 'contributes.views', '必须是数组');
    return undefined;
  }
  const out: NonNullable<Contributions['views']> = [];
  raw.forEach((item, index) => {
    const path = `contributes.views[${index}]`;
    if (!isPlainObject(item)) {
      issue(issues, path, '必须是对象');
      return;
    }
    const id = requireString(issues, item, 'id', path, 64);
    const name = requireString(issues, item, 'name', path, 40);
    if (item.when != null) {
      const check = validateWhen(String(item.when));
      if (!check.ok) issue(issues, `${path}.when`, check.error);
    }
    if (id && name) {
      out.push({
        id,
        name,
        icon: typeof item.icon === 'string' ? item.icon.slice(0, 2) : undefined,
        container: typeof item.container === 'string' ? item.container : 'instrumentRail',
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : 100,
        when: typeof item.when === 'string' ? item.when : undefined,
        exportName: typeof item.exportName === 'string' ? item.exportName : undefined
      });
    }
  });
  return out;
}

function validateStatusBar(issues: ManifestIssue[], raw: unknown): Contributions['statusBar'] {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    issue(issues, 'contributes.statusBar', '必须是数组');
    return undefined;
  }
  const out: NonNullable<Contributions['statusBar']> = [];
  raw.forEach((item, index) => {
    const path = `contributes.statusBar[${index}]`;
    if (!isPlainObject(item)) {
      issue(issues, path, '必须是对象');
      return;
    }
    const id = requireString(issues, item, 'id', path, 64);
    if (!id) return;
    if (typeof item.text !== 'string' && typeof item.command !== 'string') {
      issue(issues, path, 'text 与 command 至少要有一个');
      return;
    }
    out.push({
      id,
      text: typeof item.text === 'string' ? item.text : '',
      alignment: item.alignment === 'left' ? 'left' : 'right',
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100,
      command: typeof item.command === 'string' ? item.command : undefined,
      tooltip: typeof item.tooltip === 'string' ? item.tooltip : undefined,
      tone: ['default', 'info', 'warn', 'error', 'ok'].includes(String(item.tone))
        ? (item.tone as 'default' | 'info' | 'warn' | 'error' | 'ok')
        : 'default'
    });
  });
  return out;
}

function validateConfiguration(issues: ManifestIssue[], raw: unknown): Contributions['configuration'] {
  if (raw == null) return undefined;
  if (!isPlainObject(raw)) {
    issue(issues, 'contributes.configuration', '必须是对象');
    return undefined;
  }
  const propertiesRaw = raw.properties;
  if (!isPlainObject(propertiesRaw)) {
    issue(issues, 'contributes.configuration.properties', '必须是对象');
    return undefined;
  }
  const properties: NonNullable<Contributions['configuration']>['properties'] = {};
  for (const [key, value] of Object.entries(propertiesRaw)) {
    const path = `contributes.configuration.properties.${key}`;
    if (!isPlainObject(value)) {
      issue(issues, path, '必须是对象');
      continue;
    }
    const type = String(value.type || '');
    if (!['string', 'number', 'integer', 'boolean', 'enum', 'array', 'object'].includes(type)) {
      issue(issues, `${path}.type`, 'type 必须是 string/number/integer/boolean/enum/array/object');
      continue;
    }
    if (type === 'enum' && !Array.isArray(value.enum)) {
      issue(issues, `${path}.enum`, 'enum 类型必须给出 enum 数组');
      continue;
    }
    if (!('default' in value)) {
      issue(issues, `${path}.default`, '必须给出 default，否则读配置的扩展会拿到 undefined');
      continue;
    }
    properties[key] = {
      type: type as never,
      default: value.default,
      description: typeof value.description === 'string' ? value.description : undefined,
      minimum: Number.isFinite(Number(value.minimum)) ? Number(value.minimum) : undefined,
      maximum: Number.isFinite(Number(value.maximum)) ? Number(value.maximum) : undefined,
      step: Number.isFinite(Number(value.step)) ? Number(value.step) : undefined,
      enum: Array.isArray(value.enum) ? (value.enum as Array<string | number>) : undefined,
      enumLabels: Array.isArray(value.enumLabels) ? value.enumLabels.map(String) : undefined,
      group: typeof value.group === 'string' ? value.group : undefined,
      order: Number.isFinite(Number(value.order)) ? Number(value.order) : undefined
    };
  }
  return { title: typeof raw.title === 'string' ? raw.title : undefined, properties };
}

function validateKeybindings(issues: ManifestIssue[], raw: unknown): Contributions['keybindings'] {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    issue(issues, 'contributes.keybindings', '必须是数组');
    return undefined;
  }
  const out: NonNullable<Contributions['keybindings']> = [];
  raw.forEach((item, index) => {
    const path = `contributes.keybindings[${index}]`;
    if (!isPlainObject(item)) {
      issue(issues, path, '必须是对象');
      return;
    }
    const key = requireString(issues, item, 'key', path, 40);
    const command = requireString(issues, item, 'command', path, 80);
    if (item.when != null) {
      const check = validateWhen(String(item.when));
      if (!check.ok) issue(issues, `${path}.when`, check.error);
    }
    if (key && command) {
      out.push({
        key,
        command,
        when: typeof item.when === 'string' ? item.when : undefined,
        mac: typeof item.mac === 'string' ? item.mac : undefined
      });
    }
  });
  return out;
}

function validateMenus(issues: ManifestIssue[], raw: unknown): Contributions['menus'] {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    issue(issues, 'contributes.menus', '必须是数组');
    return undefined;
  }
  const allowed = ['rail', 'view/title', 'context', 'statusbar'];
  const out: NonNullable<Contributions['menus']> = [];
  raw.forEach((item, index) => {
    const path = `contributes.menus[${index}]`;
    if (!isPlainObject(item)) {
      issue(issues, path, '必须是对象');
      return;
    }
    const command = requireString(issues, item, 'command', path, 80);
    const location = String(item.location || '');
    if (!allowed.includes(location)) {
      issue(issues, `${path}.location`, `location 必须是 ${allowed.join(' / ')}`);
    }
    if (item.when != null) {
      const check = validateWhen(String(item.when));
      if (!check.ok) issue(issues, `${path}.when`, check.error);
    }
    if (command && allowed.includes(location)) {
      out.push({
        location: location as 'rail' | 'view/title' | 'context' | 'statusbar',
        command,
        when: typeof item.when === 'string' ? item.when : undefined,
        group: typeof item.group === 'string' ? item.group : undefined,
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : 100,
        label: typeof item.label === 'string' ? item.label : undefined,
        icon: typeof item.icon === 'string' ? item.icon : undefined
      });
    }
  });
  return out;
}

function validateDesignerWidgets(issues: ManifestIssue[], raw: unknown): Contributions['designerWidgets'] {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    issue(issues, 'contributes.designerWidgets', '必须是数组');
    return undefined;
  }
  const out: NonNullable<Contributions['designerWidgets']> = [];
  raw.forEach((item, index) => {
    const path = `contributes.designerWidgets[${index}]`;
    if (!isPlainObject(item)) {
      issue(issues, path, '必须是对象');
      return;
    }
    const id = requireString(issues, item, 'id', path, 64);
    const label = requireString(issues, item, 'label', path, 40);
    if (!id || !label) return;
    const schema = isPlainObject(item.propSchema)
      ? (item.propSchema as NonNullable<Contributions['designerWidgets']>[number]['propSchema'])
      : undefined;
    out.push({
      id,
      label,
      icon: typeof item.icon === 'string' ? item.icon.slice(0, 2) : undefined,
      group: typeof item.group === 'string' ? item.group : '通用',
      defaultSize: isPlainObject(item.defaultSize)
        ? { w: Number((item.defaultSize as Record<string, unknown>).w) || 4, h: Number((item.defaultSize as Record<string, unknown>).h) || 3 }
        : undefined,
      minSize: isPlainObject(item.minSize)
        ? { w: Number((item.minSize as Record<string, unknown>).w) || 2, h: Number((item.minSize as Record<string, unknown>).h) || 1 }
        : undefined,
      propSchema: schema,
      defaults: isPlainObject(item.defaults) ? (item.defaults as Record<string, unknown>) : undefined,
      exportName: typeof item.exportName === 'string' ? item.exportName : undefined
    });
  });
  return out;
}

function validateGenericList(
  issues: ManifestIssue[],
  raw: unknown,
  point: string,
  required: string[]
): unknown[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    issue(issues, `contributes.${point}`, '必须是数组');
    return undefined;
  }
  const out: unknown[] = [];
  raw.forEach((item, index) => {
    const path = `contributes.${point}[${index}]`;
    if (!isPlainObject(item)) {
      issue(issues, path, '必须是对象');
      return;
    }
    let ok = true;
    for (const key of required) {
      if (typeof item[key] !== 'string' || !String(item[key]).trim()) {
        issue(issues, `${path}.${key}`, '必须是非空字符串');
        ok = false;
      }
    }
    if (ok) out.push(item);
  });
  return out;
}

function isCrossOrigin(entry: string): boolean {
  // 插件必须由本应用的静态服务提供；跨源入口一律拒绝。
  // file:// 下 location.origin 固定是 "null"，此时不做跨源判断（本地文件互相信任）。
  if (typeof location === 'undefined') return false;
  try {
    const resolved = new URL(entry, location.href);
    return resolved.origin !== location.origin && location.origin !== 'null';
  } catch {
    return true;
  }
}

export interface ManifestValidation {
  ok: boolean;
  manifest: ExtensionManifest | null;
  issues: ManifestIssue[];
}

export function validateManifest(raw: unknown): ManifestValidation {
  const issues: ManifestIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, manifest: null, issues: [{ path: '$', message: '清单必须是 JSON 对象', severity: 'error' }] };
  }

  const id = requireString(issues, raw, 'id', '$', 64);
  if (id && !ID_RE.test(id)) issue(issues, '$.id', 'id 只能包含字母、数字、点、下划线、短横线，长度 3-64');

  const name = requireString(issues, raw, 'name', '$', 40);
  const version = requireString(issues, raw, 'version', '$', 32);
  if (version && !parseVersion(version)) issue(issues, '$.version', 'version 必须是 x.y.z 形式');

  const apiVersion = raw.apiVersion == null ? CORE_API_VERSION : String(raw.apiVersion);
  if (apiVersion !== CORE_API_VERSION) {
    issue(issues, '$.apiVersion', `当前内核只支持 apiVersion ${CORE_API_VERSION}，清单声明的是 ${apiVersion}`);
  }

  let engineRange = '>=0.10.0 <1.0.0';
  if (raw.engines != null) {
    if (!isPlainObject(raw.engines)) issue(issues, '$.engines', '必须是对象');
    else if (raw.engines.xhgcs != null) engineRange = String(raw.engines.xhgcs);
  }
  if (!isValidRange(engineRange)) {
    // satisfies() 对认不出的比较符会默认放行，非法区间必须在这里拦住
    issue(issues, '$.engines.xhgcs', `不是合法的版本区间：${engineRange}`);
  } else if (!satisfies(CORE_VERSION, engineRange)) {
    issue(issues, '$.engines.xhgcs', `内核版本 ${CORE_VERSION} 不满足声明范围 ${engineRange}`, 'warning');
  }

  let main = 'inline';
  if (raw.main != null) {
    if (typeof raw.main !== 'string' || !raw.main.trim()) issue(issues, '$.main', '必须是字符串');
    else {
      main = raw.main.trim();
      if (main !== 'inline' && !/\.js$/i.test(main)) issue(issues, '$.main', '入口文件必须是 .js');
      if (main !== 'inline' && /(^|[/\\])\.\.([/\\]|$)/.test(main)) issue(issues, '$.main', '入口不允许使用上级目录 ..');
      if (main !== 'inline' && isCrossOrigin(main)) issue(issues, '$.main', '入口不允许使用跨源地址');
    }
  }
  const inlineScript = typeof raw.inlineScript === 'string' ? raw.inlineScript : undefined;
  if (main === 'inline' && !inlineScript) {
    issue(issues, '$.inlineScript', 'main 为 inline 时必须给出 inlineScript');
  }

  const activationEvents: string[] = [];
  if (raw.activationEvents != null) {
    if (!Array.isArray(raw.activationEvents)) issue(issues, '$.activationEvents', '必须是数组');
    else {
      asArray(raw.activationEvents).forEach((event, index) => {
        const spec = parseActivationEvent(String(event));
        if (!spec) issue(issues, `$.activationEvents[${index}]`, `无法识别的激活事件 "${String(event)}"`);
        else activationEvents.push(spec.raw);
      });
    }
  }
  if (!activationEvents.length) activationEvents.push('onStartup');

  const dependencies: string[] = [];
  if (raw.dependencies != null) {
    if (!Array.isArray(raw.dependencies)) issue(issues, '$.dependencies', '必须是数组');
    else {
      asArray(raw.dependencies).forEach((dep, index) => {
        if (typeof dep !== 'string' || !dep.trim()) issue(issues, `$.dependencies[${index}]`, '必须是字符串');
        else dependencies.push(dep.trim());
      });
    }
  }

  const permissions: string[] = [];
  if (raw.permissions != null) {
    if (!Array.isArray(raw.permissions)) issue(issues, '$.permissions', '必须是数组');
    else {
      asArray(raw.permissions).forEach((permission, index) => {
        const text = String(permission);
        if (!(KNOWN_PERMISSIONS as readonly string[]).includes(text)) {
          issue(issues, `$.permissions[${index}]`, `未知权限 "${text}"`);
          return;
        }
        permissions.push(text);
      });
    }
  }

  const contributesRaw = isPlainObject(raw.contributes) ? raw.contributes : {};
  if (raw.contributes != null && !isPlainObject(raw.contributes)) {
    issue(issues, '$.contributes', '必须是对象');
  }
  const contributes: Contributions = {
    commands: validateCommands(issues, contributesRaw.commands),
    menus: validateMenus(issues, contributesRaw.menus),
    keybindings: validateKeybindings(issues, contributesRaw.keybindings),
    views: validateViews(issues, contributesRaw.views),
    statusBar: validateStatusBar(issues, contributesRaw.statusBar),
    configuration: validateConfiguration(issues, contributesRaw.configuration),
    designerWidgets: validateDesignerWidgets(issues, contributesRaw.designerWidgets),
    themes: (validateGenericList(issues, contributesRaw.themes, 'themes', ['id', 'label']) as Contributions['themes']) ?? undefined,
    protocols: (validateGenericList(issues, contributesRaw.protocols, 'protocols', ['id', 'label']) as Contributions['protocols']) ?? undefined,
    operators: (validateGenericList(issues, contributesRaw.operators, 'operators', ['id', 'label']) as Contributions['operators']) ?? undefined,
    dataSources: (validateGenericList(issues, contributesRaw.dataSources, 'dataSources', ['id', 'label']) as Contributions['dataSources']) ?? undefined,
    aiTools: (validateGenericList(issues, contributesRaw.aiTools, 'aiTools', ['name', 'description']) as Contributions['aiTools']) ?? undefined
  };

  const errors = issues.filter((item) => item.severity === 'error');
  if (errors.length) return { ok: false, manifest: null, issues };

  const manifest: ExtensionManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    publisher: typeof raw.publisher === 'string' ? raw.publisher : 'local',
    description: typeof raw.description === 'string' ? raw.description : '',
    apiVersion,
    engines: { xhgcs: engineRange },
    main,
    inlineScript,
    activationEvents,
    dependencies,
    permissions,
    contributes
  };
  return { ok: true, manifest, issues };
}

/** 把依赖字符串拆成 `{id, range}`，`foo@^1.2.0` 或裸 `foo`。 */
export function parseDependency(text: string): { id: string; range: string } {
  const raw = String(text || '').trim();
  const at = raw.indexOf('@', 1);
  if (at < 0) return { id: raw, range: '*' };
  return { id: raw.slice(0, at), range: raw.slice(at + 1) || '*' };
}

