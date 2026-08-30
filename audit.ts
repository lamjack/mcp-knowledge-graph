// 審計引擎：aim_memory_doctor 的唯讀圖譜健檢（2026-08-30 自 storage.ts 抽出，零行為變更）。
// 內容：auditGraph（doctor 報告本體）、其常量（豁免型別、門檻、標記清單、摘錄上限）與
// key 頭分析 helpers。抽離理由同 search.ts：削減 storage.ts 的 god module 變更理由。
// keyHeadOf / normalizeTypeKey 同時服務 storage 的寫入路徑（add_facts 的 upsertKeyed、
// store 的 entityType 碰撞警告、listEntityTypes），故匯出給 storage 使用——
// 依賴方向為 storage → audit（執行期），本模組只以 import type 引用 storage 的
// 資料模型（型別在編譯後抹除），無模組循環。

import type { KnowledgeGraph, Relation } from './storage.js';

// entityType 正規化鍵：小寫並移除底線/連字符，用於偵測「僅差大小寫/底線/連字符」的近似重複型別
// （如 DevPlan / dev-plan / dev_plan 皆正規化為 devplan）。純比較用途，不改變儲存的原始型別字串。
export function normalizeTypeKey(entityType: string): string {
  return entityType.toLowerCase().replace(/[_-]/g, '');
}

// 超大實體閾值（達標即列入 doctor 的 oversizedEntities，僅警告不阻斷）。
// 依據：預設輸出上限 50,000 字元下，單一實體 10k 字元已佔單次回傳預算兩成，
// 被 search/get 命中一次就大幅稀釋 context；50 條 observation 遠超正常策展粒度
// （如 SessionLog 10 區塊約 30 條），是「該拆分或 prune 的 hub」的可靠信號。
const OVERSIZED_OBSERVATION_COUNT = 50;
const OVERSIZED_TOTAL_CHARS = 10_000;

// observation 的 key 頭：首個 ':' 或全形 '：' 之前的片段（已 trim）。半形與全形一律
// 視為分隔符——中文書寫常用全形，只認半形會讓「別名：a / 別名：b」這類真重複永遠漏檢。
// 無分隔符、以分隔符開頭、或 key 頭為空者回 undefined（視為無鍵 observation）。
export function keyHeadOf(observation: string): string | undefined {
  const half = observation.indexOf(':');
  const full = observation.indexOf('：');
  const idx = half < 0 ? full : full < 0 ? half : Math.min(half, full);
  if (idx <= 0) return undefined;
  const head = observation.slice(0, idx).trim();
  return head === '' ? undefined : head;
}

// key 頭中的日期。鍵一旦帶日期就每寫一次生成一個新鍵，後續事實在結構上永遠無法覆蓋它
// ——這正是 journalEntities 要抓的形態。
// ⚠️ 只認四位年份 + `-` 或 `/` 分隔的完整日期（2026-08-12 / 2026/8/12）。兩次收緊都是被
// 誤報逼出來的：先放寬到 08-12 短式，把版本號 v3000.4.25 的 "4.25" 當成日期；改成強制
// 四位年份後 "3000.4.25" 整串仍完全符合 \d{4}.\d{1,2}.\d{1,2}——點分版本號與點分日期在
// 結構上無法區分。點號因此排除。誤報會讓整個區段被無視，寧可漏掉 2026.08.12 這種寫法
// （實測兩個真實圖譜清一色用連字號）也不要污染信號。
const DATE_PATTERN = String.raw`\d{4}[-/]\d{1,2}[-/]\d{1,2}`;
const DATE_IN_KEY = new RegExp(DATE_PATTERN);
// 內含日期的括號整組（半形/全形/方括號）。整組剝除才能讓
// 「staging deploy (2026-08-20, second run)」與「staging deploy (2026-08-12)」歸為同槽。
const DATED_BRACKET = new RegExp(
  String.raw`[（(【[][^）)】\]]*${DATE_PATTERN}[^）)】\]]*[）)】\]]?`,
  'g',
);

