// 搜尋引擎：相關性評分 + ego-graph 擴展（2026-08-30 自 storage.ts 抽出，零行為變更）。
// 抽離理由：storage.ts 承載路徑解析、原子 IO+快取、CRUD、審計、DB 列表等 ≥5 個變更理由
// （god module），而本模組全是模組級純函式、不碰 IO，獨立成檔後兩側的變更不再互相牽動。
// KnowledgeGraphManager.searchNodes 改為薄委派（解析路徑 + 讀取後呼叫 searchGraph）。
// 依賴方向：storage → search（執行期）；本模組只以 import type 引用 storage 的資料模型
// （型別在編譯後抹除），故無模組循環。

import type { Entity, KnowledgeGraph } from './storage.js';

// 搜尋選項：limit 限制 seed 命中數量，depth 控制 ego-graph 擴展跳數。
// 明確允許 undefined，讓呼叫端可直接透傳未提供的工具參數（exactOptionalPropertyTypes）。
export interface SearchOptions {
  limit?: number | undefined;
  depth?: number | undefined;
}

// 將來自 client 的數值輸入正規化為非負整數：有限數 → 取下限 0 的整數；
// 其餘（未提供/NaN/Infinity/非數值）→ undefined，由各呼叫端套用自己的預設值
// （offset 預設 0、limit 不設上限、depth 預設 1）。此語義曾分散三處、靠註釋維持同步，
// 單一出口後由 server.ts（read_all 分頁）與本檔 searchGraph（limit/depth）共用。
export function normalizeNonNegInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : undefined;
}

// 是否為「詞字元」（unicode 字母或數字）。底線與空白/標點皆視為詞邊界，
// 因此 snake_case 的各段會被當成獨立詞（與 JS \b 的差異：\b 視底線為詞字元）。
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

// 判斷 term 是否以「整詞」形式出現在 haystack（兩側為字串邊界或非詞字元）。
// 用於搜尋的 word-boundary 權重：整詞命中優先於中段子字串命中。兩者皆為小寫。
function includesWholeWord(haystack: string, term: string): boolean {
  if (term.length === 0) return false;
  let idx = haystack.indexOf(term);
  while (idx !== -1) {
    const before = idx === 0 ? '' : haystack[idx - 1]!;
    const afterIdx = idx + term.length;
    const after = afterIdx >= haystack.length ? '' : haystack[afterIdx]!;
    const boundaryBefore = before === '' || !isWordChar(before);
    const boundaryAfter = after === '' || !isWordChar(after);
    if (boundaryBefore && boundaryAfter) return true;
    idx = haystack.indexOf(term, idx + 1);
  }
  return false;
}

