/**
 * 极简语义化版本。只做插件清单需要的那部分：
 * 解析、比较、以及 `^ ~ >= <= > < = *` 与 `1.2.x` 形式的范围匹配。
 * 不引入 semver 依赖 —— 内核要能在 file:// 下零依赖跑起来。
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识（1.2.3-beta.1 → "beta.1"），正式版为空串 */
  prerelease: string;
  raw: string;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(String(input || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
    raw: String(input)
  };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  const patchDiff = left.patch - right.patch;
  if (patchDiff !== 0) return patchDiff;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** 语义化版本：正式版 > 预发布版；预发布标识按段比较，纯数字按数值比。 */
function comparePrerelease(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const left = a.split('.');
  const right = b.split('.');
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) {
    const l = left[i];
    const r = right[i];
    if (l == null) return -1;
    if (r == null) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln != null && rn != null) {
      if (ln !== rn) return ln - rn;
      continue;
    }
    if (ln != null) return -1;
    if (rn != null) return 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function wildcard(input: string): { parts: Array<number | null> } {
  // 1.2.x / 1.x / * —— null 表示通配
  const cleaned = String(input || '*')
    .trim()
    .replace(/^v/, '')
    .replace(/[xX*]/g, 'x');
  const parts = cleaned.split('.');
  const out: Array<number | null> = [];
  for (let i = 0; i < 3; i++) {
    const part = parts[i];
    if (part == null || part === 'x' || part === '') {
      out.push(null);
      continue;
    }
    const num = Number(part);
    out.push(Number.isFinite(num) ? num : null);
  }
  return { parts: out };
}

function matchComparator(version: string, comparator: string): boolean {
  const token = comparator.trim();
  if (!token || token === '*' || token === 'x' || token === 'latest') return true;

  const operator = /^(>=|<=|>|<|=|\^|~)/.exec(token)?.[1] ?? '';
  const body = operator ? token.slice(operator.length).trim() : token;
  const parsed = parseVersion(version);
  if (!parsed) return false;

  if (operator === '^' || operator === '~' || operator === '') {
    const range = wildcard(body);
    const [major, minor, patch] = range.parts;
    if (major != null && parsed.major !== major) return false;
    if (minor != null) {
      if (parsed.minor !== minor) return false;
      if (operator === '~' || operator === '') {
        if (patch != null && parsed.patch !== patch) return false;
        return true;
      }
      // ^：同一个 major 内更高版本都算兼容
      if (operator === '^') return parsed.major === major;
    }
    return true;
  }

  // 比较型：缺省段按 0 处理
  const target = `0.0.0`.split('.');
  const range = wildcard(body);
  for (let i = 0; i < 3; i++) {
    if (range.parts[i] != null) target[i] = String(range.parts[i]);
  }
  const targetVersion = target.join('.');
  const cmp = compareVersions(version, targetVersion);
  switch (operator) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    case '=':
      return cmp === 0;
    default:
      return true;
  }
}

/** `satisfies('0.9.7', '^0.9.0') === true` */
export function satisfies(version: string, range?: string): boolean {
  if (!parseVersion(version)) return false;
  const text = String(range == null ? '*' : range).trim();
  if (!text || text === '*') return true;
  // 用 || 分隔的备选范围，满足任意一个即可
  return text.split('||').some((segment) => {
    const comparators = segment.trim().split(/\s+/).filter(Boolean);
    if (!comparators.length) return true;
    return comparators.every((comparator) => matchComparator(version, comparator));
  });
}

const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*v?\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/;

/**
 * 区间是否写对了。
 * `satisfies()` 对无法识别的比较符会「默认放行」，所以清单校验必须先用这个把非法区间挡掉，
 * 否则 `engines.xhgcs: "not-a-range"` 会静默通过。
 */
export function isValidRange(range?: string): boolean {
  const text = String(range == null ? '*' : range).trim();
  if (!text || text === '*') return true;
  return text.split('||').every((segment) => {
    const comparators = segment.trim().split(/\s+/).filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => COMPARATOR_RE.test(comparator));
  });
}
