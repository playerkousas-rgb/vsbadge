// 本機預覽（含 mock GAS 後端）：node tests/dev-with-mock.mjs [port]
// 起一個 mock 旅團 0082（領袖 1234567890 / PassA!234567；成員 1234560001 / MemberA!234），
// 再起 dev server，方便在瀏覽器測試「團員申報 → 領袖審批」流程。
import { startMockGas } from './mock-gas.mjs';

const MOCK_PORT = 3901;
process.env.VSBADGE_PROXY_TEST = '1';
process.env.TROOP_0082_BACKEND = `http://127.0.0.1:${MOCK_PORT}/exec`;
process.env.TROOP_0082_APIKEY = 'KEY_A';

await startMockGas({
  port: MOCK_PORT, name: '旅團A(0082)', apikey: 'KEY_A',
  users: [
    { ymis: '1234567890', name: '陳大文', role: 'group_leader', pass: 'PassA!234567', can_tick: true, email: 'a@example.org' },
    { ymis: '1234560001', name: '成員甲', role: 'member', pass: 'MemberA!234', can_tick: false }
  ]
});
console.log(`mock GAS 旅團 0082 on http://127.0.0.1:${MOCK_PORT}/exec`);
await import('./dev-server.mjs');
