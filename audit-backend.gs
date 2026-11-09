/**
 * Tavlo Studio — Combined Site Audit Backend (Google Apps Script)
 * Deploy as a Web app (Execute as: Me, Who has access: Anyone).
 * Secret (set in Project Settings > Script properties): PSI_API_KEY
 */
var CONFIG = {
  DAILY_LIMIT: 300,            // max audits per day (protects your free quota)
  CACHE_SECONDS: 21600,        // reuse the same result for 6 hours
  UA: 'Mozilla/5.0 (compatible; TavloAuditBot/1.0; +https://github.io)'
};
var AI_BOTS = ['GPTBot','OAI-SearchBot','ChatGPT-User','ClaudeBot','Claude-SearchBot','PerplexityBot','Google-Extended','Applebot-Extended','CCBot'];
var KEY_BOTS = ['GPTBot','OAI-SearchBot','ChatGPT-User','ClaudeBot','PerplexityBot','Google-Extended'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.ping) return json_({ ok: true });
    var pg = parseUrl_(p.url);
    if (!pg) return json_({ error: 'Please enter a valid public website address, for example https://example.com' });

    var cache = CacheService.getScriptCache();
    var cacheKey = 'site_audit:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, pg.url));
    var hit = cache.get(cacheKey);
    if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);

    if (!underLimit_()) return json_({ error: 'The free audit tool is busy right now. Please try again later, or contact us for a manual audit.' });

    var page = get_(pg.url, 1500000);
    if (page.code >= 400 || page.code === 0) return json_({ error: 'We could not open that page (the site answered with status ' + page.code + ').' });
    
    var info = parsePage_(page.text, pg);
    var robotsRes = get_(pg.origin + '/robots.txt', 200000);
    var robots = parseRobots_(robotsRes.code === 200 && /user-agent|sitemap|disallow/i.test(robotsRes.text) ? robotsRes.text : '');
    var ctx = { pg: pg, page: page, info: info, robots: robots, robotsFound: robotsRes.code === 200 && /user-agent|sitemap|disallow/i.test(robotsRes.text) };

    // Fetch Performance metrics from Google API
    var psData = psi_(pg.url) || { performance: null, seo: null, accessibility: null, bestPractices: null, error: true };

    // Run all individual checks
    var seoResults = auditSeo_(ctx, psData);
    var geoResults = auditGeo_(ctx);
    var aeoResults = auditAeo_(ctx);

    // Construct unified response layout
    var finalResult = {
      url: pg.url,
      checkedAt: new Date().toISOString(),
      performance: {
        score: psData.performance || 0,
        lcp: psData.lcp || "N/A",
        cls: psData.cls || "N/A",
        accessibility: psData.accessibility || 0,
        bestPractices: psData.bestPractices || 0
      },
      seo: seoResults,
      geo: geoResults,
      aeo: aeoResults
    };

    var out = JSON.stringify(finalResult);
    try { cache.put(cacheKey, out, CONFIG.CACHE_SECONDS); } catch (x) {}
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var m = String((err && err.message) || err);
    if (/DNS|Address unavailable|Unable to resolve/i.test(m)) m = 'We could not find that website. Please check the address.';
    else m = 'The audit could not be completed (' + m.slice(0, 120) + ').';
    return json_({ error: m });
  }
}

/* ---------------- System Core Utilities ---------------- */
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function underLimit_() {
  var props = PropertiesService.getScriptProperties();
  var day = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  var d = props.getProperty('day'), n = Number(props.getProperty('count') || 0);
  if (d !== day) { d = day; n = 0; }
  if (n >= CONFIG.DAILY_LIMIT) return false;
  props.setProperty('day', d); props.setProperty('count', String(n + 1));
  return true;
}

