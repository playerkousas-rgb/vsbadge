const assert = require('assert');
require('../assets/ymis-parse.js');
const Y = globalThis.YmisParse;
if (!Y) throw new Error('YmisParse not loaded from assets/ymis-parse.js');

function run() {
  console.log('=== YMIS PDF / 文字解析測試 ===\n');

  // Test 1: pdf.js text items（3 欄：編號 / 中文姓名 / 電郵）
  console.log('Test 1: pdf.js items → 成員');
  const items = [
    { str: '童軍成員編號', x: 50, y: 700, width: 60 },
    { str: '中文姓名', x: 200, y: 700, width: 40 },
    { str: '電郵地址', x: 350, y: 700, width: 40 },
    { str: '1234560001', x: 50, y: 680, width: 55 },
    { str: '陳大文', x: 200, y: 680, width: 30 },
    { str: 'chan@example.org', x: 350, y: 680, width: 80 },
    { str: '1234560002', x: 50, y: 660, width: 55 },
    { str: '李小明', x: 200, y: 660, width: 30 },
    { str: 'lee@example.org', x: 350, y: 660, width: 80 },
    { str: '第 1 頁', x: 50, y: 40, width: 30 }
  ];
  const r1 = Y.parseItems(items);
  assert.strictEqual(r1.members.length, 2, '應解析出 2 名成員');
  assert.deepStrictEqual(r1.members[0], {
    ymis: '1234560001', name: '陳大文', email: 'chan@example.org', warn: [], raw: r1.members[0].raw
  });
  assert.strictEqual(r1.members[1].name, '李小明');
  console.log('  [PASS] 抬頭/頁尾略過，3 欄對應正確');

  // Test 2: 同一欄被 pdf.js 拆成多個 item（字距小 → 應合併成一個儲存格）
  console.log('\nTest 2: 拆碎的中文姓名要合併');
  const split = [
    { str: '1234560003', x: 50, y: 600, width: 55 },
    { str: '張', x: 200, y: 600, width: 10 },
    { str: '美', x: 210, y: 600, width: 10 },
    { str: '玲', x: 220, y: 600, width: 10 },
    { str: 'cheung@example.org', x: 350, y: 600, width: 80 }
  ];
  const r2 = Y.parseItems(split);
  assert.strictEqual(r2.members[0].name, '張美玲');
  console.log('  [PASS] 合併為「張美玲」');

  // Test 3: 純文字貼上（多空格 / TAB 分隔）
  console.log('\nTest 3: 貼上文字解析');
  const text = [
    '童軍成員編號  中文姓名  電郵地址',
    '1234560004\t王志強\twong@example.org',
    '1234560005   黃淑儀   ',
    'rubbish line without number'
  ].join('\n');
  const r3 = Y.parseText(text);
  assert.strictEqual(r3.members.length, 2);
  assert.strictEqual(r3.members[1].email, '');
  assert.ok(r3.members[1].warn.includes('no_email'));
  assert.ok(r3.skipped.some(s => s.reason === 'no_ymis'));
  console.log('  [PASS] 缺電郵有 warn，無編號的行被略過');

  // Test 4: 重複 YMIS 只取一次
  console.log('\nTest 4: 重複編號');
  const r4 = Y.parseText('1234560006 林俊傑 lam@example.org\n1234560006 林俊傑 lam@example.org');
  assert.strictEqual(r4.members.length, 1);
  assert.strictEqual(r4.skipped[0].reason, 'duplicate');
  console.log('  [PASS] 重複列被略過');

  // Test 5: 非 10 位編號 → warn，可選補零
  console.log('\nTest 5: 編號長度');
  const r5 = Y.parseText('2885846 陳小強 keung@example.org');
  assert.ok(r5.members[0].warn.includes('ymis_len'));
  const r5b = Y.parseText('2885846 陳小強 keung@example.org', { padTo10: true });
  assert.strictEqual(r5b.members[0].ymis, '0002885846');
  assert.deepStrictEqual(r5b.members[0].warn, []);
  assert.strictEqual(Y.padTo10('M28858467'.replace(/\D/g, '')), '0028858467');
  console.log('  [PASS] 長度不足會提示，亦可自動補零至 10 位');

  // Test 6: 整列被合併成單一 item 的備援解析
  console.log('\nTest 6: 單一 item 備援');
  const r6 = Y.parseItems([{ str: '1234560007 何詩敏 ho@example.org', x: 50, y: 500, width: 200 }]);
  assert.strictEqual(r6.members.length, 1);
  assert.strictEqual(r6.members[0].name, '何詩敏');
  assert.strictEqual(r6.members[0].email, 'ho@example.org');
  console.log('  [PASS] 單 item 亦可還原 3 欄');

  console.log('\n=== 全部通過 ===');
}

run();

