// 診斷紀錄的單一出口：時間戳格式、stderr 行、可選的檔案 sink。
//
// 為何獨立成模組而非留在 server.ts：需要留紀錄的不只工具拒絕路徑（server 層），
// 儲存層載入時遇到損壞的 JSONL 行同樣是「靜默就會造成資料遺失」的事件。
// 兩層各寫一份 IO 會讓格式與 sink 目標漂移，而事後對拍靠的正是格式一致。
// 本模組只依賴 config（葉節點），故 storage 與 server 都能匯入而不成環。

import { appendFileSync, renameSync, statSync } from 'fs';

import { diagnosticLogPath } from './config.js';

// 澳門為固定 UTC+8 且無夏令時，因此「先平移 8 小時、再把 UTC 渲染尾端的 Z 換成 +08:00」
// 與逐欄位格式化等價，且無需 Intl 或額外依賴。
// 位移必須顯式寫出：這個時間戳存在的唯一目的是與客戶端日誌對拍定位故障窗口，
// 裸時間（或預設 UTC 的 Z）會讓兩份日誌差 8 小時而對不上帳。
const MACAU_OFFSET_MS = 8 * 60 * 60 * 1000;
export function macauIsoTimestamp(now: Date = new Date()): string {
  // toISOString() 產出 'YYYY-MM-DDTHH:mm:ss.sssZ'，slice(0,23) 去掉尾端的 Z。
  return `${new Date(now.getTime() + MACAU_OFFSET_MS).toISOString().slice(0, 23)}+08:00`;
}

// 紀錄前綴刻意用客戶端掛載此 server 的慣用名稱（而非套件名），
// 讓伺服器端與客戶端兩份日誌能用同一個字串 grep。
const PREFIX = '[aim-memory]';

// 把一則診斷事件寫到 stderr，並在配置了 sink 時追寫檔案。
// stdout 為 MCP 協議專用，故一律走 stderr。
// 只在「靜默就會造成誤診或資料遺失」的事件呼叫：必然出現的信號不是信號。
export function recordDiagnostic(event: string, detail: string): void {
  const record = `${macauIsoTimestamp()} ${PREFIX} ${event} — ${detail}`;
  console.error(record);
  appendToSink(record);
}

// 追寫可選的檔案 sink（--diagnostic-log / AIM_DIAGNOSTIC_LOG）。
// 追寫而非覆寫：要診斷的正是「連續失敗的那個窗口」，覆寫只會留下最後一筆。
// 同步寫入是刻意的——這條路徑罕見，換取紀錄不會因行程結束而遺失。
// 寫檔失敗只降級為 stderr 警告，絕不讓診斷輔助本身弄壞正常回應；若該客戶端連 stderr
// 都丟棄，這則警告也會消失，這是 sink 不可用時能做到的極限。
//
// 大小上限與輪轉：無上限的追寫曾讓 sink 只增不減（實測 10.5KB 且永不收斂）。
// 診斷的價值在「最近那個失敗窗口」，舊紀錄邊際價值遞減，故越界時把現檔 rename 為
// 單一 `.1` 備份（最多再留一代），磁碟佔用封頂在約 2 倍上限。1MB 對每行約兩百字元的
// 拒絕紀錄約可裝數千筆，遠超任何故障窗口的長度。匯出常量是為了讓測試能把 sink
// 墊到上限邊緣、以單筆寫入觸發輪轉，而不必真的灌 1MB。
export const DIAGNOSTIC_SINK_MAX_BYTES = 1_048_576;

function appendToSink(record: string): void {
  if (diagnosticLogPath === undefined) return;
  try {
    const line = `${record}\n`;
    let size = 0;
    try {
      size = statSync(diagnosticLogPath).size;
    } catch {
      // 檔案尚不存在（或不可讀）→ 視為 0，下面的 append 會建立它。
    }
    if (size > 0 && size + Buffer.byteLength(line, 'utf-8') > DIAGNOSTIC_SINK_MAX_BYTES) {
      // 輪轉失敗（權限等）不阻斷紀錄本身：降級為警告後照常追寫——sink 的存在目的
      // 就是捕捉故障窗口，輪轉失敗不能反過來丟掉證據。
      try {
        renameSync(diagnosticLogPath, `${diagnosticLogPath}.1`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`${macauIsoTimestamp()} ${PREFIX} diagnostic log rotation failed: ${reason}`);
      }
    }
    appendFileSync(diagnosticLogPath, line, 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`${macauIsoTimestamp()} ${PREFIX} diagnostic log write failed: ${reason}`);
  }
}
