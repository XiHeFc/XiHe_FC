/**
 * 内核入口：把注册表、宿主、命令、状态栏、配置拼成一个可用的运行时。
 *
 * 设计约束（写在这里，防止后来者把内核又做成第二个 window.XHGCS_*）：
 *   - 内核不认识任何具体扩展，内置能力也走同一套贡献点；
 *   - 任何 UI 都必须在“没有扩展”时也能正常工作；
 *   - file:// 场景下允许插件发现失败，但主界面不能因此起不来。
 */
import { host, env } from './runtime';
import { registry } from './registry';
import { configuration } from './config';
import { executeCommand, listCommands, setCommandActivationHook } from './commands';
import { statusBar } from './statusbar';
import { buildWhenContext } from './api';
import { createStorage } from './storage';
import { evaluateWhen } from './when';
import { CORE_API_VERSION, CORE_VERSION, validateManifest } from './manifest';
import { satisfies, parseVersion } from './semver';
import { validateWhen } from './when';
import { engine, bindPipelineParamPersistence } from '../engine';
import { openPalette, openExtensions } from '../ui/shell';
import { openExtensionSettings } from '../ui/extension-settings';
import { openPipelinePanel } from '../ui/pipeline-panel';
import { openViewContainer } from '../ui/view-container';
import { installSettingsSection } from '../ui/settings-section';
import { openDesigner } from '../designer/designer';
import { openBoard } from '../designer/board';
import { composeBoard } from '../designer/board-spec';
import {
  BOARD_STORAGE_KEYS,
  activeBoard,
  activeBoardId,
  activeDoc,
  createBoard,
  deleteBoard,
  duplicateBoard,
  getBoard,
  importDoc,
  listBoards,
  previewPatch,
  renameBoard,
  replaceActive,
  resetBoardCache,
  revertLastPatch,
  applyPatchToActive,
  switchTo
} from '../designer/board-store';
import type { ExtensionManifest, StatusBarContribution } from './types';

function attachStatusBar(): void {
  const target = document.querySelector('.top-right');
  if (!target) return;
  const holder = document.createElement('div');
  holder.className = 'xhgcs-status-slot';
  holder.style.cssText = 'display:flex;align-items:center;gap:6px;max-width:46vw;overflow:hidden;';
  const clock = document.getElementById('clockText');
  if (clock && clock.parentElement === target) target.insertBefore(holder, clock);
  else target.appendChild(holder);
  statusBar.attach(holder);
}

/** 清单里声明的状态栏项要在“注册”时就上屏，否则插件没激活就永远看不到。 */
function syncStatusBarWithRegistry(): void {
  registry.onDidChange((change) => {
    if (change.point !== 'statusBar') return;
    if (change.kind === 'register') {
      const item = registry.get<StatusBarContribution>('statusBar', change.id);
      if (item) statusBar.add(change.owner, item);
    } else if (change.kind === 'unregister') {
      statusBar.remove(change.owner, change.id);
    }
  });
}

