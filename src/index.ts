import { Kv, Variables } from '@fermyon/spin-sdk';
import { Hono } from 'hono';
import indexHtml from '../public/index.html';

const app = new Hono();

// ── KV 快取（手動 TTL，因 Spin KV 不支援原生 TTL） ──────────────────────────
interface CacheEntry<T> { v: T; t: number }

function cacheGet<T>(key: string, ttlMs: number): T | null {
  try {
    const e = Kv.openDefault().getJson(key) as CacheEntry<T> | null;
    if (e && Date.now() - e.t < ttlMs) return e.v;
  } catch { /* KV 未設定時忽略 */ }
  return null;
}

function cacheSet<T>(key: string, data: T): void {
  try { Kv.openDefault().setJson(key, { v: data, t: Date.now() }); } catch {}
}

const STOCK_TTL = 60_000;   // 60 秒
const NEWS_TTL  = 300_000;  // 5 分鐘

// ── 股價：Fugle 優先，fallback TWSE ─────────────────────────────────────────
async function getStockData() {
  let fugleKey = '';
  try { fugleKey = Variables.get('fugle_api_key') ?? ''; } catch {}

  if (fugleKey) {
    const r = await fetch(
      'https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/2330',
      { headers: { 'X-API-KEY': fugleKey } },
    );
    if (r.ok) {
      const q = await r.json() as Record<string, unknown>;
      const price    = (q.closePrice ?? q.lastPrice ?? q.previousClose) as number;
      const prev     = q.previousClose as number;
      const change   = +(price - prev).toFixed(2);
      const vol      = (q.total as Record<string, number> | undefined)?.tradeVolume ?? null;
      return {
        symbol: '2330', name: (q.name as string) || '台積電', price,
        open: q.openPrice as number, high: q.highPrice as number, low: q.lowPrice as number,
        yesterday: prev, change, changePct: +((change / prev) * 100).toFixed(2),
        volume: vol,
        time: q.lastUpdated
          ? new Date(q.lastUpdated as string).toLocaleTimeString('zh-TW')
          : '--',
        date: new Date().toLocaleDateString('zh-TW'),
        source: 'Fugle',
      };
    }
  }

  // TWSE fallback
  const r = await fetch(
    'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0',
    { headers: { 'Referer': 'https://mis.twse.com.tw/' } },
  );
  if (!r.ok) throw new Error(`TWSE HTTP ${r.status}`);
  const data = await r.json() as { msgArray?: Record<string, string>[] };
  const d = data?.msgArray?.[0];
  if (!d) throw new Error('TWSE 無資料');

  const price  = parseFloat(d.z || d.y);
  const prev   = parseFloat(d.y);
  const change = +(price - prev).toFixed(2);
  return {
    symbol: '2330', name: d.n || '台積電', price,
    open: parseFloat(d.o), high: parseFloat(d.h), low: parseFloat(d.l),
    yesterday: prev, change, changePct: +((change / prev) * 100).toFixed(2),
    volume: Math.round(parseInt(d.v || '0') / 1000),
    time: d.t || '--', date: d.d || '--', source: 'TWSE',
  };
}

app.get('/api/stock', async (c) => {
  const cached = cacheGet('stock', STOCK_TTL);
  if (cached) return c.json(cached);
  try {
    const result = await getStockData();
    cacheSet('stock', result);
    return c.json(result);
  } catch (err: unknown) {
    return c.json({ error: '無法取得股價', detail: String(err) }, 502);
  }
});

// ── PTT（用 regex 解析 HTML，因 Wasm 環境無法使用 cheerio） ─────────────────
interface Post {
  title: string; url: string | null; likes: number;
  author: string; date: string; source: string; board: string;
  excerpt?: string; commentCount?: number;
}

function parsePttPosts(html: string): Post[] {
  const posts: Post[] = [];
  // 每個 .r-ent block（PTT 的文章列表項目）
  const blockRe = /<div class="r-ent">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const b = m[1];
    // 標題 + 連結（已刪文沒有 <a> 標籤）
    const t = b.match(/<a href="(\/bbs\/Stock\/[^"]+)">([^<]+)<\/a>/);
    if (!t) continue;
    const title = t[2].trim();
    if (title.startsWith('(')) continue; // 已刪文

    // 推文數（可能是數字、「爆」、「XX」）
    const rawLikes = b.match(/<span[^>]*>(\d+|爆|X+)<\/span>/)?.[1] ?? '0';
    const likes = rawLikes === '爆' ? 100 : rawLikes.startsWith('X') ? -rawLikes.length * 10 : parseInt(rawLikes);

    const author = b.match(/<div class="author">([^<]+)<\/div>/)?.[1]?.trim() ?? '';
    const date   = b.match(/<div class="date">\s*([^<]+)\s*<\/div>/)?.[1]?.trim() ?? '';

    posts.push({ title, url: `https://www.ptt.cc${t[1]}`, likes, author, date, source: 'PTT', board: 'Stock' });
  }
  return posts.slice(0, 20);
}

