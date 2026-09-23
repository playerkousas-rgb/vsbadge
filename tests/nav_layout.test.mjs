// 導覽列排版守護：三組按鈕（主要／領袖專屬／常用）
// 桌面一行過；手機直向堆疊（不會被切走）並固定置頂（拉下都唔會唔見）。
// 只檢查靜態檔，不需瀏覽器；確保日後改動不會令手機把常用按鈕切走或把領袖按鈕混入共用行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const nav = html.slice(html.indexOf('<div class="nav-tabs" id="mainNavTabs">'), html.indexOf('<div id="tab-progress"'));

function group(name) {
  const start = nav.indexOf('nav-group-' + name);
  assert(start > -1, '導覽缺少 nav-group-' + name);
  const open = nav.lastIndexOf('<div', start);
  const end = nav.indexOf('</div>', start);
  assert(end > open, '導覽群組結構有問題：' + name);
  return nav.slice(open, end);
}

test('導覽分成主要（我嘅進度）、領袖專屬及常用三組，桌面全部一行過', () => {
  assert(!nav.includes('nav-break'), '桌面不應再分兩行（不應有第一／第二行分隔線 nav-break）');
  assert.match(group('main'), /id="btn-tab-progress"/);
  assert.match(group('main'), /id="btn-tab-overview"/, '全團總覽應與我的進度同組（團長開放時成員亦可見）');
  assert.match(group('manage'), /id="btn-tab-users"/);
  assert.match(group('manage'), /display:none/, '領袖專屬按鈕須預設隱藏，由 applyNavVisibility 按角色顯示');
  for (const id of ['requests', 'logs', 'forms', 'help', 'info']) {
    assert.match(group('shared'), new RegExp('id="btn-tab-' + id + '"'), '常用按鈕 ' + id + ' 應在共用組內');
    assert(!group('manage').includes('btn-tab-' + id), '常用按鈕 ' + id + ' 不可放入領袖專屬組');
  }
  // 桌面：.nav-tabs 基礎規則不得轉直向（否則又變回多行），並保留 sticky 頂部
  const base = html.slice(html.indexOf('.nav-tabs{'), html.indexOf('.nav-tabs{') + 400);
  assert(!/flex-direction:column/.test(base), '桌面導覽須保持一行過（不可 flex-direction:column）');
  assert(/position:sticky/.test(base), '桌面導覽須 sticky 置頂');
});

test('手機版：主要／常用在上面平分，領袖專屬移到最下面（不會被切走），並固定置頂', () => {
  const start = html.indexOf('@media(max-width:768px)');
  const end = html.indexOf('@media(max-width:420px)', start);
  const mobile = html.slice(start, end > start ? end : undefined);
  assert(start > -1 && end > start, '找不到手機版 @media(max-width:768px) 區塊');
  assert(/\.nav-tabs\{[^}]*flex-direction:column/.test(mobile), '手機版導覽須轉為垂直堆疊（不再橫向滾動，免被切走）');
  assert(!/overflow-x:auto/.test(html.slice(html.indexOf('.nav-tabs{'), html.indexOf('.nav-tabs{') + 300)), '導覽不可再靠橫向滾動');
  assert(/\.nav-tabs\{[^}]*position:sticky[^}]*top:0/.test(mobile), '手機版導覽須 sticky 固定置頂（拉下都唔會唔見）');
  assert(/\.nav-group-main\{order:1/.test(mobile), '主要按鈕應排最上');
  assert(/\.nav-group-shared\{order:2/.test(mobile), '常用按鈕應排中段');
  assert(/\.nav-group-manage\{order:3/.test(mobile), '領袖專屬應排最下');
});

test('導覽顯示邏輯集中在 applyNavVisibility，並會收合沒有可見按鈕的行', () => {
  assert(html.includes('function applyNavVisibility()'), '缺少 applyNavVisibility');
  assert(html.includes('function syncNavRows()'), '缺少 syncNavRows');
  assert(/loadAppConfig[\s\S]{0,600}applyNavVisibility\(\)/.test(html), '系統設定載入後須重新同步導覽（私隱開關影響全團總覽）');
  const callers = html.split('applyNavVisibility()').length - 1;
  assert(callers >= 3, 'applyNavVisibility 應由登入／session／設定載入等路徑呼叫');
});