// 由帶日期的 key 頭反推它真正描述的「狀態槽」：剝掉帶日期的括號組與裸日期後剩下的語意。
// 只對帶日期的 key 呼叫（見 doctor），因此不會把 service: a / service: b 這類合法多值鍵誤併。
export function slotOfDatedKey(keyHead: string): string {
  return keyHead
    .replace(DATED_BRACKET, ' ')
    .replace(new RegExp(DATE_PATTERN, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[，,、\-—:：]+|[，,、\-—:：]+$/g, '')
    .trim();
}

// 三種陳舊/重複偵測（duplicateCandidates / journalEntities / unresolvedMarkers）皆不適用的
// entityType（正規化比較）。
// ⚠️ 這是對**舊圖譜**的防禦，不是活契約：支配方法學（memory-graph-curation）已於
// 2026-08-24 廢除 transient SessionLog 層並禁止重建，新的圖譜不該再出現 SessionLog 實體。
// 保留豁免是為了仍存有 SessionLog 實體的舊圖譜——它依設計是帶時序的流水帳且 pending
// 區塊本來就在列未決事項，三種偵測對它都是必然命中；必然命中的信號不是信號，
// 只會淹沒真正的問題。若哪天確認所有 workspace 的圖譜都已無 SessionLog，此豁免可連同
// 文檔段落一併清除。
const AUDIT_EXEMPT_TYPES = new Set(['sessionlog']);

// 單一實體內帶日期 key 的數量門檻與佔比門檻，須同時達標。數量濾掉零星標註
// （在鍵裡順手記個日期）；佔比濾掉「本來就長」的實體——96 條裡有 12 條帶日期屬正常，
// 34 條裡有 30 條才是日期已成為組織主軸。兩者缺一就會製造警報疲勞，讓真信號被淹沒。
const JOURNAL_DATED_KEY_THRESHOLD = 5;
const JOURNAL_DATED_KEY_RATIO = 0.3;

// 未結案標記：出現在 observation 中即代表該事實仍是暫定/待辦，需要在後續 session 回頭收斂。
// 刻意維持精簡且無歧義——寧可漏報也不要讓一般敘述（如「尚未實作」這類穩定現狀）洗版。
const UNRESOLVED_MARKERS = ['TODO', 'TBD', '待確認', '待驗證', '待定', '待補', '暫定'];
const EXCERPT_MAX_CHARS = 120;
// 每組最多取樣幾條摘錄。判斷「這組是合法多值還是同事實的多版本」三條足矣，
// 而 `count` 已如實回報組員總數；9 條全吐只是把預算花在重複資訊上。
const EXCERPT_SAMPLE_LIMIT = 3;

// 報告/診斷用摘錄：超長內容截斷並標記，避免審計區段或診斷行吃掉單次輸出預算。
// 匯出供 storage 的損壞 JSONL 行診斷共用同一份截斷語義（見 loadGraph）。
export function excerptOf(observation: string): string {
  return observation.length > EXCERPT_MAX_CHARS
    ? `${observation.slice(0, EXCERPT_MAX_CHARS)}…`
    : observation;
}

// 取樣並截斷一組 observation，供審計報告使用（順序保留，取前 N 條）。
function excerptsOf(observations: string[]): string[] {
  return observations.slice(0, EXCERPT_SAMPLE_LIMIT).map(excerptOf);
}

// aim_memory_doctor 的唯讀審計報告。所有欄位皆為新計算的純資料（不與快取共用參考）。
export interface DoctorReport {
  // 無任何 relation 端點的 entity 名單（名稱序）。
  orphans: string[];
  // 端點不存在的 relation 清單。
  danglingRelations: Relation[];
  // entityType 僅差大小寫/底線/連字符的分組（正規化鍵 -> 原始型別集合）。
  typeCollisions: { normalized: string; types: string[] }[];
  // 同一 entity 內共用相同 key 前綴的多條 observations（可能是未清理的過時版本）。
  // excerpts 截斷至 EXCERPT_MAX_CHARS：合法多值鍵（`service:` × N）與過時版本在此無法區分，
  // 一律回報但**不逐字回吐**——實測某真實圖譜的 runbook 多值鍵曾讓本區段吃掉單次輸出預算近三成。
  duplicateCandidates: {
    entityName: string;
    keyPrefix: string;
    count: number;
    excerpts: string[];
  }[];
  // 超大實體警告（advisory）：observation 條數或字元總量達到閾值的實體，依 totalChars 遞減排序。
  // 超大 hub 實體被 search/get 命中時單次即回傳大量字元，稀釋 context——提示拆分或 prune。
  oversizedEntities: {
    entityName: string;
    observationCount: number;
    totalChars: number;
    exceeds: ('observationCount' | 'totalChars')[];
  }[];
  // 流水帳漂移：key 頭內嵌日期的 observation 每寫一次就生成一個新鍵，結構上永遠無法被後續
  // 事實覆蓋，於是實體從「當前狀態」退化為「歷次快照堆積」。兩種命中條件：
  //   1. datedKeys 達門檻——日期已成為該實體的組織主軸；
  //   2. sameSlotGroups 非空——多個鍵剝掉日期後指向同一個槽（如 "deploy (2026-08-12)"
  //      與 "deploy (2026-08-20)"），這類同事重複 duplicateCandidates 全盲，因為每個鍵都相異。
  // keyPrefixes 可直接餵給 remove_facts 的 observationPrefix 清理。SessionLog 型別豁免。
  journalEntities: {
    entityName: string;
    datedKeys: number;
    totalObservations: number;
    sameSlotGroups: { slot: string; count: number; keyPrefixes: string[] }[];
  }[];
  // 未結案標記：仍寫著 TODO / 待確認 之類的 observation。它們是「當時沒定案」的事實，
  // 定案後常沒人回頭改，於是無限期陳舊。excerpts 截斷至 120 字元以控制報告體積。
  unresolvedMarkers: { entityName: string; count: number; markers: string[]; excerpts: string[] }[];
  // 計數與型別分佈統計。
  stats: {
    database: string;
    entityCount: number;
    relationCount: number;
    observationCount: number;
    entityTypeDistribution: Record<string, number>;
  };
}

// 唯讀圖譜審計（原 KnowledgeGraphManager.doctor 的引擎本體）：孤兒實體、懸空關係、
// entityType 格式碰撞、同 key 前綴的重複候選 observations、流水帳漂移、未結案標記、
// 超大實體警告、以及計數/型別分佈統計。`database` 僅用於報告的 stats.database 欄位。
export function auditGraph(graph: KnowledgeGraph, database: string): DoctorReport {
  const names = new Set(graph.entities.map(e => e.name));

  // orphans：不作為任何 relation 端點的 entity。
  const connected = new Set<string>();
  for (const r of graph.relations) {
    connected.add(r.from);
    connected.add(r.to);
  }
  const orphans = graph.entities
    .filter(e => !connected.has(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));

  // danglingRelations：任一端點不存在於實體集合。
  const danglingRelations = graph.relations
    .filter(r => !names.has(r.from) || !names.has(r.to))
    .map(r => ({ from: r.from, relationType: r.relationType, to: r.to }));

  // typeCollisions：正規化鍵相同但原字串多於一種的分組。
  const byNorm = new Map<string, Set<string>>();
  for (const e of graph.entities) {
    const k = normalizeTypeKey(e.entityType);
    const set = byNorm.get(k);
    if (set) set.add(e.entityType);
    else byNorm.set(k, new Set([e.entityType]));
  }
  const typeCollisions = [...byNorm.entries()]
    .filter(([, set]) => set.size >= 2)
    .map(([normalized, set]) => ({
      normalized,
      types: [...set].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.normalized.localeCompare(b.normalized));

  // duplicateCandidates：同一 entity 內共用相同 key 前綴的多條 observations。
  // journalEntities：帶日期的 key 頭另按「剝掉日期後的狀態槽」分組，並統計每個實體的
  // 帶日期鍵總數——日期入鍵者結構上不可被覆蓋，累積到一定量即代表該實體已淪為流水帳。
  const duplicateCandidates: DoctorReport['duplicateCandidates'] = [];
  const journalEntities: DoctorReport['journalEntities'] = [];
  for (const e of graph.entities) {
    const groups = new Map<string, string[]>();
    const slots = new Map<string, { keys: Set<string>; count: number }>();
    // SessionLog 對兩種偵測都豁免。duplicateCandidates 在它身上是結構性假陽性：
    // `session <ts>｜…` 的首個 ':' 落在 ISO 時間戳裡，同一小時的區塊因而歸為同鍵，
    // 而它們是相異的工作紀錄不是同一事實的版本；照報還會把整批長文吐進報告淹掉真信號。
    const auditExempt = AUDIT_EXEMPT_TYPES.has(normalizeTypeKey(e.entityType));
    let datedKeys = 0;
    for (const o of e.observations) {
      const prefix = keyHeadOf(o);
      if (prefix === undefined) continue; // 無鍵 observation 不參與任何分組。
      if (auditExempt) continue;
      const arr = groups.get(prefix);
      if (arr) arr.push(o);
      else groups.set(prefix, [o]);
      if (!DATE_IN_KEY.test(prefix)) continue;
      datedKeys += 1;
      const slot = slotOfDatedKey(prefix);
      const bucket = slots.get(slot);
      if (bucket) {
        bucket.keys.add(prefix);
        bucket.count += 1;
      } else {
        slots.set(slot, { keys: new Set([prefix]), count: 1 });
      }
    }
    for (const [keyPrefix, obs] of groups) {
      if (obs.length >= 2) {
        duplicateCandidates.push({
          entityName: e.name,
          keyPrefix,
          count: obs.length,
          excerpts: excerptsOf(obs),
        });
      }
    }
    // 同槽需至少兩個相異鍵；同一個鍵重複多次屬 duplicateCandidates 的範疇，兩者不重複回報。
    const sameSlotGroups = [...slots.entries()]
      .filter(([, { keys }]) => keys.size >= 2)
      .map(([slot, { keys, count }]) => ({
        slot,
        count,
        keyPrefixes: [...keys].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => b.count - a.count || a.slot.localeCompare(b.slot));
    // 同槽重複是精確證據，不受數量/佔比門檻約束，一律回報。
    const drifted =
      datedKeys >= JOURNAL_DATED_KEY_THRESHOLD &&
      datedKeys >= e.observations.length * JOURNAL_DATED_KEY_RATIO;
    if (drifted || sameSlotGroups.length > 0) {
      journalEntities.push({
        entityName: e.name,
        datedKeys,
        totalObservations: e.observations.length,
        sameSlotGroups,
      });
    }
  }
  duplicateCandidates.sort(
    (a, b) => a.entityName.localeCompare(b.entityName) || a.keyPrefix.localeCompare(b.keyPrefix),
  );
  journalEntities.sort(
    (a, b) => b.datedKeys - a.datedKeys || a.entityName.localeCompare(b.entityName),
  );

  // unresolvedMarkers：仍帶未結案標記的 observation，依 entity 匯總。
  // SessionLog 同樣豁免（舊圖譜防禦，見 AUDIT_EXEMPT_TYPES）：`pending:` 區塊本來就在
  // 列未決事項，每個 session 必然命中——必然命中的信號不是信號。
  const unresolvedMarkers: DoctorReport['unresolvedMarkers'] = [];
  for (const e of graph.entities) {
    if (AUDIT_EXEMPT_TYPES.has(normalizeTypeKey(e.entityType))) continue;
    const markers = new Set<string>();
    const hits: string[] = [];
    for (const o of e.observations) {
      const matched = UNRESOLVED_MARKERS.filter(m => o.includes(m));
      if (matched.length === 0) continue;
      for (const m of matched) markers.add(m);
      hits.push(o);
    }
    if (hits.length > 0) {
      unresolvedMarkers.push({
        entityName: e.name,
        count: hits.length,
        markers: [...markers].sort((a, b) => a.localeCompare(b)),
        excerpts: excerptsOf(hits),
      });
    }
  }
  unresolvedMarkers.sort((a, b) => b.count - a.count || a.entityName.localeCompare(b.entityName));

  // oversizedEntities：observation 條數或字元總量達閾值的實體（提示拆分/prune 的策展信號）。
  // 依 totalChars 遞減排序（最重的 hub 在前），同量以名稱穩定排序。
  const oversizedEntities: DoctorReport['oversizedEntities'] = [];
  for (const e of graph.entities) {
    const totalChars = e.observations.reduce((sum, o) => sum + o.length, 0);
    const exceeds: ('observationCount' | 'totalChars')[] = [];
    if (e.observations.length >= OVERSIZED_OBSERVATION_COUNT) exceeds.push('observationCount');
    if (totalChars >= OVERSIZED_TOTAL_CHARS) exceeds.push('totalChars');
    if (exceeds.length > 0) {
      oversizedEntities.push({
        entityName: e.name,
        observationCount: e.observations.length,
        totalChars,
        exceeds,
      });
    }
  }
  oversizedEntities.sort(
    (a, b) => b.totalChars - a.totalChars || a.entityName.localeCompare(b.entityName),
  );

  // stats：計數與型別分佈。
  const entityTypeDistribution: Record<string, number> = {};
  let observationCount = 0;
  for (const e of graph.entities) {
    entityTypeDistribution[e.entityType] = (entityTypeDistribution[e.entityType] ?? 0) + 1;
    observationCount += e.observations.length;
  }

  return {
    orphans,
    danglingRelations,
    typeCollisions,
    duplicateCandidates,
    oversizedEntities,
    journalEntities,
    unresolvedMarkers,
    stats: {
      database,
      entityCount: graph.entities.length,
      relationCount: graph.relations.length,
      observationCount,
      entityTypeDistribution,
    },
  };
}
