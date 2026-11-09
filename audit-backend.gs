/**
 * Tavlo Studio — free SEO / GEO / AEO audit backend (Google Apps Script)
 * Deploy as a Web app (Execute as: Me, Who has access: Anyone).
 * Secret (set in Project Settings > Script properties):  PSI_API_KEY  (Google PageSpeed Insights API key)
 */
var CONFIG = {
  DAILY_LIMIT: 300,            // max audits per day (protects your free quota)
  CACHE_SECONDS: 21600,        // reuse the same result for 6 hours
  UA: 'Mozilla/5.0 (compatible; TavloAuditBot/1.0; +https://tavlostudio.github.io)'
};
var AI_BOTS = ['GPTBot','OAI-SearchBot','ChatGPT-User','ClaudeBot','Claude-SearchBot','PerplexityBot','Google-Extended','Applebot-Extended','CCBot'];
var KEY_BOTS = ['GPTBot','OAI-SearchBot','ChatGPT-User','ClaudeBot','PerplexityBot','Google-Extended'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.ping) return json_({ ok: true });
    var type = String(p.type || '').toLowerCase();
    if (['seo', 'geo', 'aeo'].indexOf(type) < 0) return json_({ error: 'Unknown audit type.' });
    var pg = parseUrl_(p.url);
    if (!pg) return json_({ error: 'Please enter a valid public website address, for example https://example.com' });

    var cache = CacheService.getScriptCache();
    var key = 'a1:' + type + ':' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, pg.url));
    var hit = cache.get(key);
    if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);

    if (!underLimit_()) return json_({ error: 'The free audit tool is busy right now. Please try again later, or contact us for a manual audit.' });

    var page = get_(pg.url, 1500000);
    if (page.code >= 400 || page.code === 0) return json_({ error: 'We could not open that page (the site answered with status ' + page.code + ').' });
    var info = parsePage_(page.text, pg);
    var robotsRes = get_(pg.origin + '/robots.txt', 200000);
    var robots = parseRobots_(robotsRes.code === 200 && /user-agent|sitemap|disallow/i.test(robotsRes.text) ? robotsRes.text : '');
    var ctx = { pg: pg, page: page, info: info, robots: robots, robotsFound: robotsRes.code === 200 && /user-agent|sitemap|disallow/i.test(robotsRes.text) };

    var result = type === 'seo' ? auditSeo_(ctx) : type === 'geo' ? auditGeo_(ctx) : auditAeo_(ctx);
    result.type = type; result.url = pg.url; result.checkedAt = new Date().toISOString();
    var out = JSON.stringify(result);
    try { cache.put(key, out, CONFIG.CACHE_SECONDS); } catch (x) {}
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var m = String((err && err.message) || err);
    if (/DNS|Address unavailable|Unable to resolve/i.test(m)) m = 'We could not find that website. Please check the address.';
    else m = 'The audit could not be completed (' + m.slice(0, 120) + ').';
    return json_({ error: m });
  }
}

/* ---------------- helpers ---------------- */
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
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;              // rejects IP addresses, localhost, IPv6
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
function botMentioned_(robots, bot) { var b = bot.toLowerCase(); return robots.groups.some(function (g) { return g.agents.indexOf(b) > -1; }); }

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
        if (n.speakable) o.ld.speakable = true;
        Object.keys(n).forEach(function (k) { walk(n[k]); });
      };
      walk(JSON.parse(m[1]));
    } catch (x) { o.ld.errors++; }
  }
  o.hasTime = /<time\b[^>]*datetime\s*=/i.test(html) || /article:(published|modified)_time|"dateModified"/i.test(html);
  var ps = []; var pre = /<p\b[^>]*>([\s\S]*?)<\/p>/gi; while ((m = pre.exec(clean))) { var w = wc_(m[1]); if (w >= 5) ps.push(w); }
  o.paraWords = ps; o.firstPara = ''; var fp = clean.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) || [];
  for (var i = 0; i < fp.length; i++) { if (wc_(fp[i]) >= 8 && !/cookie|privacy policy|accept all/i.test(fp[i])) { o.firstPara = plain_(fp[i]); break; } }
  o.lists = (clean.match(/<(ul|ol|table)\b/gi) || []).length; o.hasOl = /<ol\b/i.test(clean);
  o.digits = (plain_(clean).match(/\b\d[\d,.]*\b/g) || []).length;
  return o;
}