/* =============================================================
 * 真實 YMIS 自訂報表版面測試（依領袖提供的報表截圖版面重建；姓名／電郵已改為虛構測試資料）
 * 版面：香港童軍總會 / Scout Association of Hong Kong / 82nd Hong Kong Group
 *       欄名為中英雙行：童軍成員編號 Scout ID / 中文姓名 Name in Chinese / 電郵地址 Email
 *       成員編號為 10 位數（20xx 開頭），部分帶「*」標記，部分成員無電郵
 * ============================================================= */
function runRealLayout() {
  console.log('\n=== 真實 YMIS 報表版面（多頁）測試 ===\n');

  const header = (yTop) => ([
    { str: '香港童軍總會', x: 250, y: yTop, width: 60 },
    { str: 'Scout Association of Hong Kong', x: 230, y: yTop - 18, width: 130 },
    { str: '82nd Hong Kong Group', x: 250, y: yTop - 42, width: 100 },
    { str: '童軍成員編號', x: 50, y: yTop - 70, width: 60 },
    { str: '中文姓名', x: 250, y: yTop - 70, width: 40 },
    { str: '電郵地址', x: 450, y: yTop - 70, width: 40 },
    { str: 'Scout ID', x: 50, y: yTop - 84, width: 40 },
    { str: 'Name in Chinese', x: 250, y: yTop - 84, width: 70 },
    { str: 'Email', x: 450, y: yTop - 84, width: 30 }
  ]);
  const dataRow = (id, name, email, y) => {
    const cells = [{ str: id, x: 50, y, width: 55 }];
    // 中文姓名常被 pdf.js 逐字拆開
    name.split('').forEach((ch, i) => cells.push({ str: ch, x: 250 + i * 12, y, width: 12 }));
    if (email) cells.push({ str: email, x: 450, y, width: 100 });
    return cells;
  };

  // 第 1 頁
  const page1 = [].concat(
    header(760),
    dataRow('2019051156', '陳大文', 'a.chan@example.com', 640),
    dataRow('2019072178', '梁小明', 'b.leung@example.com', 615),
    dataRow('2019096664', '梁志文', '', 590),
    dataRow('2019108618', '彭小晴', 'c.pang@example.com', 565),
    dataRow('2019168125', '王家安', 'd.wong@example.edu.hk', 540),
    [{ str: 'Page 1 of 2', x: 480, y: 40, width: 50 }]
  );

  // 第 2 頁：抬頭 / 欄名重複；帶「*」標記；長電郵被換行拆到下一行
  const page2 = [].concat(
    header(760),
    dataRow('2019259338 *', '劉子彤', '', 640),
    [{ str: 'e.lau@example.com', x: 450, y: 628, width: 100 }], // 續行電郵
    dataRow('2019266200', '黎子柏', '', 600),
    dataRow('2019266390', '徐家駿', '', 575),
    dataRow('2026036356', '徐頌文', '', 550),
    [{ str: '第 2 頁，共 2 頁', x: 480, y: 40, width: 60 }],
    [{ str: '202608210505', x: 50, y: 25, width: 60 }] // 頁尾流水號（獨立一行），不可當成成員
  );

  const pages = [page1, page2].map(items => Y.itemsToRows(items));
  const res = Y.parsePages(pages);

  console.log('  pages:', res.pages, ' members:', res.members.length);
  assert.strictEqual(res.pages, 2, '應處理 2 頁');
  assert.strictEqual(res.members.length, 9, '兩頁合共 9 位成員');

  const byId = Object.fromEntries(res.members.map(m => [m.ymis, m]));
  assert.strictEqual(byId['2019051156'].name, '陳大文');
  assert.strictEqual(byId['2019051156'].email, 'a.chan@example.com');
  assert.strictEqual(byId['2019096664'].email, '', '無電郵者留空');
  assert.ok(byId['2019096664'].warn.includes('no_email'));
  // 「*」標記不會混入姓名，編號仍為純 10 位數
  assert.strictEqual(byId['2019259338'].name, '劉子彤');
  assert.ok(/^\d{10}$/.test(byId['2019259338'].ymis));
  // 續行電郵補回上一位成員
  assert.strictEqual(byId['2019259338'].email, 'e.lau@example.com');
  assert.ok(!byId['2019259338'].warn.includes('no_email'));
  // 每位編號均為 10 位、無 warn ymis_len
  res.members.forEach(m => assert.ok(/^\d{10}$/.test(m.ymis), '編號應為10位: ' + m.ymis));
  // 頁尾流水號 / 重複抬頭不會變成成員
  assert.ok(!byId['202608210505'], '頁尾流水號不可當成成員');
  assert.ok(res.skipped.some(s => s.reason === 'no_name_email'));
  assert.ok(res.skipped.every(s => s.page >= 1 && s.page <= 2), 'skipped 應標示頁碼');
  console.log('  [PASS] 中英雙行欄名、* 標記、空電郵、續行電郵、多頁頁尾全部處理正確');

  console.log('\n=== 真實版面測試通過 ===');
}
runRealLayout();