const CORE_MANIFEST = {
  id: 'xihe.core',
  name: '内核基础能力',
  version: CORE_VERSION,
  publisher: 'xihe',
  description: '命令面板、扩展管理面板等内核级入口，同时也是贡献点机制的示范。',
  apiVersion: CORE_API_VERSION,
  engines: { xhgcs: '>=0.10.0 <1.0.0' },
  main: 'inline',
  inlineScript: `
    function activate(ctx) {
      const api = ctx.api;
      api.commands.register('xhgcs.commandPalette', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openPalette();
      });
      api.commands.register('xhgcs.extensions', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openExtensions();
      });
      api.commands.register('xhgcs.about', function () {
        var total = window.XHGCS_CORE ? window.XHGCS_CORE.host.list().length : 0;
        api.toast('XiHe_GCS 内核 ' + api.version + ' · 已发现扩展 ' + total + ' 个');
      });
      api.commands.register('xhgcs.designer', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openDesigner();
      });
      api.commands.register('xhgcs.config', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openExtensionSettings();
      });
      api.commands.register('xhgcs.pipeline', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openPipeline();
      });
      api.commands.register('xhgcs.views', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openViews();
      });
      api.commands.register('xhgcs.board', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openBoard();
      });
    }
  `,
  activationEvents: ['onStartup'],
  dependencies: [],
  permissions: ['ui:toast', 'ui:statusBar', 'commands:execute'],
  contributes: {
    commands: [
      { id: 'xhgcs.commandPalette', title: '命令面板', category: '内核' },
      { id: 'xhgcs.extensions', title: '扩展管理', category: '内核' },
      { id: 'xhgcs.designer', title: '可视化设计器', category: '内核' },
      { id: 'xhgcs.board', title: '运行看板', category: '内核' },
      { id: 'xhgcs.config', title: '扩展配置', category: '内核' },
      { id: 'xhgcs.pipeline', title: '数据管线监视', category: '内核' },
      { id: 'xhgcs.views', title: '插件视图', category: '内核' },
      { id: 'xhgcs.about', title: '关于内核', category: '内核' }
    ],
    menus: [
      { location: 'rail', command: 'xhgcs.designer', icon: '⊞', label: '设计器', order: 55 },
      { location: 'rail', command: 'xhgcs.views', icon: '◫', label: '视图', order: 56 },
      { location: 'rail', command: 'xhgcs.board', icon: '⤢', label: '看板', order: 57 }
    ],
    keybindings: [
      { key: 'ctrl+shift+p', command: 'xhgcs.commandPalette' },
      { key: 'ctrl+shift+x', command: 'xhgcs.extensions' },
      { key: 'ctrl+shift+d', command: 'xhgcs.designer' },
      { key: 'ctrl+shift+b', command: 'xhgcs.board' },
      { key: 'ctrl+shift+v', command: 'xhgcs.views' },
      { key: 'ctrl+shift+,', command: 'xhgcs.config' },
      { key: 'ctrl+shift+e', command: 'xhgcs.pipeline' }
    ],
    statusBar: [
      {
        id: 'core.extensions',
        text: '扩展 0',
        alignment: 'right',
        priority: 60,
        command: 'xhgcs.extensions',
        tooltip: '打开扩展管理'
      },
      {
        id: 'core.pipeline',
        text: '管线 0',
        alignment: 'right',
        priority: 55,
        command: 'xhgcs.pipeline',
        tooltip: '数据管线：已处理帧 / 积压 / 丢弃'
      }
    ]
  }
} as unknown as ExtensionManifest;

/** 把老界面的交互翻译成激活事件：插件的 onView/onPanel 才有机会被触发。 */
function bridgeLegacyEvents(): void {
  const navMap: Record<string, string> = {
    visual: 'visual',
    wave: 'visual',
    analysis: 'analysis',
    engine: 'engine',
    serial: 'serial',
    alarm: 'alarm',
    sim: 'sim'
  };
  document.addEventListener(
    'click',
    (event) => {
      const target = (event.target as HTMLElement | null)?.closest?.('[data-nav], [data-settings-nav], [data-action="settings"]');
      if (!target) return;
      const nav = (target as HTMLElement).dataset.nav;
      const settingsNav = (target as HTMLElement).dataset.settingsNav;
      if (nav) {
        const panel = navMap[nav] || nav;
        host.fireEvent('onPanel', panel).catch((err) => env.log('warn', `激活 onPanel:${panel} 失败`, err));
      }
      if (settingsNav) {
        host.fireEvent('onConfig', `settings.${settingsNav}`).catch(() => undefined);
      }
      if ((target as HTMLElement).dataset.action === 'settings') {
        host.fireEvent('onPanel', 'settings').catch((err) => env.log('warn', '激活 onPanel:settings 失败', err));
      }
    },
    true
  );
}

function refreshExtensionBadge(): void {
  const count = host.list().length;
  statusBar.update('xihe.core', 'core.extensions', { text: `扩展 ${count}` });
}

/**
 * 活动栏菜单：贡献点 `menus`（location=rail）的唯一消费者。
 * 插件只要声明一行清单，就能在左侧栏出现自己的入口 —— 不用改 index.html。
 */
