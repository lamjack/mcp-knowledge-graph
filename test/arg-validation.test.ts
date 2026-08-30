// inputSchema 的執行期型別驗證（2026-08-30，review 發現 6+7）。
//
// 低階 Server API 不依 inputSchema 自動驗證 arguments：assertToolCallArgs 過去只查
// required 鍵存在性，之後 15 個 handler 直接 as cast——畸形 payload（entities 給字串）
// 以裸 TypeError 落入 isError 通道，訊息不友善且沒有可 grep 的拒絕分類。
// validateArgsAgainstSchema 讓對外公告的 schema 成為執行期真正強制的契約：
// 驗證通過後 handler 的 as cast 才成立。新拒絕路徑一律走 rejectToolCall
// （reason=invalid-arguments，診斷 + stderr + sink 齊全，見 AGENTS.md 拒絕契約）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateArgsAgainstSchema } from '../server.js';
import { TOOL_DEFINITIONS } from '../tools.js';
import { INIT, INITIALIZED, call, runServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-argval-');
}

function schemaOf(name: string): unknown {
  return TOOL_DEFINITIONS.find(t => t.name === name)!.inputSchema;
}

// --- validateArgsAgainstSchema（單元） ---------------------------------------

test('合法 payload 回 null（store/search/get 各一）', () => {
  assert.equal(
    validateArgsAgainstSchema(schemaOf('aim_memory_store'), {
      entities: [{ name: 'A', entityType: 't', observations: ['x'] }],
      context: 'work',
    }),
    null,
  );
  assert.equal(
    validateArgsAgainstSchema(schemaOf('aim_memory_search'), { query: 'q', limit: 3, depth: 0 }),
    null,
  );
  assert.equal(
    validateArgsAgainstSchema(schemaOf('aim_memory_get'), { names: ['A'], observationPrefix: 'p' }),
    null,
  );
});

test('頂層型別錯誤：entities 給字串 → 指明應為 array', () => {
  const err = validateArgsAgainstSchema(schemaOf('aim_memory_store'), { entities: 'not-an-array' });
  assert.match(err!, /entities.*array/i);
});

test('巢狀 required：entities item 缺 name → 路徑指出 entities[0].name', () => {
  const err = validateArgsAgainstSchema(schemaOf('aim_memory_store'), {
    entities: [{ entityType: 't', observations: [] }],
  });
  assert.match(err!, /entities\[0\]\.name.*required/);
});

test('巢狀陣列元素型別：observations 給字串（應為 string[]）', () => {
  const err = validateArgsAgainstSchema(schemaOf('aim_memory_store'), {
    entities: [{ name: 'A', entityType: 't', observations: 'x' }],
  });
  assert.match(err!, /observations.*array/i);
});

test('number 型別與 minimum 下界：字串拒絕、負數拒絕、0 放行', () => {
  const schema = schemaOf('aim_memory_search');
  assert.match(validateArgsAgainstSchema(schema, { query: 'q', limit: '3' })!, /limit.*number/i);
  assert.match(validateArgsAgainstSchema(schema, { query: 'q', limit: -1 })!, /limit.*>= *0/i);
  assert.equal(validateArgsAgainstSchema(schema, { query: 'q', limit: 0 }), null);
});

test('enum：format 給未宣告的值 → 列出合法值', () => {
  const err = validateArgsAgainstSchema(schemaOf('aim_memory_get'), {
    names: ['A'],
    format: 'yaml',
  });
  assert.match(err!, /format.*json/);
});

test('巢狀 boolean：upsertKeyed 給字串 → 拒絕', () => {
  const err = validateArgsAgainstSchema(schemaOf('aim_memory_add_facts'), {
    observations: [{ entityName: 'E', contents: ['x'], upsertKeyed: 'yes' }],
  });
  assert.match(err!, /upsertKeyed.*boolean/i);
});

test('未宣告於 properties 的鍵放行（additionalProperties 預設允許，另有 did-you-mean 診斷）', () => {
  assert.equal(
    validateArgsAgainstSchema(schemaOf('aim_memory_get'), { names: ['A'], someFutureKey: 1 }),
    null,
  );
});

// --- stdio 整合：新拒絕路徑的完整紀錄鏈 ---------------------------------------

test('畸形 payload 走 invalid-arguments 拒絕路徑：isError + 診斷 + stderr，server 不死', async () => {
  const root = tmpRoot();
  const { messages, stderr } = await runServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_store', { projectRoot: root, entities: 'not-an-array' }),
      // 同 session 後續合法呼叫：證明拒絕不殺 server（錯誤通道契約）。
      call(3, 'aim_memory_store', {
        projectRoot: root,
        entities: [{ name: 'E', entityType: 't', observations: ['x'] }],
      }),
    ],
    3,
  );
  const rejected = messages.find(m => m.id === 2);
  assert.equal(rejected?.result?.isError, true, '工具層錯誤走 isError 通道（非協議級錯誤）');
  const text: string = rejected!.result.content[0].text;
  assert.match(text, /Invalid argument/i);
  assert.match(text, /entities.*array/i);
  assert.match(text, /\[diagnostic\] tool=aim_memory_store/, '訊息尾端必帶診斷抬頭');
  // stderr 同一份紀錄，reason 可獨立 grep（第六類故障形態）。
  assert.match(stderr, /tool call rejected \(invalid-arguments\) — reqId=2;/);
  const ok = messages.find(m => m.id === 3);
  assert.ok(ok?.result && ok.result.isError !== true, '後續合法呼叫必須成功');
});
