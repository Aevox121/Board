/**
 * 本浏览器会话的协作身份 —— clientId 一次生成、整个会话不变；显示名 / 配色
 * 则按「当前在线的真人集合」**确定性协调**得出，避免多人撞名（见下）。
 *
 * `clientId` 用于：操作级同步的回声过滤（M4 增量2）、在场光标的身份标识。
 * `name` / `color` 用于拟人化光标的名牌与配色。
 */

/** 名字 + 配色预设池 —— 协调分配的槽位来源。池越大、同名概率越低。 */
const IDENTITIES: ReadonlyArray<{ name: string; color: string }> = [
  { name: '青松', color: '#1971c2' },
  { name: '远山', color: '#2f9e44' },
  { name: '晚枫', color: '#e8590c' },
  { name: '晴野', color: '#9c36b5' },
  { name: '溪流', color: '#0c8599' },
  { name: '沙鸥', color: '#e03131' },
  { name: '暖阳', color: '#f08c00' },
  { name: '夜航', color: '#3b5bdb' },
  { name: '寒梅', color: '#c2255c' },
  { name: '疏竹', color: '#2b8a3e' },
  { name: '流云', color: '#1098ad' },
  { name: '听雨', color: '#5f3dc4' },
  { name: '望月', color: '#1864ab' },
  { name: '闻笛', color: '#d6336c' },
  { name: '拾光', color: '#e8702a' },
  { name: '观澜', color: '#0b7285' },
];

export interface Identity {
  name: string;
  color: string;
}

/** 字符串散列（djb2 变体）—— 把 clientId 映射到身份池下标。 */
function hashIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

/**
 * 对「全体自动起名的真人」做**确定性全局身份分配**，返回 `selfId` 应得的身份。
 *
 * 为什么这样能去重：每个客户端把 `自己 + 在线真人 peer` 的 clientId 取并集、
 * **排序**后跑同一套分配算法 —— 输入相同 → 各端算出**完全一致**的映射，
 * 无需互相协调、无竞态。每人优先落在自己 clientId 哈希出的槽位；只有该槽
 * 已被「排序更靠前」的人占用时才线性探测到下一个**占用最少**的空槽，故撞名
 * 时较晚者让位、既存名字基本稳定。人数超过池容量时同槽位追加数字后缀（青松2…），
 * 仍保证唯一。
 *
 * Agent（CLI/MCP）有自带显示名、不参与本分配 —— 调用方只传真人 clientId。
 */
export function resolveIdentity(
  selfId: string,
  otherHumanIds: Iterable<string>,
): Identity {
  const pool = IDENTITIES.length;
  const ids = Array.from(new Set([selfId, ...otherHumanIds])).sort();
  const slotUse = new Array<number>(pool).fill(0);
  let result: Identity | null = null;
  for (const id of ids) {
    const base = hashIndex(id, pool);
    // 从 base 起找「占用次数最少」的槽位（base 空就直接用）。扫描顺序固定 →
    // 各端结果一致。
    let bestSlot = base;
    let bestCount = slotUse[base]!;
    if (bestCount > 0) {
      for (let k = 1; k < pool; k++) {
        const s = (base + k) % pool;
        if (slotUse[s]! < bestCount) {
          bestSlot = s;
          bestCount = slotUse[s]!;
          if (bestCount === 0) break;
        }
      }
    }
    const dupIndex = slotUse[bestSlot]!; // 0=首位，>0 表示该槽位重复占用
    slotUse[bestSlot] = dupIndex + 1;
    if (id === selfId) {
      const base$ = IDENTITIES[bestSlot]!;
      result =
        dupIndex === 0
          ? { name: base$.name, color: base$.color }
          : { name: `${base$.name}${dupIndex + 1}`, color: base$.color };
    }
  }
  // selfId 必在 ids 中，result 一定被赋值；留兜底防御。
  return result ?? IDENTITIES[hashIndex(selfId, pool)]!;
}

/**
 * 生成本会话 clientId。
 *
 * `crypto.randomUUID()` **仅安全上下文（https / localhost）可用** —— 别人用
 * `http://<局域网IP>:4511` 打开时它是 undefined，会直接抛错让整页崩。故回退：
 *  ① 有 randomUUID 就用（localhost / https 保持原行为）；
 *  ② 否则用 `crypto.getRandomValues`（非安全上下文亦可用）拼一个 UUIDv4；
 *  ③ 再兜底 `Math.random`。这样局域网明文 HTTP 分享也能正常协作。
 */
function randomClientId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* 落到下面的回退 */
    }
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return (
      `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-` +
      `${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`
    );
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const clientId = randomClientId();

/**
 * 本会话身份。
 *
 * `clientId` 稳定不变。`name` / `color` 是**独处时**的默认身份（按 clientId
 * 哈希），有 peer 在场时应改用 `resolveIdentity(clientId, 在线真人ids)` 取协调
 * 后的身份（PresenceLayer 上报 / PresenceBar「你」chip 各自实时计算）。
 */
const solo = resolveIdentity(clientId, []);
export const SESSION = {
  clientId,
  name: solo.name,
  color: solo.color,
} as const;
