// For AutoRouter documentation refer to https://itty.dev/itty-router/routers/autorouter
import { AutoRouter } from 'itty-router';
import indexHtml from '../public/index.html';

// ── Fugle API Key ──────────────────────────────────────────────────────────
// 填入你的富果 API Key，空字串則 fallback 使用 TWSE
// TODO: 之後改用 Spin Variables 或 env injection 傳入
const FUGLE_API_KEY = '';

const router = AutoRouter();

// ── 型別 ────────────────────────────────────────────────────────────────────
interface Post {
  title: string; url: string | null; likes: number;
  author: string; date: string; source: string; board: string;
  excerpt?: string; commentCount?: number;
}

// ── 股價：Fugle 優先，fallback TWSE ─────────────────────────────────────────
async function getStockData() {
  if (FUGLE_API_KEY) {
    const r = await fetch(
      'https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/2330',
      { headers: { 'X-API-KEY': FUGLE_API_KEY } },
    );
    if (r.ok) {
      const q = await r.json() as Record<string, unknown>;
      const price  = (q.closePrice ?? q.lastPrice ?? q.previousClose) as number;
      const prev   = q.previousClose as number;
      const change = +(price - prev).toFixed(2);
      const vol    = (q.total as Record<string, number> | undefined)?.tradeVolume ?? null;
      return {
        symbol: '2330', name: (q.name as string) || '台積電', price,
        open: q.openPrice as number, high: q.highPrice as number, low: q.lowPrice as number,
        yesterday: prev, change, changePct: +((change / prev) * 100).toFixed(2),
        volume: vol,
        time: q.lastUpdated ? new Date(q.lastUpdated as string).toLocaleTimeString('zh-TW') : '--',
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

// ── PTT（regex 解析 HTML） ────────────────────────────────────────────────────
function parsePttPosts(html: string): Post[] {
  const posts: Post[] = [];
  const blockRe = /<div class="r-ent">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const b = m[1];
    const t = b.match(/<a href="(\/bbs\/Stock\/[^"]+)">([^<]+)<\/a>/);
    if (!t) continue;
    const title = t[2].trim();
    if (title.startsWith('(')) continue;
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

// ── 輿情分析 ─────────────────────────────────────────────────────────────────
const BULL_WORDS = ['買','長線','看多','加碼','目標價','上漲','突破','漲','正面','AI','輝達','nvidia'];
const BEAR_WORDS = ['賣','看空','減碼','下跌','跌','破','悲觀','出清','停損'];

// ── Routes ──────────────────────────────────────────────────────────────────
router
  .get('/', () => new Response(indexHtml as string, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }))

  .get('/api/stock', async () => {
    try {
      return Response.json(await getStockData());
    } catch (err) {
      return Response.json({ error: '無法取得股價', detail: String(err) }, { status: 502 });
    }
  })

  .get('/api/ptt', async () => {
    try {
      return Response.json(await getPttPosts());
    } catch (err) {
      return Response.json({ error: '無法抓取 PTT', detail: String(err) }, { status: 502 });
    }
  })

  .get('/api/dcard', async () => {
    try {
      return Response.json(await getDcardPosts());
    } catch (err) {
      return Response.json({ error: '無法抓取 Dcard', detail: String(err) }, { status: 502 });
    }
  })

  .get('/api/sentiment', async () => {
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
    return Response.json({
      total: all.length, bullish: b, bearish: s, neutral: n,
      bullPct: Math.round((b / total) * 100),
      bearPct: Math.round((s / total) * 100),
      neutralPct: Math.round((n / total) * 100),
      sentiment: b > s ? 'bullish' : s > b ? 'bearish' : 'neutral',
    });
  });

// ── Spin 入口（Service Worker 模式） ─────────────────────────────────────────
//@ts-ignore
addEventListener('fetch', (event: FetchEvent) => {
  event.respondWith(router.fetch(event.request));
});
