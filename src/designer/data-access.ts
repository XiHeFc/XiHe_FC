/**
 * 设计器/看板的数据访问层。
 *
 * 只做两件事：把老通道读成快照、把通道包成「序列」。不持有状态、不碰 DOM。
 * 放在单独文件里，是为了让 bindings（解析绑定）和 widgets（画控件）都能用，
 * 又不至于互相 import 成环。
 */

export interface ChannelLike {
  id: string;
  name?: string;
  unit?: string;
  color?: string;
  data?: number[];
  isScript?: boolean;
}

export interface SeriesPoint {
  id: string;
  label: string;
  unit: string;
  color: string;
  /** 原始值（绑定里的 transform 已经应用过） */
  values: number[];
}

const PALETTE = ['#6da8d2', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#38bdf8', '#facc15'];

interface LegacyState {
  channels?: ChannelLike[];
  scriptChannels?: ChannelLike[];
}

export function currentChannels(): ChannelLike[] {
  const state = (window as unknown as { XHGCS?: { state?: LegacyState } }).XHGCS?.state;
  if (!state) return [];
  const list: ChannelLike[] = [];
  if (Array.isArray(state.channels)) list.push(...state.channels);
  if (Array.isArray(state.scriptChannels)) list.push(...state.scriptChannels);
  return list;
}

export function channelById(id: string): ChannelLike | undefined {
  return currentChannels().find((channel) => channel.id === id);
}

/** 按名字/id 子串选通道，`*` 表示全部（与老 view-kit 的查询语义一致）。 */
export function channelsByQuery(query: string): ChannelLike[] {
  const text = String(query || '').trim();
  const all = currentChannels();
  if (!text || text === '*') return all;
  const lower = text.toLowerCase();
  return all.filter((channel) => `${channel.id} ${channel.name || ''}`.toLowerCase().includes(lower));
}

export function colorOf(channel: ChannelLike, index: number): string {
  return channel.color || PALETTE[index % PALETTE.length];
}

export function toSeries(channel: ChannelLike, index: number): SeriesPoint {
  return {
    id: channel.id,
    label: channel.name || channel.id,
    unit: channel.unit || '',
    color: colorOf(channel, index),
    values: Array.isArray(channel.data) ? channel.data : []
  };
}

export function tail(values: number[], count: number): number[] {
  const size = Math.max(0, Math.floor(count) || 0);
  if (!size) return values.slice();
  return values.length > size ? values.slice(values.length - size) : values.slice();
}

export function latestValue(values: number[]): number {
  return values.length ? Number(values[values.length - 1]) || 0 : 0;
}

export { PALETTE };