function parseUrl_(input) {
  var s = String(input || '').trim();
  if (!s || s.length > 300) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  var m = s.match(/^(https?):\/\/([^\/?#:@]+)(?::(\d+))?([^#]*)/i);
  if (!m) return null;
  var host = m[2].toLowerCase(), port = m[3] || '';
  if (port && port !== '80' && port !== '443') return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (/(^|\.)(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) return null;
  var path = m[4] || '/';
  if (path.charAt(0) !== '/') path = '/' + path;
  var scheme = m[1].toLowerCase();
  return { scheme: scheme, host: host, path: path, url: scheme + '://' + host + path, origin: scheme + '://' + host };
}

function get_(url, maxChars) {
  var t0 = Date.now();
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': CONFIG.UA, 'Accept': 'text/html,application/xhtml+xml,text/plain,*/*' } });
  var text = r.getContentText() || '';
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { code: r.getResponseCode(), text: text, headers: r.getHeaders() || {}, ms: Date.now() - t0 };
}

function attr_(tag, name) {
  var m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
}
function decode_(s) { return String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function plain_(s) { return decode_(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function wc_(s) { s = plain_(s); return s ? s.split(' ').length : 0; }

function parseRobots_(txt) {
  var groups = [], cur = null, lastAgent = false, sitemaps = [];
  String(txt || '').split(/\r?\n/).forEach(function (line) {
    line = line.replace(/#.*/, '').trim(); if (!line) return;
    var i = line.indexOf(':'); if (i < 0) return;
    var k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') { if (!cur || !lastAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastAgent = true; }
    else { lastAgent = false; if (k === 'sitemap') sitemaps.push(v); else if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ t: k, p: v }); }
  });
  return { groups: groups, sitemaps: sitemaps };
}
function groupFor_(robots, bot) {
  var b = bot.toLowerCase(), g = null, star = null;
  robots.groups.forEach(function (x) { if (x.agents.indexOf(b) > -1) g = x; if (x.agents.indexOf('*') > -1 && !star) star = x; });
  return g || star;
}
function botBlocked_(robots, bot) {
  var g = groupFor_(robots, bot); if (!g) return false;
  var dis = g.rules.some(function (r) { return r.t === 'disallow' && r.p === '/'; });
  var alw = g.rules.some(function (r) { return r.t === 'allow' && (r.p === '/' || r.p === ''); });
  return dis && !alw;
}

