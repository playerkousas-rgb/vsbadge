// 「🌿 系統介紹」分頁守護：首頁分頁雙向切換（含不帶按鈕參數的交叉連結）、
// 中英鍵完整並經真實 setLang 渲染、安全邊界字眼、通用介紹圖可部署下載、
// 介紹內容絕不披露任何隱藏／保留帳號資訊。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { accountId } from '../scripts/runtime-config.mjs';

const html = fs.readFileSync('index.html', 'utf8');
const gas = fs.readFileSync('apps-script/Code.gs', 'utf8');
const intro = html.match(/<section id="welcome-intro"[\s\S]*?<\/section>/)?.[0] || '';

function sliceFn(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, '找不到 ' + startMarker);
  const next = source.indexOf('\nfunction ', start + startMarker.length);
  assert.ok(next > start, '找不到函數結尾 ' + startMarker);
  return source.slice(start, next);
}
function extractI18N() {
  const start = html.indexOf('const I18N={');
  const end = html.indexOf('function i18n(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(html.slice(start, end) + '\n;I18N', {});
}

test('系統介紹有獨立分頁、部署指南雙向入口，圖檔在可部署的 assets 並支援放大／下載', () => {
  assert.ok(intro, '缺少系統介紹分頁');
  assert.match(html, /data-tab="intro" onclick="showWelcomeTab\('intro', this\)" data-i18n="nav\.intro"/);
  assert.match(intro, /showWelcomeTab\('setup'\)/, '介紹 → 部署教學入口');
  // 中文 DOM 及英文 WELCOME_EN 模板各一組部署 → 介紹入口
  assert.equal(html.split('class="setup-intro-link"').length - 1, 2);
  assert.equal(html.split("showWelcomeTab('intro')").length - 1, 2);
  assert.match(html, /查看系統介紹/);
  assert.match(html, /Read system introduction/);

  const asset = 'assets/system-introduction-zh-hant.webp';
  assert.match(intro, /<img[^>]*src="assets\/system-introduction-zh-hant\.webp"[^>]*width="768" height="1376"[^>]*loading="lazy"/);
  assert.match(intro, /data-i18n-attr="alt" data-i18n="intro\.imageAlt"/);
  assert.match(intro, /<a class="btn btn-outline btn-sm" href="assets\/system-introduction-zh-hant\.webp" download="system-introduction-zh-hant\.webp"/);
  assert.match(intro, /target="_blank" rel="noopener noreferrer"/, '點圖放大');
  const image = fs.readFileSync(asset);
  assert.equal(image.toString('ascii', 0, 4), 'RIFF');
  assert.equal(image.toString('ascii', 8, 12), 'WEBP');
  assert.ok(image.length > 100000, '沿用通用介紹圖原檔，唔係佔位圖');

  // 圖檔及 Code.gs 下載不得被部署忽略；本地預覽伺服器須提供 image/webp
  const ignoreLines = fs.readFileSync('.vercelignore', 'utf8').split(/\r?\n/).map(s => s.trim());
  for (const pattern of ['assets', 'assets/', 'apps-script', 'apps-script/', '*.webp']) {
    assert.ok(!ignoreLines.includes(pattern), `.vercelignore 唔准排除 ${pattern}`);
  }
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /\['index\.html', 'assets', 'data', 'docs', 'apps-script'/, 'Vercel build 必須複製 assets 及 apps-script');
  assert.match(fs.readFileSync('tests/dev-server.mjs', 'utf8'), /'\.webp': 'image\/webp'/);
  assert.equal(html.split('apps-script/Code.gs?gs=v9.2').length - 1, 2, '中英下載參數同步最新 GS 版本');
  assert.ok(html.includes('apps-script/Code.gs?gs=${LATEST_RELEASE.gsVersion}'), '版本公告下載參數跟 LATEST_RELEASE');
});

test('介紹中英說明完整、保留安全邊界，而且冇披露隱藏帳號資訊', () => {
  const I18N = extractI18N();
  const keys = [...new Set([...intro.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]))];
  assert.ok(keys.length >= 10, '介紹分頁應有完整 i18n 鍵');
  for (const key of [...keys, 'nav.intro']) {
    assert.equal(typeof I18N.zh[key], 'string', `zh 缺 ${key}`);
    assert.ok(I18N.zh[key].length > 0);
    assert.equal(typeof I18N.en[key], 'string', `en 缺 ${key}`);
    assert.ok(I18N.en[key].length > 0);
  }
  assert.equal(I18N.zh['intro.h2'], '支部進度追蹤系統', '圖頂通用名稱維持，四個支部共用');
  assert.equal(I18N.en['intro.h2'], 'Section Progress Tracking System');
  assert.equal(I18N.en['nav.intro'], '🌿 System introduction');
  assert.match(I18N.zh['intro.data'], /網站及伺服器轉接/);
  assert.match(I18N.en['intro.data'], /relay requests to your troop/);
  assert.match(I18N.zh['intro.authP'], /權限確實較廣/);
  assert.match(I18N.zh['intro.authP'], /毋須交出 Google 密碼/);
  assert.match(I18N.en['intro.authP'], /Never hand over your Google password/);
  assert.match(I18N.zh['intro.sheetP'], /不是試算表的分享設定/);
  assert.match(I18N.en['intro.sheetP'], /not sharing of the spreadsheet file/);
  assert.match(I18N.zh['intro.loginP'], /每次均核實帳號及密碼/);
  assert.match(I18N.en['intro.loginP'], /Each password sign-in checks the account and password/);
  assert.match(I18N.zh['intro.loginP'], /不是個人登入密碼/, '唔准把 API Key 當作個人登入驗證');
  assert.match(I18N.en['intro.loginP'], /not a personal login password/);
  // 安全邊界：已核實深資同樣有未受登入保護的舊讀取入口，介紹不可宣稱全部讀取已受保護
  assert.match(I18N.zh['intro.caution'], /仍待補強/);
  assert.match(I18N.zh['intro.caution'], /並非獨立安全認證/);
  assert.match(I18N.en['intro.caution'], /still need strengthening/);
  assert.match(I18N.en['intro.caution'], /not an independent security certification/);
  assert.match(I18N.zh['intro.imageCaption'], /繁體中文說明圖/, '須標示圖片語言');
  assert.match(I18N.en['intro.imageCaption'], /Traditional Chinese diagram/);

  const publicText = [intro, ...Object.values(I18N.zh), ...Object.values(I18N.en)]
    .filter(v => typeof v === 'string').join('\n').toLowerCase();
  // 只檢查介紹相關內容：intro 段 + intro/nav.intro 鍵值
  const introTexts = [intro, ...keys.flatMap(k => [I18N.zh[k], I18N.en[k]]), I18N.zh['nav.intro'], I18N.en['nav.intro']]
    .join('\n').toLowerCase();
  assert.ok(!introTexts.includes(accountId), '公開介紹唔准包含隱藏帳號識別字');
  assert.doesNotMatch(introTexts, /super[ _-]?admin|super_key|\/api\/super/, '公開介紹唔准披露保留帳號資訊');
  assert.ok(!publicText.includes('system-introduction') || intro.length > 0); // sanity：intro 已抽取成功

  assert.doesNotMatch(gas, /ui\.prompt\('旅團編號'|addItem\('設定旅團編號'/, 'GS 唔准新增旅團編號設定提示');
});

test('首頁分頁雙向切換：交叉連結（不帶按鈕）同時選中正確 section 及 nav 按鈕；切語言不轉分頁', () => {
  const names = ['enter', 'intro', 'setup', 'guide'];
  const makeClassList = () => {
    const set = new Set();
    return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
  };
  const sections = {};
  for (const n of [...names, 'changelog']) sections[n] = { id: 'welcome-' + n, innerHTML: 'ZH-' + n, classList: makeClassList() };
  const buttons = names.map(n => ({ tab: n, classList: makeClassList(), textContent: '' }));
  // 以介紹分頁實際使用的 i18n 鍵建立假元素，行真 applyStaticI18n
  const introKeys = [...new Set([...intro.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]))];
  const copies = introKeys.map(key => ({
    key,
    innerHTML: '',
    attrs: {},
    getAttribute(name) {
      if (name === 'data-i18n') return key;
      if (name === 'data-i18n-attr') return key === 'intro.imageAlt' ? 'alt' : null;
      return null;
    },
    setAttribute(name, value) { this.attrs[name] = value; }
  }));
  const byKey = Object.fromEntries(copies.map(el => [el.key, el]));
  const documentStub = {
    documentElement: { lang: '' },
    getElementById(id) {
      if (id.startsWith('welcome-')) return sections[id.replace('welcome-', '')] || null;
      return null;
    },
    querySelector(selector) {
      const tab = selector.match(/^\.welcome-nav button\[data-tab="([^"]+)"\]$/);
      if (tab) return buttons[names.indexOf(tab[1])] || null;
      return null; // title 等
    },
    querySelectorAll(selector) {
      if (selector === '.welcome-section') return Object.values(sections);
      if (selector === '.welcome-nav button') return buttons;
      if (selector === '[data-i18n]') return copies;
      return [];
    }
  };
  const context = vm.createContext({
    document: documentStub,
    localStorage: { getItem: () => null, setItem: () => {} },
    // setLang 內部 try 會因假 DOM 缺 updateSaveBar 而 warn（真程式已自行 catch）；靜音免污染測試輸出
    console: { ...console, warn: () => {} }
  });
  const i18nStart = html.indexOf('const I18N={');
  const prelude = "const LANG_KEY='vsbadge_lang'; let currentLang='zh';\n";
  const i18nBlock = html.slice(i18nStart, html.indexOf('function i18n(', i18nStart));
  const welcomeStart = html.indexOf('const WELCOME_HTML_CACHE={};');
  const welcomeBlock = html.slice(welcomeStart, html.indexOf('function localizeLongWelcome(){', welcomeStart));
  // setLang 之後緊接 WELCOME_HTML_CACHE／WELCOME_EN 常數（非 function），要切到常數宣告止
  const setLangStart = html.indexOf('function setLang(lang){');
  const setLangBlock = html.slice(setLangStart, html.indexOf('const WELCOME_HTML_CACHE={};', setLangStart));
  const script = [
    prelude,
    i18nBlock,
    sliceFn(html, 'function i18n(key, vars){'),
    sliceFn(html, 'function applyStaticI18n(){'),
    sliceFn(html, 'function syncLangToggle(){'),
    setLangBlock,
    welcomeBlock,
    sliceFn(html, 'function localizeLongWelcome(){'),
    sliceFn(html, 'function showWelcomeTab(name, btn){')
  ].join('\n');
  vm.runInContext(script, context);
  const run = code => vm.runInContext(code, context);

  run("showWelcomeTab('enter')");
  for (const name of ['intro', 'setup', 'guide', 'enter', 'intro']) {
    run(`showWelcomeTab('${name}')`);
    assert.deepEqual(names.map(n => sections[n].classList.contains('active')), names.map(n => n === name),
      `交叉連結 showWelcomeTab('${name}') 只顯示對應 section`);
    assert.deepEqual(buttons.map(b => b.classList.contains('active')), names.map(n => n === name),
      `交叉連結 showWelcomeTab('${name}') 同時選中對應 nav 按鈕`);
  }
  // 帶按鈕參數的常規點擊照舊
  context.showWelcomeTab('setup', buttons[2]);
  assert.ok(sections.setup.classList.contains('active') && buttons[2].classList.contains('active'));
  run("showWelcomeTab('intro')");

  run("setLang('en')");
  assert.equal(documentStub.documentElement.lang, 'en');
  assert.equal(byKey['intro.h2'].innerHTML, 'Section Progress Tracking System');
  assert.match(byKey['intro.authP'].innerHTML, /Google password/);
  assert.match(byKey['intro.caution'].innerHTML, /still need strengthening/);
  assert.match(byKey['intro.imageAlt'].attrs.alt, /private Google Sheet/);
  assert.ok(sections.intro.classList.contains('active'), '切語言唔准轉走已選分頁');
  assert.match(sections.setup.innerHTML, /Read system introduction/, '英文部署頁保留介紹入口');

  run("setLang('zh')");
  assert.equal(byKey['intro.h2'].innerHTML, '支部進度追蹤系統');
  assert.match(byKey['intro.caution'].innerHTML, /仍待補強/);
  assert.ok(sections.intro.classList.contains('active'));
  assert.equal(sections.setup.innerHTML, 'ZH-setup', '切回中文還原原頁（介紹入口在原 DOM 內）');
});
