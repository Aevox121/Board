/**
 * 本浏览器会话的协作身份 —— 一次生成、整个会话不变。
 *
 * `clientId` 用于：操作级同步的回声过滤（M4 增量2）、在场光标的身份标识。
 * `name` / `color` 用于拟人化光标的名牌与配色。多端各自随机一套，便于区分。
 */

/** 名字 + 配色预设池 —— 按 clientId 散列取一套，多端大概率不同。 */
const IDENTITIES: ReadonlyArray<{ name: string; color: string }> = [
  { name: '青松', color: '#1971c2' },
  { name: '远山', color: '#2f9e44' },
  { name: '晚枫', color: '#e8590c' },
  { name: '晴野', color: '#9c36b5' },
  { name: '溪流', color: '#0c8599' },
  { name: '沙鸥', color: '#e03131' },
  { name: '暖阳', color: '#f08c00' },
  { name: '夜航', color: '#3b5bdb' },
];

/** 字符串散列（djb2 变体）—— 把 clientId 映射到身份池下标。 */
function hashIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

const clientId = crypto.randomUUID();
const identity = IDENTITIES[hashIndex(clientId, IDENTITIES.length)]!;

/** 本会话身份。 */
export const SESSION = {
  clientId,
  name: identity.name,
  color: identity.color,
} as const;