function ck_(label, status, detail, tip, w) { return { label: label, status: status, detail: detail, tip: tip || '', w: w }; }
function finish_(checks, extra) {
  var tot = 0, got = 0;
  checks.forEach(function (c) { tot += c.w; got += c.w * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0); });
  var score = tot ? Math.round(100 * got / tot) : 0;
  var grade = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Needs work' : 'Needs a lot of work';
  var fails = checks.filter(function (c) { return c.status === 'fail'; }).length, warns = checks.filter(function (c) { return c.status === 'warn'; }).length;
  var res = { score: score, grade: grade, summary: fails + ' to fix, ' + warns + ' to improve, ' + checks.filter(function (c) { return c.status === 'pass'; }).length + ' passed.',
    checks: checks.map(function (c) { return { label: c.label, status: c.status, detail: c.detail, tip: c.tip }; }) };
  if (extra) Object.keys(extra).forEach(function (k) { res[k] = extra[k]; });
  return res;
}
function sitemapFound_(ctx) {
  var u = ctx.robots.sitemaps[0] || (ctx.pg.origin + '/sitemap.xml');
  if (!/^https?:\/\//i.test(u)) return false;
  try { var r = get_(u, 60000); return r.code === 200 && /<urlset|<sitemapindex/i.test(r.text); } catch (e) { return false; }
}
function psi_(url) {
  var key = PropertiesService.getScriptProperties().getProperty('PSI_API_KEY');
  if (!key) return null;
  try {
    var api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' + encodeURIComponent(url) + '&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices&key=' + encodeURIComponent(key);
    var r = UrlFetchApp.fetch(api, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return { error: true };
    var j = JSON.parse(r.getContentText()), c = j.lighthouseResult.categories, a = j.lighthouseResult.audits;
    var sc = function (x) { return x && x.score != null ? Math.round(x.score * 100) : null; };
    return { performance: sc(c.performance), seo: sc(c.seo), accessibility: sc(c.accessibility), bestPractices: sc(c['best-practices']),
      lcp: a['largest-contentful-paint'] && a['largest-contentful-paint'].displayValue, cls: a['cumulative-layout-shift'] && a['cumulative-layout-shift'].displayValue };
  } catch (e) { return { error: true }; }
}
function band_(n, hi, mid) { return n >= hi ? 'pass' : n >= mid ? 'warn' : 'fail'; }

/* ---------------- SEO ---------------- */
function auditSeo_(ctx) {
  var i = ctx.info, pg = ctx.pg, c = [], tl = i.title.length, dl = (i.meta.description || '').length;
  c.push(ck_('Secure connection (HTTPS)', pg.scheme === 'https' ? 'pass' : 'fail', pg.scheme === 'https' ? 'The page uses HTTPS.' : 'The page is not using HTTPS.', 'Install an SSL certificate and redirect all pages to https://.', 3));
  c.push(ck_('Page title', !tl ? 'fail' : (tl >= 30 && tl <= 65) ? 'pass' : 'warn', tl ? tl + ' characters: "' + i.title.slice(0, 90) + '"' : 'No title tag found.', 'Write a unique title of about 30 to 65 characters with your main keyword and brand.', 3));
  c.push(ck_('Meta description', !dl ? 'fail' : (dl >= 70 && dl <= 165) ? 'pass' : 'warn', dl ? dl + ' characters.' : 'No meta description found.', 'Add a description of about 70 to 160 characters that explains the page and invites a click.', 3));
  c.push(ck_('One main heading (H1)', i.h1.length === 1 ? 'pass' : i.h1.length === 0 ? 'fail' : 'warn', i.h1.length + ' H1 heading(s) found' + (i.h1[0] ? ': "' + i.h1[0].text.slice(0, 80) + '"' : '.'), 'Use exactly one H1 that describes the page.', 3));
  c.push(ck_('Subheadings (H2)', i.h2.length >= 2 ? 'pass' : i.h2.length === 1 ? 'warn' : 'fail', i.h2.length + ' H2 heading(s) found.', 'Break the content into sections with clear H2 headings.', 2));
  c.push(ck_('Canonical tag', i.canonical ? 'pass' : 'warn', i.canonical ? 'Canonical: ' + i.canonical : 'No canonical tag found.', 'Add <link rel="canonical"> pointing to the preferred address of the page.', 2));
  var noindex = /noindex/i.test(i.meta.robots || '') || /noindex/i.test(String((ctx.page.headers['X-Robots-Tag'] || ctx.page.headers['x-robots-tag'] || '')));
  c.push(ck_('Page can be indexed', noindex ? 'fail' : 'pass', noindex ? 'The page tells search engines not to index it (noindex).' : 'No noindex instruction found.', 'Remove the noindex tag if you want this page to appear in search.', 4));
  c.push(ck_('Mobile viewport', i.meta.viewport ? 'pass' : 'fail', i.meta.viewport ? 'Viewport tag found.' : 'No viewport tag found.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', 2));
  c.push(ck_('Page language', i.hasLang ? 'pass' : 'warn', i.hasLang ? 'Language attribute found.' : 'No lang attribute on <html>.', 'Add lang="en" (or your language) to the <html> tag.', 1));
  var altOk = i.imgTotal ? (i.imgTotal - i.imgNoAlt) / i.imgTotal : 1;
  c.push(ck_('Image descriptions (alt text)', band_(altOk, 0.9, 0.6), i.imgTotal ? Math.round(altOk * 100) + '% of ' + i.imgTotal + ' images have alt text.' : 'No images found.', 'Add short, descriptive alt text to every meaningful image.', 2));
  c.push(ck_('Internal links', i.internal >= 3 ? 'pass' : i.internal ? 'warn' : 'fail', i.internal + ' internal link(s) found.', 'Link to your other important pages with descriptive link text.', 1));
  var og = ['og:title', 'og:description', 'og:image'].filter(function (k) { return i.meta[k]; }).length;
  c.push(ck_('Social sharing tags (Open Graph)', og === 3 ? 'pass' : og ? 'warn' : 'fail', og + ' of 3 tags found (title, description, image).', 'Add og:title, og:description and og:image so shared links look good.', 1));
  c.push(ck_('Structured data (schema)', i.ld.types.length ? 'pass' : 'warn', i.ld.types.length ? 'Found: ' + i.ld.types.slice(0, 6).join(', ') : 'No JSON-LD structured data found.', 'Add JSON-LD schema such as Organization, WebSite and FAQPage.', 2));
  var rb = ctx.robotsFound, blocked = rb && botBlocked_(ctx.robots, 'Googlebot');
  c.push(ck_('robots.txt', blocked ? 'fail' : rb ? 'pass' : 'warn', blocked ? 'robots.txt blocks search engines from the whole site.' : rb ? 'robots.txt found.' : 'No robots.txt found.', blocked ? 'Remove "Disallow: /" for search engines.' : 'Add a robots.txt file that points to your sitemap.', 2));
  var sm = sitemapFound_(ctx);
  c.push(ck_('XML sitemap', sm ? 'pass' : 'warn', sm ? 'Sitemap found.' : 'No XML sitemap found.', 'Create sitemap.xml and submit it in Google Search Console.', 2));
  c.push(ck_('Readable content in the page', i.words >= 300 ? 'pass' : i.words >= 100 ? 'warn' : 'fail', i.words + ' words found in the page source.', 'Add useful written content. If your site loads text with JavaScript, make sure it is also in the HTML.', 2));
  c.push(ck_('Server response time', ctx.page.ms < 1500 ? 'pass' : ctx.page.ms < 3000 ? 'warn' : 'fail', (ctx.page.ms / 1000).toFixed(1) + ' seconds to load the HTML.', 'Use faster hosting or caching, and compress images.', 1));
  var ps = psi_(pg.url), extra = {};
  if (ps && !ps.error) {
    if (ps.performance != null) c.push(ck_('Mobile speed (Google PageSpeed)', band_(ps.performance, 90, 50), 'Performance score ' + ps.performance + '/100' + (ps.lcp ? ', largest content paint ' + ps.lcp : '') + '.', 'Compress and resize images, reduce unused code and use caching.', 4));
    if (ps.seo != null) c.push(ck_('Google Lighthouse SEO checks', band_(ps.seo, 90, 70), 'Lighthouse SEO score ' + ps.seo + '/100.', 'Fix the basic SEO items listed above.', 2));
    extra.pagespeed = ps;
  } else extra.note = 'Mobile speed from Google PageSpeed was not available for this run.';
  return finish_(c, extra);
}

/* ---------------- GEO ---------------- */
function auditGeo_(ctx) {
  var i = ctx.info, pg = ctx.pg, c = [], ld = i.ld;
  var blocked = ctx.robotsFound ? KEY_BOTS.filter(function (b) { return botBlocked_(ctx.robots, b); }) : [];
  c.push(ck_('AI crawlers are allowed', blocked.length ? 'fail' : 'pass', blocked.length ? 'robots.txt blocks: ' + blocked.join(', ') : (ctx.robotsFound ? 'Major AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) are not blocked.' : 'No robots.txt found, so AI crawlers are allowed by default.'), 'Remove "Disallow: /" for AI crawlers you want citing you.', 4));
  var explicit = ctx.robotsFound && AI_BOTS.some(function (b) { return botMentioned_(ctx.robots, b); });
  c.push(ck_('Explicit rules for AI crawlers', explicit ? 'pass' : 'warn', explicit ? 'robots.txt names AI crawlers explicitly.' : 'robots.txt does not mention AI crawlers (optional).', 'List the AI crawlers you welcome (for example GPTBot, ClaudeBot, PerplexityBot) with "Allow: /".', 1));
  var llms = { code: 0, text: '' }; try { llms = get_(pg.origin + '/llms.txt', 100000); } catch (e) {}
  var llmsOk = llms.code === 200 && !/^\s*<(!doctype|html)/i.test(llms.text) && llms.text.length > 20, llmsLinks = llmsOk && /\]\(https?:\/\//.test(llms.text);
  c.push(ck_('llms.txt file', llmsLinks ? 'pass' : llmsOk ? 'warn' : 'fail', llmsLinks ? 'llms.txt found with links.' : llmsOk ? 'llms.txt found but it has no Markdown links.' : 'No llms.txt found. (This is an emerging convention, not a guaranteed ranking factor.)', 'Add /llms.txt: a short Markdown summary of your business with [name](url) links to key pages.', 2));
  var orgTypes = ['Organization', 'LocalBusiness', 'ProfessionalService', 'Corporation', 'OnlineStore', 'Store'];
  var hasOrg = ld.types.some(function (t) { return orgTypes.indexOf(t) > -1; });
  c.push(ck_('Organization schema', hasOrg ? 'pass' : 'fail', hasOrg ? 'Organization-type schema found.' : 'No Organization or LocalBusiness schema found.', 'Add JSON-LD Organization schema with your name, logo, contact and sameAs links.', 3));
  var hasPerson = ld.types.indexOf('Person') > -1 || ld.author;
  c.push(ck_('Person / author schema', hasPerson ? 'pass' : 'warn', hasPerson ? 'Person or author information found.' : 'No Person or author schema found.', 'Add Person schema for your founder or authors, with credentials and profile links.', 2));
  c.push(ck_('Brand profiles linked (sameAs)', ld.sameAs >= 3 ? 'pass' : ld.sameAs ? 'warn' : 'fail', ld.sameAs + ' sameAs link(s) found.', 'Link your LinkedIn, social, directory and review profiles in schema sameAs.', 2));
  c.push(ck_('Structured data is valid JSON', ld.blocks && !ld.errors ? 'pass' : ld.blocks ? 'warn' : 'fail', ld.blocks ? (ld.errors ? ld.errors + ' structured data block(s) could not be read.' : ld.blocks + ' structured data block(s) read correctly.') : 'No structured data found.', 'Validate your schema in Google Rich Results Test and fix errors.', 2));
  c.push(ck_('Content visible without JavaScript', i.words >= 300 ? 'pass' : i.words >= 100 ? 'warn' : 'fail', i.words + ' words are in the page source. Many AI crawlers do not run JavaScript.', 'Make sure your main text is in the HTML the server sends, not only added by scripts.', 3));
  c.push(ck_('Contact details visible', i.hasContactLink ? 'pass' : 'warn', i.hasContactLink ? 'Email or phone link found.' : 'No email or phone link found.', 'Show clear contact details so AI tools can trust and describe your business.', 2));
  c.push(ck_('Freshness signals', ld.dates || i.hasTime ? 'pass' : 'warn', ld.dates || i.hasTime ? 'Publish or update dates found.' : 'No publish or update dates found.', 'Add datePublished and dateModified in schema and show "Last updated" on the page.', 2));
  c.push(ck_('Links to outside sources', i.external >= 3 ? 'pass' : i.external ? 'warn' : 'fail', i.external + ' outbound link(s) found.', 'Cite or link to trustworthy sources, profiles and references.', 1));
  c.push(ck_('Specific facts in the content', i.digits >= 10 ? 'pass' : i.digits >= 3 ? 'warn' : 'fail', i.digits + ' numbers, dates or prices found.', 'Include concrete facts (prices, timelines, locations, dates) that AI tools can quote.', 1));
  c.push(ck_('Secure connection (HTTPS)', pg.scheme === 'https' ? 'pass' : 'fail', pg.scheme === 'https' ? 'HTTPS in use.' : 'Not using HTTPS.', 'Move to HTTPS.', 1));
  var sm = sitemapFound_(ctx);
  c.push(ck_('XML sitemap', sm ? 'pass' : 'warn', sm ? 'Sitemap found.' : 'No XML sitemap found.', 'Publish sitemap.xml so crawlers find all your pages.', 1));
  return finish_(c, { note: 'GEO (generative engine optimization) is about being understood and cited by AI assistants. These checks look at the signals AI crawlers can read. They do not guarantee citations.' });
}

/* ---------------- AEO ---------------- */
function auditAeo_(ctx) {
  var i = ctx.info, c = [], ld = i.ld, qs = i.questions;
  var seen = {}; qs = qs.filter(function (q) { if (seen[q.text]) return false; seen[q.text] = 1; return true; });
  var hasFaq = ld.types.indexOf('FAQPage') > -1 || ld.types.indexOf('QAPage') > -1;
  c.push(ck_('FAQ schema', hasFaq ? 'pass' : 'fail', hasFaq ? 'FAQPage structured data found.' : 'No FAQPage structured data found.', 'Add FAQPage JSON-LD for the real questions customers ask. The answers must also be visible on the page.', 4));
  c.push(ck_('Question-style headings', qs.length >= 3 ? 'pass' : qs.length ? 'warn' : 'fail', qs.length + ' question(s) found as headings or FAQ items.', 'Write headings as real questions (for example "How much does a Shopify store cost?").', 3));
  var good = 0, checked = 0;
  qs.slice(0, 10).forEach(function (q) {
    var sub = i.clean.slice(q.end, q.end + 4000), m = sub.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (m) { checked++; var w = wc_(m[1]); if (w >= 15 && w <= 90) good++; }
  });
  c.push(ck_('Short direct answers', !checked ? 'fail' : good / checked >= 0.5 ? 'pass' : good ? 'warn' : 'fail', checked ? good + ' of ' + checked + ' answers are a concise 15 to 90 words.' : 'No answers found under question headings.', 'Put a 1 to 3 sentence direct answer straight under each question, then add detail.', 3));
  c.push(ck_('Lists and tables', i.lists >= 2 ? 'pass' : i.lists ? 'warn' : 'fail', i.lists + ' list(s) or table(s) found.', 'Use bulleted lists, numbered steps and tables so answers can be lifted as snippets.', 2));
  var avg = i.paraWords.length ? Math.round(i.paraWords.reduce(function (a, b) { return a + b; }, 0) / i.paraWords.length) : 0;
  c.push(ck_('Short, scannable paragraphs', !avg ? 'fail' : avg <= 70 ? 'pass' : avg <= 110 ? 'warn' : 'fail', avg ? 'Paragraphs average ' + avg + ' words.' : 'No paragraphs found.', 'Keep paragraphs to a few sentences.', 1));
  var hasHow = ld.types.indexOf('HowTo') > -1 || i.hasOl;
  c.push(ck_('Step-by-step content', hasHow ? 'pass' : 'warn', hasHow ? 'HowTo schema or numbered steps found.' : 'No numbered steps or HowTo schema found.', 'For how-to topics, add numbered steps (and HowTo schema where it fits).', 1));
  var def = /\b(is|are|means|refers to|offers|provides)\b/i.test(i.firstPara.split(' ').slice(0, 40).join(' '));
  c.push(ck_('Clear definition near the top', def ? 'pass' : 'warn', i.firstPara ? 'Opening: "' + i.firstPara.slice(0, 120) + (i.firstPara.length > 120 ? '…' : '') + '"' : 'No opening paragraph found.', 'Start with a plain statement such as "X is a ... that helps ... to ...".', 2));
  var author = ld.author || ld.types.indexOf('Person') > -1 || /rel\s*=\s*["']author/i.test(i.clean) || /\bby\s+[A-Z][a-z]+/.test(i.firstPara);
  c.push(ck_('Author or expert signal', author ? 'pass' : 'warn', author ? 'Author or person information found.' : 'No author or expert information found.', 'Show who wrote or runs the page, with credentials.', 2));
  c.push(ck_('Page title and description', i.title && i.meta.description ? 'pass' : 'warn', i.title && i.meta.description ? 'Title and description present.' : 'Title or meta description missing.', 'Write a clear title and a one-sentence description that answers the page topic.', 1));
  c.push(ck_('Speakable markup (optional)', ld.speakable ? 'pass' : 'warn', ld.speakable ? 'Speakable markup found.' : 'No speakable markup (optional).', 'Optional: mark the best summary sections with speakable schema.', 1));
  c.push(ck_('Content depth', i.words >= 500 ? 'pass' : i.words >= 250 ? 'warn' : 'fail', i.words + ' words in the page source.', 'Cover the topic thoroughly with real detail, not filler.', 1));
  return finish_(c, { note: 'AEO (answer engine optimization) is about being the clear, direct answer in search answer boxes and AI assistants. These checks do not guarantee featured answers.' });
}