function renderRailMenus(): void {
  const nav = document.getElementById('sideNav');
  if (!nav) return;
  const anchor = nav.querySelector('.nav-gap');
  nav.querySelectorAll('[data-xhgcs-menu]').forEach((node) => node.remove());
  const items = registry
    .all<{ location: string; command: string; icon?: string; label?: string; order?: number; when?: string }>('menus')
    .filter((entry) => entry.value.location === 'rail')
    .filter((entry) => evaluateWhen(entry.value.when, buildWhenContext()))
    .sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100));

  for (const entry of items) {
    const command = entry.value.command;
    const contribution = registry.get<{ title?: string; icon?: string }>('commands', command);
    const button = document.createElement('button');
    button.className = 'tool';
    button.dataset.xhgcsMenu = command;
    button.title = entry.value.label || contribution?.title || command;
    const box = document.createElement('div');
    const icon = document.createElement('div');
    icon.className = 'ico';
    icon.textContent = entry.value.icon || contribution?.icon || '▣';
    const label = document.createElement('div');
    label.className = 'lbl';
    label.textContent = (entry.value.label || contribution?.title || command).slice(0, 3);
    box.append(icon, label);
    button.appendChild(box);
    button.addEventListener('click', () => {
      executeCommand(command).catch((err) => env.log('warn', `菜单命令 ${command} 失败`, err));
    });
    if (anchor && anchor.parentElement === nav) nav.insertBefore(button, anchor);
    else nav.appendChild(button);
  }
}

/**
 * 常驻数据引擎的启动。
 *
 * 默认链路是「直通 + 指标」，写回通道的端点注册但**默认关闭** ——
 * 双写通道会让用户看到两份数据，这是最容易踩的坑。
 */
function bootstrapPipeline(): void {
  const { pipeline } = engine;
  pipeline.registerOperator('xihe.core', engine.stages.passthrough());
  // 可调参数的阶段：默认关闭，用户在引擎面板里启用并调参
  for (const factory of [engine.stages.scale, engine.stages.lowpass, engine.stages.windowMean, engine.stages.threshold]) {
    const operator = factory();
    pipeline.registerOperator('xihe.core', operator);
    pipeline.setOperatorEnabled(operator.id, false);
  }
  // 套用上次存过的参数（必须在算子注册之后、启动之前）
  bindPipelineParamPersistence();
  pipeline.registerSink('xihe.core', engine.stages.metricsSink());
  const channels = engine.stages.channelSink();
  pipeline.registerSink('xihe.core', channels);
  pipeline.setSinkEnabled(channels.id, false);
  // 录制端点默认关闭：它占内存，用户要用时在引擎面板里打开
  const recorderSink = engine.recorder.sink();
  pipeline.registerSink('xihe.core', recorderSink);
  pipeline.setSinkEnabled(recorderSink.id, false);
  // 数据源：主数据链自动接上，回放源等待用户触发
  pipeline.registerSource('xihe.core', engine.sources.legacySample());
  pipeline.registerSource('xihe.core', engine.sources.replay());
  pipeline.startSource('builtin.legacy-sample');
  pipeline.start();

  let lastUpdate = 0;
  pipeline.onMetricsChange((metrics) => {
    const now = Date.now();
    if (now - lastUpdate < 900) return;
    lastUpdate = now;
    const text = metrics.dropped
      ? `管线 ${metrics.processed} · 丢 ${metrics.dropped}`
      : `管线 ${metrics.processed}`;
    statusBar.update('xihe.core', 'core.pipeline', {
      text,
      tone: metrics.dropped || metrics.errors ? 'warn' : 'default',
      tooltip: `队列 ${metrics.queued}/${metrics.capacity} · 平均 ${metrics.avgLatencyMs.toFixed(2)}ms · 错误 ${metrics.errors}`
    });
  });
}

export async function startup(): Promise<void> {
  try {
    attachStatusBar();
  } catch (err) {
    env.log('warn', '状态栏挂载失败', err);
  }
  syncStatusBarWithRegistry();
  registry.onDidChange(() => renderRailMenus());
  setCommandActivationHook((id) => host.fireEvent('onCommand', id));

  host.add(CORE_MANIFEST);
  renderRailMenus();
  bridgeLegacyEvents();
  try {
    installSettingsSection();
  } catch (err) {
    env.log('warn', '扩展设置分区挂载失败', err);
  }
  host.onDidChange(() => {
    refreshExtensionBadge();
    document.dispatchEvent(new CustomEvent('xhgcs:extensions-changed'));
  });
  refreshExtensionBadge();

  try {
    const found = await host.discover('plugins/index.json');
    if (found.length) env.log('info', `发现 ${found.length} 个外部扩展`);
  } catch (err) {
    env.log('warn', '扫描插件目录失败', err);
  }
  try {
    const userFound = await host.discoverUserExtensions();
    if (userFound.length) env.log('info', `发现 ${userFound.length} 个用户扩展`);
  } catch (err) {
    env.log('warn', '扫描用户扩展目录失败', err);
  }
  await host.start();
  refreshExtensionBadge();
  try {
    bootstrapPipeline();
  } catch (err) {
    env.log('error', '数据引擎启动失败', err);
  }
}

