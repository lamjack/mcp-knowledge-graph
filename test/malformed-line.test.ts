// 損壞 JSONL 行的可追查性。
//
// 為何需要這組測試：載入時遇到無法解析的行，過去只印一句
// 「Skipping malformed line while loading knowledge graph.」——沒有檔案、沒有行號、
// 沒有內容摘錄，也不進檔案 sink。那條 entity/relation 被排除在記憶體圖譜之外，
// 而下一次任何寫入都會用 saveGraph 整檔重寫 → **該筆資料永久消失且無跡可循**。
// 這是本 repo 以「消滅靜默失敗」為設計目標下最後一個靜默缺口，故守衛兩件事：
//   1. 訊息帶檔案路徑、1-based 行號與截斷摘錄（能定位、能人工救回）。
//   2. 紀錄與工具拒絕路徑共用同一個檔案 sink（stderr 不可依賴——實測某些客戶端
//      產生的 server 行程 FD2 直接指向 /dev/null）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { KnowledgeGraphManager } from '../storage.js';
import { FILE_MARKER } from '../config.js';
import { INIT, INITIALIZED, call, runServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-malformed-');
}

// 種一份含損壞行的記憶檔：首行標記合法，第 3 行是壞的 JSON。
function seedGraphWithBadLine(root: string): string {
  const dir = path.join(root, '.aim');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'memory.jsonl');
  const good = JSON.stringify({
    type: 'entity',
    name: 'Kept',
    entityType: 'concept',
    observations: ['ok'],
  });
  const bad = '{"type":"entity","name":"Broken","observations":[LOST_PAYLOAD';
  writeFileSync(file, [JSON.stringify(FILE_MARKER), good, bad].join('\n'));
  return file;
}

test('損壞行的警告帶檔案路徑、行號與內容摘錄（可定位、可人工救回）', async () => {
  const root = tmpRoot();
  const file = seedGraphWithBadLine(root);
  const manager = new KnowledgeGraphManager(true);

  const captured: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  try {
    const graph = await manager.readGraph(undefined, undefined, root);
    assert.deepEqual(
      graph.entities.map(e => e.name),
      ['Kept'],
      '合法行仍須載入（容忍損壞行，不中止整個讀取）',
    );
  } finally {
    console.error = original;
  }

  const line = captured.find(l => l.includes('malformed'));
  assert.ok(line, `應有損壞行警告，實得: ${JSON.stringify(captured)}`);
  assert.ok(line!.includes(file), '訊息須含檔案路徑，否則多資料庫下無法定位');
  assert.match(line!, /line 3\b/, '訊息須含 1-based 行號（標記為第 1 行）');
  assert.match(line!, /LOST_PAYLOAD/, '訊息須含內容摘錄，這是人工救回該筆資料的唯一線索');
});

test('損壞行的紀錄與工具拒絕共用同一個檔案 sink（stderr 不可依賴）', async () => {
  const root = tmpRoot();
  seedGraphWithBadLine(root);
  const sink = path.join(root, 'diagnostic.log');

  await runServer(
    ['--workspace-only', `--diagnostic-log=${sink}`],
    [INIT, INITIALIZED, call(2, 'aim_memory_read_all', { projectRoot: root })],
    2,
  );

  assert.ok(existsSync(sink), '載入時遇到損壞行必須留下檔案紀錄');
  const content = readFileSync(sink, 'utf-8');
  assert.match(content, /malformed/, 'sink 須含損壞行紀錄');
  assert.match(content, /line 3\b/, 'sink 紀錄同樣須帶行號');
  assert.match(content, /\+08:00/, '須沿用既有的 Asia/Macau 時間戳格式以便與客戶端日誌對拍');
});

test('乾淨的圖譜不產生任何損壞行紀錄（必然出現的信號不是信號）', async () => {
  const root = tmpRoot();
  const dir = path.join(root, '.aim');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'memory.jsonl'),
    [
      JSON.stringify(FILE_MARKER),
      JSON.stringify({ type: 'entity', name: 'Fine', entityType: 'concept', observations: [] }),
    ].join('\n'),
  );
  const sink = path.join(root, 'diagnostic.log');

  const run = await runServer(
    ['--workspace-only', `--diagnostic-log=${sink}`],
    [INIT, INITIALIZED, call(2, 'aim_memory_read_all', { projectRoot: root })],
    2,
  );

  assert.equal(existsSync(sink), false, '無損壞行時不得建立 sink 檔案');
  assert.doesNotMatch(run.stderr, /malformed/, '無損壞行時 stderr 不得出現該警告');
});
