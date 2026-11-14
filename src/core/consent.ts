/**
 * 插件授权与启停状态。
 *
 * 两条独立的状态，别混：
 *   - 授权（consent）：用户同意授予哪些能力。`granted = 清单声明 ∩ 用户勾选`；
 *   - 启停（state）：用户把这个插件关了没有。
 *
 * 指纹 = 版本 + 权限集合 + 入口标识。任何一项变化都要求重新确认 ——
 * 否则插件升级时偷偷加一条 `network` 就能绕过授权。
 */
import type { ExtensionManifest } from './types';

const CONSENT_KEY = 'xhgcs.ext.consent.v1';
const STATE_KEY = 'xhgcs.ext.state.v1';

/** 默认不勾选的高风险能力：网络、文件系统、写通道 */
export const RISKY_PERMISSIONS = new Set(['network', 'fs:own', 'data:write']);

export interface ConsentRecord {
  fingerprint: string;
  granted: string[];
  at: number;
}

type ConsentMap = Record<string, ConsentRecord>;
type StateMap = Record<string, 'disabled' | 'enabled'>;

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('[XHGCS_CONSENT] 写入失败', key, err);
  }
}

export function fingerprintOf(manifest: ExtensionManifest): string {
  const permissions = (manifest.permissions || []).slice().sort().join(',');
  const entry = manifest.main || 'inline';
  const body = manifest.main === 'inline' ? String(manifest.inlineScript || '').length : '';
  return `${manifest.version}|${permissions}|${entry}|${body}`;
}

export function loadConsent(): ConsentMap {
  return readJSON<ConsentMap>(CONSENT_KEY) || {};
}

/** 是否已经授权过（且指纹没变）。 */
export function isGranted(manifest: ExtensionManifest): boolean {
  const record = loadConsent()[manifest.id];
  return Boolean(record) && record.fingerprint === fingerprintOf(manifest);
}

/** 实际生效的能力列表 = 清单声明 ∩ 用户勾选。 */
export function grantedPermissions(manifest: ExtensionManifest): string[] {
  const declared = manifest.permissions || [];
  if (!declared.length) return [];
  const record = loadConsent()[manifest.id];
  if (!record || record.fingerprint !== fingerprintOf(manifest)) return [];
  return declared.filter((permission) => record.granted.includes(permission));
}

export function grant(manifest: ExtensionManifest, permissions: string[]): void {
  const map = loadConsent();
  const declared = new Set(manifest.permissions || []);
  map[manifest.id] = {
    fingerprint: fingerprintOf(manifest),
    granted: permissions.filter((permission) => declared.has(permission)),
    at: Date.now()
  };
  writeJSON(CONSENT_KEY, map);
}

export function revoke(id: string): void {
  const map = loadConsent();
  delete map[id];
  writeJSON(CONSENT_KEY, map);
}

/** 默认勾选：除高风险能力外全部同意（用户仍可逐项去掉）。 */
export function defaultGrant(manifest: ExtensionManifest): string[] {
  return (manifest.permissions || []).filter((permission) => !RISKY_PERMISSIONS.has(permission));
}

export function loadState(): StateMap {
  return readJSON<StateMap>(STATE_KEY) || {};
}

export function setDisabled(id: string, disabled: boolean): void {
  const map = loadState();
  map[id] = disabled ? 'disabled' : 'enabled';
  writeJSON(STATE_KEY, map);
}

export function isDisabled(id: string): boolean {
  return loadState()[id] === 'disabled';
}

export function disabledIds(): string[] {
  const map = loadState();
  return Object.keys(map).filter((id) => map[id] === 'disabled');
}