/** 内核公共门面。外部（老代码、AI、MCP）只准从这里进。 */
export const core = {
  version: CORE_VERSION,
  apiVersion: CORE_API_VERSION,
  host,
  registry,
  statusBar,
  config: configuration,
  storage: createStorage('core'),
  commands: {
    execute: executeCommand,
    list: listCommands
  },
  when: evaluateWhen,
  context: buildWhenContext,
  validate: validateManifest,
  engine,
  /** 看板库：AI / MCP / 外部脚本都从这一组入口读写看板，不要直接碰 localStorage */
  boards: {
    list: () => listBoards(),
    activeId: () => activeBoardId(),
    active: () => {
      const board = activeBoard();
      return {
        id: board.id,
        name: board.name,
        updatedAt: board.updatedAt,
        widgets: Array.isArray(board.doc.root.children) ? board.doc.root.children.length : 0
      };
    },
    get: (id: string) => getBoard(id),
    activeDoc: () => activeDoc(),
    create: (name?: string) => createBoard(name).id,
    duplicate: (id: string) => (duplicateBoard(id) ? activeBoardId() : ''),
    rename: (id: string, name: string) => renameBoard(id, name),
    remove: (id: string) => deleteBoard(id),
    switchTo: (id: string) => Boolean(switchTo(id)),
    importDoc: (text: string) => importDoc(text),
    /** 增量补丁：先校验后原子应用，失败不改文档；备份槽支持一次回退 */
    applyPatch: (patch: Parameters<typeof applyPatchToActive>[0]) => {
      const result = applyPatchToActive(patch);
      return {
        ok: result.ok,
        error: result.error,
        errors: result.errors,
        summary: result.summary,
        diff: result.diff,
        active: (() => {
          const board = activeBoard();
          return { id: board.id, name: board.name, widgets: Array.isArray(board.doc.root.children) ? board.doc.root.children.length : 0 };
        })()
      };
    },
    revertPatch: () => revertLastPatch(),
    /** 只校验不落库（MCP update_board 的 dry-run） */
    previewPatch: (patch: Parameters<typeof applyPatchToActive>[0]) => previewPatch(patch),
    resetCache: () => resetBoardCache(),
    storageKeys: BOARD_STORAGE_KEYS
  },
  /** 纯函数暴露给自动化测试与 AI 工具，避免为了测一个表达式去起浏览器 */
  internals: {
    semver: { satisfies, parseVersion },
    when: { evaluate: evaluateWhen, validate: validateWhen }
  },
  activate: (event: string, arg?: string) => host.fireEvent(event, arg),
  ui: {
    openPalette,
    openExtensions,
    openExtensionSettings,
    openPipeline: openPipelinePanel,
    openViews: openViewContainer,
    openBoard: () => {
      if (!openBoard()) env.toast('还没有看板文档：先在设计器里搭一个并保存');
    },
    /** AI/外部工具入口：把“意图规格”变成 UiDoc（不落库，先让用户看到预览） */
    composeBoard,
    /** 预览通过后真正落库并打开看板 */
    applyBoard: (spec: Parameters<typeof composeBoard>[0], options?: { open?: boolean }) => {
      const result = composeBoard(spec);
      if (!result.ok || !result.doc) return { ok: false, error: result.error || '生成失败', warnings: result.warnings };
      try {
        // 覆盖当前活动看板，而不是每次生成都新增一块 —— 用户说“做个看板”是替换，不是堆积
        replaceActive(result.doc);
      } catch (err) {
        return { ok: false, error: '写入本机失败：' + (err instanceof Error ? err.message : String(err)), warnings: result.warnings };
      }
      if (!options || options.open !== false) openBoard({ doc: activeDoc() });
      const count = result.doc.root.children ? result.doc.root.children.length : 0;
      return { ok: true, id: result.doc.id, name: result.doc.name, widgets: count, warnings: result.warnings };
    },
    openDesigner
  },
  startup
};

declare global {
  interface Window {
    XHGCS_CORE?: typeof core;
    XHGCS_EXTENSIONS?: Record<string, unknown>;
  }
}

if (typeof window !== 'undefined') {
  window.XHGCS_CORE = core;
  window.XHGCS_EXTENSIONS = window.XHGCS_EXTENSIONS || {};

  const boot = () => {
    startup().catch((err) => env.log('error', '内核启动失败', err));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