function parsePage_(html, pg) {
  var o = {};
  var clean = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  o.clean = clean;
  o.words = wc_(clean);
  var t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); o.title = t ? plain_(t[1]) : '';
  o.meta = {};
  (html.match(/<meta\b[^>]*>/gi) || []).forEach(function (m) {
    var n = (attr_(m, 'name') || attr_(m, 'property') || '').toLowerCase(), c = attr_(m, 'content');
    if (n && c !== null && !(n in o.meta)) o.meta[n] = decode_(c);
  });
  o.canonical = null;
  (html.match(/<link\b[^>]*>/gi) || []).forEach(function (l) { if (/rel\s*=\s*["']?canonical/i.test(l)) o.canonical = attr_(l, 'href'); });
  o.hasLang = /<html\b[^>]*\blang\s*=/i.test(html);
  o.h1 = []; o.h2 = []; o.h3 = []; o.questions = [];
  var re = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi, m;
  while ((m = re.exec(clean))) { var lvl = m[1].toLowerCase(), item = { text: plain_(m[2]), end: re.lastIndex }; if (lvl === 'h1') o.h1.push(item); else if (lvl === 'h2') o.h2.push(item); else o.h3.push(item); }
  var qre = /<(button|summary|dt)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = qre.exec(clean))) { var tx = plain_(m[2]); if (/\?\s*(\+|−|-)?$/.test(tx) && tx.length < 200) o.questions.push({ text: tx, end: qre.lastIndex }); }
  var isQ = function (s) { return /\?\s*$/.test(s) || /^(what|how|why|when|who|where|which|can|could|does|do|is|are|should|will)\b/i.test(s); };
  o.h2.concat(o.h3).forEach(function (h) { if (isQ(h.text)) o.questions.push(h); });
  var imgs = html.match(/<img\b[^>]*>/gi) || []; o.imgTotal = imgs.length; o.imgNoAlt = imgs.filter(function (i) { return attr_(i, 'alt') === null; }).length;
  o.internal = 0; o.external = 0; o.hasContactLink = false;
  var are = /<a\b[^>]*href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi;
  while ((m = are.exec(clean))) {
    var href = m[1].replace(/^["']|["']$/g, '').trim();
    if (/^(mailto:|tel:)/i.test(href)) { o.hasContactLink = true; continue; }
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) continue;
    var hm = href.match(/^https?:\/\/([^\/?#:]+)/i);
    if (!hm) o.internal++; else { var h = hm[1].toLowerCase(); if (h === pg.host || h === 'www.' + pg.host || 'www.' + h === pg.host) o.internal++; else o.external++; }
  }
  o.ld = { types: [], sameAs: 0, errors: 0, blocks: 0, dates: false, author: false, speakable: false };
  var lre = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = lre.exec(html))) {
    o.ld.blocks++;
    try {
      var walk = function (n) {
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (!n || typeof n !== 'object') return;
        if (n['@type']) [].concat(n['@type']).forEach(function (ty) { if (o.ld.types.indexOf(ty) < 0) o.ld.types.push(ty); });
        if (n.sameAs) o.ld.sameAs += [].concat(n.sameAs).length;
        if (n.datePublished || n.dateModified) o.ld.dates = true;
        if (n.author) o.ld.author = true;
f (n.speakable) o.ld.speakable = true;
Object.keys(n).forEach(function (k) { walk(n[k]); });
};
walk(JSON.parse(m[1]));
} catch (x) { o.ld.errors++; }
}
o.hasTime = /<time\b[^>]datetime\s=/i.test(html) || /article:(published|modified)time|"dateModified"/i.test(html);
var ps = []; var pre = /<p\b[^>]>([\s\S]?)</p>/gi; while ((m = pre.exec(clean))) { var w = wc(m[1]); if (w >= 5) ps.push(w); }
o.paraWords = ps; o.firstPara = ''; var fp = clean.match(/<p\b[^>]>([\s\S]?)</p>/gi) || [];
for (var i = 0; i < fp.length; i++) { if (wc_(fp[i]) >= 8 && !/cookie|privacy policy|accept all/i.test(fp[i])) { o.firstPara = plain_(fp[i]); break; } }
o.lists = (clean.match(/<(ul|ol|table)\b/gi) || []).length; o.hasOl = /<ol\b/i.test(clean);
o.digits = (plain_(clean).match(/\b\d[\d,.]*\b/g) || []).length;
return o;
}
function ck_(label, status, detail, tip, w) { return { label: label, status: status, detail: detail, tip: tip || '', w: w }; }
function finish_(checks) {
var tot = 0, got = 0;
checks.forEach(function (c) { tot += c.w; got += c.w * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0); });
var score = tot ? Math.round(100 * got / tot) : 0;
var grade = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Needs work' : 'Needs a lot of work';
var fails = checks.filter(function (c) { return c.status === 'fail'; }).length, warns = checks.filter(function (c) { return c.status === 'warn'; }).length;
return {
score: score,
grade: grade,
summary: fails + ' to fix, ' + warns + ' to improve, ' + checks.filter(function (c) { return c.status === 'pass'; }).length + ' passed.',
checks: checks.map(function (c) { return { label: c.label, status: c.status, detail: c.detail, tip: c.tip }; })
};
}
function sitemapFound_(ctx) {
var u = ctx.robots.sitemaps[0] || (ctx.pg.origin + '/sitemap.xml');
if (!/^https?:///i.test(u)) return false;
try { var r = get_(u, 60000); return r.code === 200 && /<urlset|<sitemapindex/i.test(r.text); } catch (e) { return false; }
}
function psi_(url) {
var key = PropertiesService.getScriptProperties().getProperty('PSI_API_KEY');
if (!key) return null;
try {
var api = 'googleapis.com' + encodeURIComponent(url) + '&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices&key=' + encodeURIComponent(key);
var r = UrlFetchApp.fetch(api, { muteHttpExceptions: true });
if (r.getResponseCode() !== 200) return null;
var j = JSON.parse(r.getContentText()), c = j.lighthouseResult.categories, a = j.lighthouseResult.audits;
var sc = function (x) { return x && x.score != null ? Math.round(x.score * 100) : null; };
return { performance: sc(c.performance), seo: sc(c.seo), accessibility: sc(c.accessibility), bestPractices: sc(c['best-practices']),
lcp: a['largest-contentful-paint'] && a['largest-contentful-paint'].displayValue, cls: a['cumulative-layout-shift'] && a['cumulative-layout-shift'].displayValue };
} catch (e) { return null; }
}
function band_(n, hi, mid) { return n >= hi ? 'pass' : n >= mid ? 'warn' : 'fail'; }
/* ---------------- Module Check Logic ---------------- */
function auditSeo_(ctx, ps) {
var i = ctx.info, pg = ctx.pg, c = [], tl = i.title.length, dl = (i.meta.description || '').length;
c.push(ck_('Secure connection (HTTPS)', pg.scheme === 'https' ? 'pass' : 'fail', pg.scheme === 'https' ? 'The page uses HTTPS.' : 'The page is not using HTTPS.', 'Install an SSL certificate.', 3));
c.push(ck_('Page title', !tl ? 'fail' : (tl >= 30 && tl <= 65) ? 'pass' : 'warn', tl ? tl + ' chars: "' + i.title.slice(0, 50) + '"' : 'No title tag found.', 'Optimize title to 30-65 chars.', 3));
c.push(ck_('Meta description', !dl ? 'fail' : (dl >= 70 && dl <= 165) ? 'pass' : 'warn', dl ? dl + ' chars.' : 'No description found.', 'Add a description to catch search click interest.', 3));
c.push(ck_('One main heading (H1)', i.h1.length === 1 ? 'pass' : i.h1.length === 0 ? 'fail' : 'warn', i.h1.length + ' H1 found.', 'Use exactly one distinct H1 tag.', 3));
c.push(ck_('Mobile viewport', i.meta.viewport ? 'pass' : 'fail', i.meta.viewport ? 'Viewport found.' : 'Missing viewport tag.', 'Add structural viewport meta code.', 2));
if (ps && ps.seo != null) { c.push(ck_('Lighthouse Core SEO', band_(ps.seo, 90, 70), 'Lighthouse SEO score is ' + ps.seo + '/100.', 'Review individual structural flaws listed by Lighthouse diagnostics.', 4)); }
return finish_(c);
}
function auditGeo_(ctx) {
var i = ctx.info, c = [], ld = i.ld;
var blocked = ctx.robotsFound ? KEY_BOTS.filter(function (b) { return botBlocked_(ctx.robots, b); }) : [];
c.push(ck_('AI crawlers allowed', blocked.length ? 'fail' : 'pass', blocked.length ? 'Blocking: ' + blocked.join(', ') : 'Major AI bots have index scanning authorization.', 'Unblock generative engine index agents.', 4));
var orgTypes = ['Organization', 'LocalBusiness', 'ProfessionalService'];
var hasOrg = ld.types.some(function (t) { return orgTypes.indexOf(t) > -1; });
c.push(ck_('Organization schema', hasOrg ? 'pass' : 'fail', hasOrg ? 'Found entity schema profile.' : 'Missing Organization structured mapping markup.', 'Implement clean valid JSON-LD schemas.', 3));
return finish_(c);
}
function auditAeo_(ctx) {
var i = ctx.info, c = [], ld = i.ld;
var hasFaq = ld.types.indexOf('FAQPage') > -1 || ld.types.indexOf('QAPage') > -1;
c.push(ck_('FAQ schema', hasFaq ? 'pass' : 'fail', hasFaq ? 'FAQ structures mapped.' : 'No active QA structural graphs found.', 'Inject semantic answer properties into high importance content sections.', 4));
c.push(ck_('Lists and tables', i.lists >= 2 ? 'pass' : i.lists ? 'warn' : 'fail', i.lists + ' format items found.', 'Incorporate clear layouts to make snippet engine capture seamless.', 2));
return finish_(c);
}