async function getPttPosts(): Promise<Post[]> {
  const r = await fetch('https://www.ptt.cc/bbs/Stock/search?q=2330', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 2330-friend/1.0)', 'Cookie': 'over18=1' },
  });
  if (!r.ok) throw new Error(`PTT HTTP ${r.status}`);
  return parsePttPosts(await r.text());
}

app.get('/api/ptt', async (c) => {
  const cached = cacheGet<Post[]>('ptt', NEWS_TTL);
  if (cached) return c.json(cached);
  try {
    const posts = await getPttPosts();
    cacheSet('ptt', posts);
    return c.json(posts);
  } catch (err: unknown) {
    return c.json({ error: '無法抓取 PTT', detail: String(err) }, 502);
  }
});

// ── Dcard ──────────────────────────────────────────────────────────────────
interface DcardApiPost {
  title: string; forumAlias: string; id: number; likeCount?: number;
  gender?: string; createdAt?: string; excerpt?: string;
  commentCount?: number; forumName?: string;
}

async function getDcardPosts(): Promise<Post[]> {
  const r = await fetch(
    'https://www.dcard.tw/service/api/v2/search/posts?query=2330&limit=20',
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 2330-friend/1.0)', 'Referer': 'https://www.dcard.tw/' } },
  );
  if (!r.ok) throw new Error(`Dcard HTTP ${r.status}`);
  const data = await r.json() as DcardApiPost[];
  return (Array.isArray(data) ? data : []).map(p => ({
    title: p.title,
    url: `https://www.dcard.tw/f/${p.forumAlias}/p/${p.id}`,
    likes: p.likeCount ?? 0,
    author: p.gender === 'M' ? '男生' : p.gender === 'F' ? '女生' : '匿名',
    date: p.createdAt ? new Date(p.createdAt).toLocaleDateString('zh-TW') : '--',
    excerpt: p.excerpt ?? '',
    commentCount: p.commentCount ?? 0,
    source: 'Dcard', board: p.forumName ?? 'Dcard',
  }));
}

app.get('/api/dcard', async (c) => {
  const cached = cacheGet<Post[]>('dcard', NEWS_TTL);
  if (cached) return c.json(cached);
  try {
    const posts = await getDcardPosts();
    cacheSet('dcard', posts);
    return c.json(posts);
  } catch (err: unknown) {
    return c.json({ error: '無法抓取 Dcard', detail: String(err) }, 502);
  }
});

// ── 輿情分析 ────────────────────────────────────────────────────────────────
const BULL_WORDS = ['買','長線','看多','加碼','目標價','上漲','突破','漲','正面','AI','輝達','nvidia'];
const BEAR_WORDS = ['賣','看空','減碼','下跌','跌','破','悲觀','出清','停損'];

app.get('/api/sentiment', async (c) => {
  const cached = cacheGet('sentiment', NEWS_TTL);
  if (cached) return c.json(cached);

  const [pttR, dcardR] = await Promise.allSettled([getPttPosts(), getDcardPosts()]);
  const all: Post[] = [
    ...(pttR.status   === 'fulfilled' ? pttR.value   : []),
    ...(dcardR.status === 'fulfilled' ? dcardR.value : []),
  ];

  let b = 0, s = 0, n = 0;
  for (const p of all) {
    const txt = `${p.title} ${p.excerpt ?? ''}`.toLowerCase();
    const bc = BULL_WORDS.filter(w => txt.includes(w)).length;
    const sc = BEAR_WORDS.filter(w => txt.includes(w)).length;
    if (bc > sc) b++; else if (sc > bc) s++; else n++;
  }

  const total = all.length || 1;
  const result = {
    total: all.length, bullish: b, bearish: s, neutral: n,
    bullPct:    Math.round((b / total) * 100),
    bearPct:    Math.round((s / total) * 100),
    neutralPct: Math.round((n / total) * 100),
    sentiment: b > s ? 'bullish' : s > b ? 'bearish' : 'neutral',
  };
  cacheSet('sentiment', result);
  return c.json(result);
});

// ── 前端 HTML ────────────────────────────────────────────────────────────────
app.get('/', (c) => c.html(indexHtml as string));

// ── Spin 入口 ────────────────────────────────────────────────────────────────
export default app;
