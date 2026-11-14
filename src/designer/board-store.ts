/**
 * 看板库：把「一块看板」升级成「多块看板」。
 *
 * 存储只有一处写入口，所有调用方（设计器保存、AI 生成、看板运行）都必须走这里 ——
 * 否则会出现「设计器存的是 A，看板读的是 B」这种最难查的问题。
 *
 * 兼容策略（0.15 → 0.16）：
 *   1. 旧 key `xhgcs.ui.doc.v1` 只读迁移，迁移后**原样保留**并另存一份 `.bak`；
 *   2. 迁移是一次性的：一旦 v2 存在，不再碰 v1；
 *   3. 导出格式仍是单板 `xhgcs.ui` 文档，导入会把 JSON 变成库里的新板。
 */
import { createDoc, normalizeDoc, parseDoc, serializeDoc, type UiDoc } from './ui-doc';
import { applyPatch, describePatch, validatePatch, type BoardPatch, type PatchDiff } from './board-patch';

export interface BoardRecord {
  id: string;
  name: string;
  updatedAt: number;
  doc: UiDoc;
}

export interface BoardState {
  version: 2;
  activeId: string;
  boards: BoardRecord[];
}

export interface BoardSummary {
  id: string;
  name: string;
  updatedAt: number;
  active: boolean;
}

const STORE_KEY = 'xhgcs.ui.boards.v2';
const LEGACY_KEY = 'xhgcs.ui.doc.v1';
const BACKUP_KEY = 'xhgcs.ui.doc.v1.bak';
const MAX_BOARDS = 50;

let cached: BoardState | null = null;

function readJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[XHGCS_BOARDS] 写入失败', key, err);
    // 写失败不能只写 console：调用方与用户都要知道「这次没存进去」
    try {
      window.dispatchEvent(new CustomEvent('xhgcs:persist-failed', { detail: { key: key, error: err instanceof Error ? err.message : String(err) } }));
    } catch (notifyError) {
      /* 非浏览器环境忽略 */
    }
    return false;
  }
}

function makeRecord(doc: UiDoc): BoardRecord {
  return { id: doc.id, name: doc.name, updatedAt: doc.updatedAt || Date.now(), doc };
}

