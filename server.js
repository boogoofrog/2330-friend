const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache: stock 60s, PTT/Dcard 5min
const stockCache = new NodeCache({ stdTTL: 60 });
const newsCache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 台股即時股價 (TWSE API) ────────────────────────────────────────────────
app.get('/api/stock', async (req, res) => {
  const cached = stockCache.get('2330');
  if (cached) return res.json(cached);

  try {
    const { data } = await axios.get(
      'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0',
      { headers: { 'Referer': 'https://mis.twse.com.tw/' }, timeout: 8000 }
    );

    const d = data?.msgArray?.[0];
    if (!d) return res.status(502).json({ error: 'TWSE API 無資料' });

    const price = parseFloat(d.z || d.y);
    const open = parseFloat(d.o);
    const high = parseFloat(d.h);
    const low = parseFloat(d.l);
    const yesterday = parseFloat(d.y);
    const change = +(price - yesterday).toFixed(2);
    const changePct = +((change / yesterday) * 100).toFixed(2);
    const volume = Math.round(parseInt(d.v || 0) / 1000); // 張

    const result = {
      symbol: '2330',
      name: d.n || '台積電',
      price,
      open,
      high,
      low,
      yesterday,
      change,
      changePct,
      volume,
      time: d.t || '--',
      date: d.d || '--',
    };

    stockCache.set('2330', result);
    res.json(result);
  } catch (err) {
    console.error('Stock API error:', err.message);
    res.status(502).json({ error: '無法取得股價', detail: err.message });
  }
});

// ─── PTT Stock 板 2330 文章 ──────────────────────────────────────────────────
app.get('/api/ptt', async (req, res) => {
  const cached = newsCache.get('ptt');
  if (cached) return res.json(cached);

  try {
    const { data } = await axios.get(
      'https://www.ptt.cc/bbs/Stock/search?q=2330',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; 2330-friend-bot/1.0)',
          'Cookie': 'over18=1',
        },
        timeout: 10000,
      }
    );

    const $ = cheerio.load(data);
    const posts = [];

    $('#main-container .r-ent').each((_, el) => {
      const titleEl = $(el).find('.title a');
      const title = titleEl.text().trim();
      const href = titleEl.attr('href');
      if (!title || title.startsWith('(')) return; // skip deleted

      const likes = parseInt($(el).find('.nrec span').text().trim()) || 0;
      const author = $(el).find('.author').text().trim();
      const date = $(el).find('.date').text().trim();

      posts.push({
        title,
        url: href ? `https://www.ptt.cc${href}` : null,
        likes,
        author,
        date,
        source: 'PTT',
        board: 'Stock',
      });
    });

    const result = posts.slice(0, 20);
    newsCache.set('ptt', result);
    res.json(result);
  } catch (err) {
    console.error('PTT error:', err.message);
    res.status(502).json({ error: '無法抓取 PTT', detail: err.message });
  }
});

// ─── Dcard 股票板 2330 ───────────────────────────────────────────────────────
app.get('/api/dcard', async (req, res) => {
  const cached = newsCache.get('dcard');
  if (cached) return res.json(cached);

  try {
    // Dcard public API
    const { data } = await axios.get(
      'https://www.dcard.tw/service/api/v2/search/posts?query=2330&limit=20',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; 2330-friend-bot/1.0)',
          'Referer': 'https://www.dcard.tw/',
        },
        timeout: 10000,
      }
    );

    const posts = (Array.isArray(data) ? data : []).map(p => ({
      title: p.title,
      url: `https://www.dcard.tw/f/${p.forumAlias}/p/${p.id}`,
      likes: p.likeCount || 0,
      author: p.gender === 'M' ? '男生' : p.gender === 'F' ? '女生' : '匿名',
      date: p.createdAt ? new Date(p.createdAt).toLocaleDateString('zh-TW') : '--',
      excerpt: p.excerpt || '',
      commentCount: p.commentCount || 0,
      source: 'Dcard',
      board: p.forumName || 'Dcard',
    }));

    newsCache.set('dcard', posts);
    res.json(posts);
  } catch (err) {
    console.error('Dcard error:', err.message);
    res.status(502).json({ error: '無法抓取 Dcard', detail: err.message });
  }
});

// ─── 合併輿情摘要 ─────────────────────────────────────────────────────────────
app.get('/api/sentiment', async (req, res) => {
  const cached = newsCache.get('sentiment');
  if (cached) return res.json(cached);

  try {
    const [pttRes, dcardRes] = await Promise.allSettled([
      axios.get(`http://localhost:${PORT}/api/ptt`),
      axios.get(`http://localhost:${PORT}/api/dcard`),
    ]);

    const pttPosts = pttRes.status === 'fulfilled' ? pttRes.value.data : [];
    const dcardPosts = dcardRes.status === 'fulfilled' ? dcardRes.value.data : [];
    const allPosts = [...(Array.isArray(pttPosts) ? pttPosts : []), ...(Array.isArray(dcardPosts) ? dcardPosts : [])];

    // Simple sentiment based on keywords
    const bullish = ['買', '長線', '看多', '加碼', '目標價', '上漲', '突破', '強', '好', '漲', '正面', 'AI', '輝達', 'nvidia'];
    const bearish = ['賣', '看空', '減碼', '下跌', '跌', '破', '弱', '壞', '悲觀', '出清', '停損'];

    let bullCount = 0, bearCount = 0, neutralCount = 0;
    allPosts.forEach(p => {
      const text = (p.title + ' ' + (p.excerpt || '')).toLowerCase();
      const b = bullish.filter(w => text.includes(w)).length;
      const s = bearish.filter(w => text.includes(w)).length;
      if (b > s) bullCount++;
      else if (s > b) bearCount++;
      else neutralCount++;
    });

    const total = allPosts.length || 1;
    const result = {
      total,
      bullish: bullCount,
      bearish: bearCount,
      neutral: neutralCount,
      bullPct: Math.round((bullCount / total) * 100),
      bearPct: Math.round((bearCount / total) * 100),
      neutralPct: Math.round((neutralCount / total) * 100),
      sentiment: bullCount > bearCount ? 'bullish' : bearCount > bullCount ? 'bearish' : 'neutral',
    };

    newsCache.set('sentiment', result);
    res.json(result);
  } catch (err) {
    console.error('Sentiment error:', err.message);
    res.status(502).json({ error: '無法計算輿情' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 2330-Friend 啟動成功！`);
  console.log(`   http://localhost:${PORT}\n`);
});