// 以非詞字元切分為 token（unicode 友善）。用於查詢分詞，以及 fuzzy 比對時將實體文字 token 化。
function tokenizeWords(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// 受限編輯距離（Levenshtein）：一旦確定距離 > max 即提早回傳 max+1，避免不必要的計算。
// 用於 typo 容忍的近似比對（僅在查詢詞無精確命中時作為 fallback 觸發）。
// 匯出供 server 層的「工具名／參數名 did-you-mean」重用：同一套距離語義，零新依賴。
export function boundedLevenshtein(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const curr = new Array<number>(lb + 1);
    curr[0] = i;
    let rowMin = curr[0];
    const ai = a[i - 1];
    for (let j = 1; j <= lb; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  const d = prev[lb]!;
  return d <= max ? d : max + 1;
}

// 相關性排序搜尋 + ego-graph 擴展（原 KnowledgeGraphManager.searchNodes 的引擎本體）。
// 1) 對每個實體評分（name 完全命中 > name 子字串 > type 子字串 > observation 命中）；
//    多詞查詢額外以 IDF 加權（降權通用詞、升權稀有詞）並對 observation 命中做長度正規化。
// 2) 依分數排序取 top-k（limit）作為 seeds。
// 3) 由 seeds 依 depth 跳數擴展鄰居（預設 1），讓命中的關係與脈絡不被丟棄。
// 回傳的實體以「seeds（相關性序）在前、鄰居（名稱序）在後」排列，關係僅保留兩端皆在結果集者。
// 回傳值是深拷貝：本函式讀的是共享快取參考，拷貝避免呼叫端透過回傳值污染快取。
export function searchGraph(
  graph: KnowledgeGraph,
  query: string,
  options?: SearchOptions,
): KnowledgeGraph {
  const qFull = query.toLowerCase();
  // 分詞：以非詞字元切分（unicode 友善）並去重。單詞查詢維持原有分層契約；
  // 多詞查詢額外啟用逐詞比對 + 詞覆蓋 + 整詞（word-boundary）權重 + IDF 加權，提升 recall 與精準度。
  const terms = Array.from(new Set(tokenizeWords(qFull)));

  // 預先小寫化各欄位一次（供 DF 統計與評分共用，避免每個實體重複轉換）。
  const docs = graph.entities.map(e => ({
    e,
    name: e.name.toLowerCase(),
    type: e.entityType.toLowerCase(),
    obs: e.observations.map(o => o.toLowerCase()),
  }));
  const N = docs.length;

  // Document frequency：每個 term 出現於多少實體（name/type/任一 obs 含該子字串）。
  // 供 IDF 與 fuzzy 門檻共用。
  const df = new Map<string, number>();
  for (const t of terms) {
    let c = 0;
    for (const d of docs) {
      if (d.name.includes(t) || d.type.includes(t) || d.obs.some(o => o.includes(t))) c++;
    }
    df.set(t, c);
  }

  // IDF：add-one 平滑（idf = 1 + ln((N+1)/(df+1))，恆 >= 1）：稀有詞被放大、通用詞回歸基準 1。
  // 單一 term 對所有實體是等倍率、不改變相對排序，故僅在多詞查詢時套用。
  const idf = new Map<string, number>();
  if (terms.length >= 2) {
    for (const t of terms) idf.set(t, 1 + Math.log((N + 1) / ((df.get(t) ?? 0) + 1)));
  }

  // Fuzzy fallback（typo 容忍）：僅對「語料中無任何精確子字串命中（df=0）」且長度 >= 4 的 term 啟用，
  // 避免對已可精確命中者引入雜訊，並把昂貴的編輯距離限制在真的需要時才計算。
  const FUZZY_MIN_LEN = 4;
  const fuzzyTerms = terms.filter(t => t.length >= FUZZY_MIN_LEN && (df.get(t) ?? 0) === 0);
  const needFuzzy = fuzzyTerms.length > 0;
  // 需要時才把各實體文字切成 token 集（name + type + observations），供近似比對。
  const docTokens: Set<string>[] = needFuzzy
    ? docs.map(d => {
        const toks = new Set<string>();
        for (const w of tokenizeWords(d.name)) toks.add(w);
        for (const w of tokenizeWords(d.type)) toks.add(w);
        for (const o of d.obs) for (const w of tokenizeWords(o)) toks.add(w);
        return toks;
      })
    : [];

  const scoreOf = (d: { name: string; type: string; obs: string[] }, i: number): number => {
    const { name, type, obs } = d;
    // 長度正規化：observation 越多的實體，單則命中的邊際貢獻越低，抑制長 hub 靠「數量」霸榜。
    // <=1 則 observation 時係數為 1（不影響短實體），observation 越多係數越小。
    const obsNorm = 1 / (1 + Math.log(1 + Math.max(0, obs.length - 1)));

    let score = 0;
    // 片語層（整條查詢當單一子字串）：完整保留單詞查詢的既有分層（100/10/5/1）。
    if (name === qFull) score += 100;
    else if (name.includes(qFull)) score += 10;
    if (type.includes(qFull)) score += 5;
    let phraseObsHits = 0;
    for (const o of obs) if (o.includes(qFull)) phraseObsHits++;
    score += phraseObsHits * obsNorm;

    // 多詞增益：僅當 >=2 詞時啟用（單詞查詢行為與排序完全不變）。逐詞貢獻以 IDF 加權。
    if (terms.length >= 2) {
      let matchedTerms = 0;
      for (const t of terms) {
        let contribution = 0;
        if (name.includes(t)) contribution += includesWholeWord(name, t) ? 10 : 5;
        if (type.includes(t)) contribution += includesWholeWord(type, t) ? 4 : 2;
        let obsHit = 0;
        for (const o of obs) {
          if (o.includes(t)) obsHit += includesWholeWord(o, t) ? 1 : 0.5;
        }
        contribution += obsHit * obsNorm;
        if (contribution > 0) matchedTerms++;
        score += contribution * (idf.get(t) ?? 1);
      }
      // 詞覆蓋獎勵：命中越多不同查詢詞越相關，讓多詞命中者排在單詞命中者之上。
      if (matchedTerms >= 2) score += matchedTerms * 3;
    }

    // Fuzzy fallback：對 df=0 的長 term，若實體有 token 落在小編輯距離內給溫和加分（補 typo/近似）。
    // 距離門檻依 term 長度（>=7 允許 2 個編輯，否則 1 個），並以長度差先行剪枝。
    if (needFuzzy) {
      const toks = docTokens[i]!;
      for (const t of fuzzyTerms) {
        const maxEdits = t.length >= 7 ? 2 : 1;
        for (const tok of toks) {
          if (Math.abs(tok.length - t.length) > maxEdits) continue;
          if (boundedLevenshtein(tok, t, maxEdits) <= maxEdits) {
            score += 4;
            break;
          }
        }
      }
    }
    return score;
  };

  // seeds：命中（score > 0）者依分數遞減排序，同分以名稱穩定排序。
  const scored = docs
    .map((d, i) => ({ e: d.e, score: scoreOf(d, i) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));

  // limit：負值視為 0（回空結果）；未提供/NaN/Infinity → undefined = 不設上限。
  const limit = normalizeNonNegInt(options?.limit);
  const seeds = limit !== undefined ? scored.slice(0, limit) : scored;
  const seedNames = seeds.map(s => s.e.name);
  const seedSet = new Set(seedNames);

  // ego-graph 擴展：由 seeds 出發，逐層（BFS）納入 depth 跳內的鄰居。
  // depth：未提供/NaN/Infinity → 預設 1。
  const depth = normalizeNonNegInt(options?.depth) ?? 1;
  // 鄰接表：每跳只走前沿節點的邊（O(觸及邊數）），取代每跳掃全部關係的 O(depth·R)。
  const adjacency = new Map<string, string[]>();
  const addAdj = (a: string, b: string) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const r of graph.relations) {
    addAdj(r.from, r.to);
    addAdj(r.to, r.from);
  }
  const included = new Set<string>(seedNames);
  let frontier: string[] = seedNames;
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      const neighbours = adjacency.get(node);
      if (!neighbours) continue;
      for (const nb of neighbours) {
        if (!included.has(nb)) {
          included.add(nb);
          next.push(nb);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  // 組裝實體：seeds（相關性序）在前，鄰居（名稱序）在後。
  const byName = new Map(graph.entities.map(e => [e.name, e] as const));
  const neighbourNames = [...included]
    .filter(n => !seedSet.has(n))
    .sort((a, b) => a.localeCompare(b));
  const entities: Entity[] = [];
  for (const n of seedNames) {
    const e = byName.get(n);
    if (e) entities.push(e);
  }
  for (const n of neighbourNames) {
    const e = byName.get(n);
    if (e) entities.push(e);
  }

  // 關係：僅保留兩端皆在結果集者（此時已因擴展而連貫）。
  const relations = graph.relations.filter(r => included.has(r.from) && included.has(r.to));

  // 因使用共享快取參考，需深拷貝回傳的子圖，避免呼叫端透過回傳值污染快取。
  return structuredClone({ entities, relations });
}
