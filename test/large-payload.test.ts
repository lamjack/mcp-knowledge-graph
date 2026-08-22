// 大型 CJK payload 的連續寫入回歸守衛（2026-08-23 間歇性 "projectRoot is required" 調查）。
//
// 這支測試的目的不是驗證新功能，而是**把伺服器排除在嫌疑名單之外**：如果 stdio 傳輸、
// JSON 解析或參數處理在大型多位元組 payload 下會偶發丟鍵/截斷，連續 50 輪
// store + add_facts（每條 observation ≥ 8KB 的中文）必然踩到；全綠則證明「同一 payload
// 有時過有時不過」的成因不在伺服器端，客戶端橋接層才是唯一剩下的嫌疑方。
//
// 為何是 CJK：UTF-8 下中文每字 3 bytes，若任何一層用字元數當位元組數（或反之）切 buffer，
// 破口會落在多位元組字元中間；純 ASCII 測試對這類 bug 完全盲目。
//
// 一次 session 內把 100 個請求全部灌進 stdin，正是為了讓 ReadBuffer 在單次 chunk 中
// 承載多個訊息與被拆開的訊息——逐個往返的溫和節奏測不到這個面向。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INIT, INITIALIZED, call, driveServer, tmpRoot as makeTmpRoot } from './helpers.js';

const ROUNDS = 50;
const MIN_OBSERVATION_BYTES = 8 * 1024;
// count_observations 的前綴過濾用；同時讓 observation 具備 key 頭形態，貼近真實寫入。
const PREFIX = '壓測';

// 產生 ≥ 8KB（UTF-8 位元組）的中文 observation。帶 label 讓每條內容互異，
// 避免去重邏輯把重複內容吃掉而讓「寫入成功」的斷言失去意義。
function cjkObservation(label: string): string {
  const sentence =
    '記憶圖譜壓力測試觀察條目，內容刻意使用中文，以驗證多位元組字元在 stdio 傳輸、' +
    'JSON-RPC 解析與 JSONL 落盤的全程無損；任何按字元數切位元組的缺陷都會在此顯形。';
  let body = '';
  while (Buffer.byteLength(body, 'utf-8') < MIN_OBSERVATION_BYTES) {
    body += sentence;
  }
  return `${PREFIX}: ${label} ${body}`;
}

test('大型 CJK payload：連續 50 輪 store + add_facts 全部成功（伺服器端無間歇性丟鍵）', async t => {
  const root = makeTmpRoot('kg-cjk-');
  const sample = cjkObservation('sample');
  assert.ok(
    Buffer.byteLength(sample, 'utf-8') >= MIN_OBSERVATION_BYTES,
    'precondition: 單條 observation 必須達 8KB 以上，否則測不到大 payload',
  );
  assert.ok(
    Buffer.byteLength(sample, 'utf-8') > sample.length,
    'precondition: 內容須為多位元組字元（位元組數 > 字元數）',
  );

  const messages: object[] = [INIT, INITIALIZED];
  const ids: { id: number; label: string }[] = [];
  let id = 1;
  for (let i = 0; i < ROUNDS; i++) {
    const name = `壓測實體-${i}`;
    id++;
    ids.push({ id, label: `store #${i}` });
    messages.push(
      call(id, 'aim_memory_store', {
        projectRoot: root,
        entities: [
          { name, entityType: 'StressTest', observations: [cjkObservation(`store-${i}`)] },
        ],
      }),
    );
    id++;
    ids.push({ id, label: `add_facts #${i}` });
    messages.push(
      call(id, 'aim_memory_add_facts', {
        projectRoot: root,
        observations: [{ entityName: name, contents: [cjkObservation(`append-${i}`)] }],
      }),
    );
  }

  const lastId = id;
  const out = await driveServer(['--workspace-only'], messages, lastId, 120_000);

  const failures: string[] = [];
  for (const { id: reqId, label } of ids) {
    const resp = out.find(m => m.id === reqId);
    if (!resp) {
      failures.push(`${label}: 無回應`);
    } else if (resp.error) {
      failures.push(`${label}: 協議級錯誤 ${JSON.stringify(resp.error)}`);
    } else if (resp.result?.isError) {
      failures.push(`${label}: isError — ${resp.result.content[0].text}`);
    }
  }
  assert.deepEqual(failures, [], `${ROUNDS} 輪 store/add_facts 必須全部成功`);

  // 落盤核實：回應成功不等於內容進了檔案。讀取另開 session，避免與寫入競態。
  const names = Array.from({ length: ROUNDS }, (_, i) => `壓測實體-${i}`);
  const readOut = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_count_observations', {
        projectRoot: root,
        names,
        observationPrefix: PREFIX,
      }),
    ],
    2,
    30_000,
  );
  const counted = readOut.find(m => m.id === 2);
  assert.ok(counted?.result && !counted.result.isError, 'count_observations 必須成功');
  const report = JSON.parse(counted.result.content[0].text) as {
    entityName: string;
    entityExists: boolean;
    matched: number;
  }[];
  assert.equal(report.length, ROUNDS);
  const incomplete = report.filter(r => !r.entityExists || r.matched !== 2);
  assert.deepEqual(incomplete, [], '每個實體都應有 2 條 observation（store 1 + add_facts 1）落盤');

  t.diagnostic(
    `payload: ${Buffer.byteLength(sample, 'utf-8')} bytes / ${sample.length} chars per observation`,
  );
});