function newBoardId(): string {
  return `ui.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function migrateLegacy(): BoardRecord | null {
  const raw = readJSON(LEGACY_KEY);
  if (raw == null) return null;
  const doc = normalizeDoc(raw);
  if (!doc) return null;
  // 迁移前留一份原样备份：迁移逻辑以后要是改坏了，用户还能手工找回
  try {
    if (localStorage.getItem(BACKUP_KEY) == null) {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(raw));
    }
  } catch (err) {
    console.warn('[XHGCS_BOARDS] 备份旧存档失败', err);
  }
  return makeRecord(doc);
}

function normalizeState(raw: unknown): BoardState | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (source.version !== 2 || !Array.isArray(source.boards)) return null;
  const boards: BoardRecord[] = [];
  for (const item of source.boards) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const doc = normalizeDoc(record.doc);
    if (!doc) continue;
    const id = String(record.id || doc.id);
    const name = String(record.name || doc.name || '看板').slice(0, 40);
    doc.id = id;
    doc.name = name;
    boards.push({ id, name, updatedAt: Number(record.updatedAt) || doc.updatedAt || Date.now(), doc });
    if (boards.length >= MAX_BOARDS) break;
  }
  if (!boards.length) return null;
  const activeId = String(source.activeId || '');
  return {
    version: 2,
    activeId: boards.some((board) => board.id === activeId) ? activeId : boards[0].id,
    boards
  };
}

function load(): BoardState {
  if (cached) return cached;
  const rawStored = localStorage.getItem(STORE_KEY);
  const stored = normalizeState(readJSON(STORE_KEY));
  if (stored) {
    cached = stored;
    return stored;
  }
  // 有旧内容却解析失败：先原样备份再重建，避免把用户数据直接覆盖掉
  if (rawStored) {
    try {
      localStorage.setItem(STORE_KEY + '.bak', rawStored);
    } catch (err) {
      console.warn('[XHGCS_BOARDS] 损坏存档备份失败', err);
    }
  }
  const migrated = migrateLegacy();
  const doc = migrated ? migrated.doc : createDoc('主看板');
  cached = { version: 2, activeId: migrated ? migrated.id : doc.id, boards: [migrated || makeRecord(doc)] };
  persist(cached);
  return cached;
}

function persist(state: BoardState): boolean {
  cached = state;
  return writeJSON(STORE_KEY, {
    version: 2,
    activeId: state.activeId,
    boards: state.boards.map((board) => ({
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
      doc: JSON.parse(serializeDoc(board.doc))
    }))
  });
}

export function listBoards(): BoardSummary[] {
  const state = load();
  return state.boards.map((board) => ({
    id: board.id,
    name: board.name,
    updatedAt: board.updatedAt,
    active: board.id === state.activeId
  }));
}

export function activeBoardId(): string {
  return load().activeId;
}

export function activeDoc(): UiDoc {
  return activeBoard().doc;
}

export function activeBoard(): BoardRecord {
  const state = load();
  return state.boards.find((board) => board.id === state.activeId) || state.boards[0];
}

export function getBoard(id: string): UiDoc | null {
  const board = load().boards.find((item) => item.id === id);
  return board ? board.doc : null;
}

/** 保存当前活动看板（设计器「保存」、AI 生成、自动化测试都走这里）。 */
export function saveDoc(doc: UiDoc): boolean {
  const state = load();
  const board = state.boards.find((item) => item.id === state.activeId) || state.boards[0];
  board.doc = doc;
  board.name = doc.name || board.name;
  board.updatedAt = Date.now();
  doc.updatedAt = board.updatedAt;
  return persist(state);
}

/** 用一份文档覆盖当前看板（AI 生成看板时用：不新增板，避免每次生成都多一块）。 */
export function replaceActive(doc: UiDoc): BoardRecord {
  saveDoc(doc);
  return activeBoard();
}

export function switchTo(id: string): UiDoc | null {
  const state = load();
  const board = state.boards.find((item) => item.id === id);
  if (!board) return null;
  state.activeId = id;
  persist(state);
  return board.doc;
}

export function createBoard(name = '新建看板'): UiDoc {
  const state = load();
  if (state.boards.length >= MAX_BOARDS) {
    throw new Error(`看板数量已达上限 ${MAX_BOARDS} 块，请先删掉不用的`);
  }
  const doc = createDoc(String(name || '新建看板').slice(0, 40));
  state.boards.push(makeRecord(doc));
  state.activeId = doc.id;
  persist(state);
  return doc;
}

export function duplicateBoard(id: string): UiDoc | null {
  const state = load();
  const source = state.boards.find((item) => item.id === id);
  if (!source) return null;
  if (state.boards.length >= MAX_BOARDS) throw new Error(`看板数量已达上限 ${MAX_BOARDS} 块`);
  const copy = normalizeDoc(JSON.parse(JSON.stringify(source.doc))) || createDoc(source.name + ' 副本');
  copy.id = newBoardId();
  copy.name = (source.name + ' 副本').slice(0, 40);
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  state.boards.push(makeRecord(copy));
  state.activeId = copy.id;
  persist(state);
  return copy;
}

export function renameBoard(id: string, name: string): void {
  const state = load();
  const board = state.boards.find((item) => item.id === id);
  if (!board) return;
  const next = String(name || '').trim().slice(0, 40);
  if (!next) return;
  board.name = next;
  board.doc.name = next;
  board.updatedAt = Date.now();
  persist(state);
}

/** 删除看板；只剩一块时拒绝（空库会让“打开看板”变成无解状态）。 */
export function deleteBoard(id: string): { ok: boolean; error?: string } {
  const state = load();
  if (state.boards.length <= 1) return { ok: false, error: '至少要保留一块看板' };
  const index = state.boards.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, error: '看板不存在' };
  state.boards.splice(index, 1);
  if (state.activeId === id) state.activeId = state.boards[0].id;
  persist(state);
  return { ok: true };
}

/** 导入一份单板 JSON：新建一块板并切过去。 */
export function importDoc(text: string): { ok: boolean; error?: string; doc?: UiDoc } {
  const doc = parseDoc(text);
  if (!doc) return { ok: false, error: '不是合法的 XHGCS UI 文档' };
  const state = load();
  if (state.boards.length >= MAX_BOARDS) return { ok: false, error: `看板数量已达上限 ${MAX_BOARDS} 块` };
  doc.id = newBoardId();
  doc.updatedAt = Date.now();
  state.boards.push(makeRecord(doc));
  state.activeId = doc.id;
  persist(state);
  return { ok: true, doc };
}

/** 给测试/诊断用：把缓存清掉，强制下次重新读盘。 */
export function resetBoardCache(): void {
  cached = null;
}

const PATCH_BACKUP_KEY = 'xhgcs.ui.patch.backup.v1';

export interface PatchApplyOutcome {
  ok: boolean;
  error?: string;
  errors?: string[];
  diff?: PatchDiff;
  summary?: string;
  doc?: UiDoc;
}

/**
 * 对当前活动看板应用补丁。
 * 补丁前把整份文档备份到单槽 key —— AI/MCP 改坏了，一次 revert 就能回到改之前。
 */
export function applyPatchToActive(patch: BoardPatch): PatchApplyOutcome {
  const state = load();
  const board = state.boards.find((item) => item.id === state.activeId) || state.boards[0];
  if (!board) return { ok: false, error: '没有活动看板' };
  const result = applyPatch(board.doc, patch);
  if (!result.ok || !result.doc) {
    return { ok: false, error: result.errors.join('；') || '补丁被拒绝', errors: result.errors };
  }
  try {
    localStorage.setItem(PATCH_BACKUP_KEY, JSON.stringify({ id: board.id, at: Date.now(), doc: board.doc }));
  } catch (err) {
    console.warn('[XHGCS_BOARDS] 补丁备份失败', err);
  }
  board.doc = result.doc;
  board.name = result.doc.name || board.name;
  board.updatedAt = Date.now();
  result.doc.updatedAt = board.updatedAt;
  if (!persist(state)) {
    return { ok: false, error: '补丁已应用但写入本机存储失败（可能已满），请先清理空间后重试', diff: result.diff, doc: board.doc };
  }
  // 通知已打开的设计器/看板：外部（AI/MCP）改过文档，需要重新加载
  try {
    document.dispatchEvent(new CustomEvent('xhgcs:board-changed', { detail: { id: board.id, source: 'patch' } }));
  } catch (err) {
    /* 非浏览器环境忽略 */
  }
  return {
    ok: true,
    diff: result.diff,
    summary: describePatch(result.diff || { added: 0, removed: 0, updated: 0, moved: 0, renamed: 0 }),
    doc: board.doc
  };
}

/** 只校验不落库：给 MCP 的 dry-run 用，返回可读错误与操作计数。 */
export function previewPatch(patch: BoardPatch): { ok: boolean; errors: string[]; ops: number } {
  const state = load();
  const board = state.boards.find((item) => item.id === state.activeId) || state.boards[0];
  if (!board) return { ok: false, errors: ['没有活动看板'], ops: 0 };
  const errors = validatePatch(board.doc, patch);
  return { ok: errors.length === 0, errors, ops: (patch.ops || []).length };
}

/** 回退最近一次补丁（AI/MCP 改坏时的安全绳）。 */
export function revertLastPatch(): { ok: boolean; error?: string } {
  const raw = readJSON(PATCH_BACKUP_KEY);
  if (!raw || typeof raw !== 'object') return { ok: false, error: '没有可回退的补丁' };
  const backup = raw as { id?: string; doc?: unknown };
  const doc = normalizeDoc(backup.doc);
  if (!doc) return { ok: false, error: '补丁备份已损坏' };
  const state = load();
  const board = state.boards.find((item) => item.id === backup.id) || state.boards.find((item) => item.id === state.activeId);
  if (!board) return { ok: false, error: '备份对应的看板已不存在' };
  board.doc = doc;
  board.name = doc.name || board.name;
  board.updatedAt = Date.now();
  persist(state);
  try {
    document.dispatchEvent(new CustomEvent('xhgcs:board-changed', { detail: { id: board.id, source: 'revert' } }));
  } catch (err) {
    /* 非浏览器环境忽略 */
  }
  return { ok: true };
}

export const BOARD_STORAGE_KEYS = { store: STORE_KEY, legacy: LEGACY_KEY, backup: BACKUP_KEY };


