/* =====================================================================
 * サロン受付 モバイル版 M-V1
 * PC版 Este V3.7 (MensEstheSuite.Plugin.Timetable) のロジックを移植
 * 時刻は「営業日タイムラインの分」(420=7:00 〜 1859=30:59)で扱う
 * ===================================================================== */
"use strict";

/* ================= 定数(PC版準拠) ================= */
const BIZ_START_MIN = 7 * 60;         // 7:00
const BIZ_END_MIN   = 30 * 60 + 59;   // 30:59
const CUTOFF_HOUR   = 6;              // 営業日切替(翌6:00まで前営業日)
const MINUTE_STEP   = 10;             // 10分グリッド
const COLUMNS       = (24 * 60) / MINUTE_STEP; // 144
const COURSES       = [60, 80, 100, 120];
const SEARCH_COURSES = [60, 80, 100, 120, 140, 160, 180]; // 空枠検索用

const APP_VERSION = "M-V12.5";

/* ================= 純粋ロジック(移植) ================= */

// TimeSpan文字列/入力 → 営業分。 "26:30"/"2630"/"930" 対応。不正はnull
function parseBizTime(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/：/g, ":").replace(/[^\d:]/g, "");
  if (!s) return null;
  let h, m;
  if (s.includes(":")) {
    const p = s.split(":");
    if (p.length !== 2 || p[0] === "" || p[1] === "") return null;
    h = parseInt(p[0], 10); m = parseInt(p[1], 10);
  } else if (s.length === 3) {
    h = parseInt(s.slice(0, 1), 10); m = parseInt(s.slice(1), 10);
  } else if (s.length === 4) {
    h = parseInt(s.slice(0, 2), 10); m = parseInt(s.slice(2), 10);
  } else return null;
  if (isNaN(h) || isNaN(m) || m < 0 || m > 59) return null;
  if (h >= 0 && h < 7) h += 24;              // 0:00〜6:59 → 24〜30時扱い
  if (h < 7 || h > 30) return null;
  let v = h * 60 + m;
  if (v > BIZ_END_MIN) v = BIZ_END_MIN;
  return v;
}

// 営業分 → "26:30" 形式
function fmtBiz(min) {
  if (min == null) return "";
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// SNS用: 通常24h表記(0〜9時は0埋めしない。M-V12.5: 「8:20」「0:15」のように直接時間で表示)
function fmtNormal(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// 営業日判定: 現在時刻→営業日("YYYY-MM-DD")
function getBusinessDate(now) {
  const d = new Date(now);
  if (d.getHours() < CUTOFF_HOUR) d.setDate(d.getDate() - 1);
  return toDateKey(d);
}
function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dateKeyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// 「今」を選択営業日のタイムライン分へ写像(10分切下げ)。PC: MapNowToBusinessTimeline
function mapNowToBizMin(now) {
  const d = new Date(now);
  const mm10 = Math.floor(d.getMinutes() / 10) * 10;
  let h = d.getHours();
  if (h < CUTOFF_HOUR) h += 24;
  return h * 60 + mm10;
}

// 選択日の初期基準時刻(分)。PC: ComputeDefaultBaseTimeForSelectedDate + RoundDownTo5
function defaultBaseMin(selectedDateKey, now, roundTo = 5) {
  const r = Math.max(1, roundTo);
  if (selectedDateKey === getBusinessDate(now)) {
    const v = mapNowToBizMin(now);
    return Math.floor(v / r) * r;
  }
  return BIZ_START_MIN;
}

function parseIntervalMinutes(s, def = 20) {
  const m = parseInt(s, 10);
  return (!isNaN(m) && m > 0) ? m : def;
}

// 出勤の start/end 補正。end<=start は +24h(PC: TryFindEarliestSlot冒頭)
function normAttendance(a) {
  let s = a.startMin != null ? a.startMin : BIZ_START_MIN;
  let e = a.endMin   != null ? a.endMin   : 30 * 60;
  if (e <= s) e += 24 * 60;
  return { s, e };
}

// 旧データ補正: 7:00未満は+24h(PC: NormalizeSpanToBusinessTimeline)
function normSpan(min) { return min < BIZ_START_MIN ? min + 24 * 60 : min; }

/* 最短取得(PC: TimetableView.TryFindEarliestSlot 完全移植)
 * blocks: [{s,e}](予約+仮押さえ, 営業分), a:{startMin,endMin}, nowMin:基準(営業分), interval:分
 * 戻り: {found, startMin, maxCourse} */
function tryFindEarliestSlot(a, blocksIn, nowMin, interval, prep = 15) {
  const { s: bizStart, e: bizEnd } = normAttendance(a);

  const blocks = blocksIn
    .map(b => {
      let s = normSpan(b.s), e = normSpan(b.e);
      if (e <= s) e += 24 * 60;
      return { s, e, hold: !!b.hold };
    })
    .sort((x, y) => x.s - y.s);

  // 状態別基準(V3.9: 仮押さえはインターバル無しで押し上げ)
  let stateStart;
  const inService = blocks.find(b => b.s <= nowMin && nowMin < b.e);
  if (nowMin < bizStart) {
    const p = nowMin + prep;
    stateStart = p > bizStart ? p : bizStart;
  } else if (inService) {
    stateStart = inService.e + (inService.hold ? 0 : interval);
  } else {
    stateStart = nowMin + prep;
    for (const b of blocks) {
      const guardEnd = b.e + (b.hold ? 0 : interval);
      if (stateStart >= b.s && stateStart < guardEnd) stateStart = guardEnd;
    }
  }

  // ギャップ探索(予約はインターバル控除、仮押さえは控除なし)
  let prevEnd = bizStart, prevHold = false, hasPrev = false;
  for (const b of blocks) {
    const gapStart = hasPrev ? prevEnd + (prevHold ? 0 : interval) : bizStart;
    const gapEnd = b.s - (b.hold ? 0 : interval);
    const start = Math.max(gapStart, stateStart);
    if (start < gapEnd) {
      const free = Math.floor(gapEnd - start);
      if (free >= 60) {
        const max = free >= 120 ? 120 : free >= 100 ? 100 : free >= 80 ? 80 : 60;
        return { found: true, startMin: start, maxCourse: max };
      }
    }
    prevEnd = b.e; prevHold = b.hold; hasPrev = true;
  }
  let finalStart = hasPrev ? prevEnd + (prevHold ? 0 : interval) : bizStart;
  finalStart = Math.max(finalStart, stateStart);
  if (finalStart < bizEnd) {
    const free = Math.floor(bizEnd - finalStart);
    if (free >= 60) {
      const max = free >= 120 ? 120 : free >= 100 ? 100 : free >= 80 ? 80 : 60;
      return { found: true, startMin: finalStart, maxCourse: max };
    }
  }
  return { found: false, startMin: null, maxCourse: 0 };
}

/* 空枠検索: 指定コースが入る最初の空きを探す(状態基準は tryFindEarliestSlot と同一)
 * V3.9: 仮押さえ(hold=true)はインターバル無し。maxCourse は検索コースそのものを返す。
 * ladder引数は表示用(maxTextEx)に残すが、maxCourse算出には使わない。
 * 戻り: {found, startMin, maxCourse(=courseMin)} */
function findSlotForCourse(a, blocksIn, nowMin, interval, courseMin, ladder, prep = 15) {
  const { s: bizStart, e: bizEnd } = normAttendance(a);
  const blocks = blocksIn
    .map(b => {
      let s = normSpan(b.s), e = normSpan(b.e);
      if (e <= s) e += 24 * 60;
      return { s, e, hold: !!b.hold };
    })
    .sort((x, y) => x.s - y.s);

  let stateStart;
  const inService = blocks.find(b => b.s <= nowMin && nowMin < b.e);
  if (nowMin < bizStart) {
    const p = nowMin + prep;
    stateStart = p > bizStart ? p : bizStart;
  } else if (inService) {
    stateStart = inService.e + (inService.hold ? 0 : interval);
  } else {
    stateStart = nowMin + prep;
    for (const b of blocks) {
      const guardEnd = b.e + (b.hold ? 0 : interval);
      if (stateStart >= b.s && stateStart < guardEnd) stateStart = guardEnd;
    }
  }

  let prevEnd = bizStart, prevHold = false, hasPrev = false;
  for (const b of blocks) {
    const gapStart = hasPrev ? prevEnd + (prevHold ? 0 : interval) : bizStart;
    const gapEnd = b.s - (b.hold ? 0 : interval);
    const start = Math.max(gapStart, stateStart);
    if (start < gapEnd) {
      const free = Math.floor(gapEnd - start);
      if (free >= courseMin) {
        return { found: true, startMin: start, maxCourse: courseMin };
      }
    }
    prevEnd = b.e; prevHold = b.hold; hasPrev = true;
  }
  let finalStart = hasPrev ? prevEnd + (prevHold ? 0 : interval) : bizStart;
  finalStart = Math.max(finalStart, stateStart);
  if (finalStart < bizEnd) {
    const free = Math.floor(bizEnd - finalStart);
    if (free >= courseMin) {
      return { found: true, startMin: finalStart, maxCourse: courseMin };
    }
  }
  return { found: false, startMin: null, maxCourse: 0 };
}

/* ラスト枠検索: 指定コースが取れる「一番遅い開始時刻」を探す
 * 下限は最短検索と同じ状態基準(準備時間・施術中・インターバル)を適用
 * V3.9: 仮押さえ(hold=true)はインターバル無し。maxCourse は検索コースそのものを返す。
 * 戻り: {found, startMin(最遅開始), maxCourse(=courseMin)} */
function findLastSlotForCourse(a, blocksIn, nowMin, interval, courseMin, ladder, prep = 15) {
  const { s: bizStart, e: bizEnd } = normAttendance(a);
  const blocks = blocksIn
    .map(b => {
      let s = normSpan(b.s), e = normSpan(b.e);
      if (e <= s) e += 24 * 60;
      return { s, e, hold: !!b.hold };
    })
    .sort((x, y) => x.s - y.s);

  let stateStart;
  const inService = blocks.find(b => b.s <= nowMin && nowMin < b.e);
  if (nowMin < bizStart) {
    const p = nowMin + prep;
    stateStart = p > bizStart ? p : bizStart;
  } else if (inService) {
    stateStart = inService.e + (inService.hold ? 0 : interval);
  } else {
    stateStart = nowMin + prep;
    for (const b of blocks) {
      const guardEnd = b.e + (b.hold ? 0 : interval);
      if (stateStart >= b.s && stateStart < guardEnd) stateStart = guardEnd;
    }
  }

  let best = null; // {startMin}
  const consider = (gapStart, gapEnd) => {
    const start = Math.max(gapStart, stateStart);
    if (start >= gapEnd) return;
    const free = Math.floor(gapEnd - start);
    if (free < courseMin) return;
    const lastStart = gapEnd - courseMin; // このギャップでの最遅開始
    if (!best || lastStart > best.startMin) {
      best = { startMin: lastStart, maxCourse: courseMin };
    }
  };

  let prevEnd = bizStart, prevHold = false, hasPrev = false;
  for (const b of blocks) {
    const gapStart = hasPrev ? prevEnd + (prevHold ? 0 : interval) : bizStart;
    const gapEnd = b.s - (b.hold ? 0 : interval);
    consider(gapStart, gapEnd);
    prevEnd = b.e; prevHold = b.hold; hasPrev = true;
  }
  const finalStart = hasPrev ? prevEnd + (prevHold ? 0 : interval) : bizStart;
  consider(finalStart, bizEnd);

  return best ? { found: true, ...best } : { found: false, startMin: null, maxCourse: 0 };
}
// 最大コース表記(拡張版): ladder指定可。括弧内=上限内、括弧外=空きはあるが上限超過
function maxTextEx(gapMax, cap, ladder) {
  const hi = Math.min(gapMax, cap);
  const inP = ladder.filter(c => c <= hi).join("/");
  const outP = ladder.filter(c => c > cap && c <= gapMax).join("/");
  let s = `(${inP})`;
  if (outP) s += " " + outP;
  return s;
}

// 最大コース表記。括弧内=上限内、括弧外=空きはあるが上限超過(PC: ShortestPane.MaxText)
function maxText(gapMax, cap) {
  const hi = Math.min(gapMax, cap);
  const inP = COURSES.filter(c => c <= hi).join("/");
  const outP = COURSES.filter(c => c > cap && c <= gapMax).join("/");
  let s = `(${inP})`;
  if (outP) s += " " + outP;
  return s;
}

// 姓抽出(PC: ShortestPane.SanName 移植)
function isKanjiChar(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x4E00 && c <= 0x9FFF) || c === 0x3005 || c === 0x303B;
}
function isHiragana(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x3041 && c <= 0x3096;
}
function sanName(name) {
  if (!name || !name.trim()) return "さん";
  const s = name.trim();
  if (!isKanjiChar(s[0])) {
    // 先頭が漢字でない場合: ひらがな直前まで
    let cut = s.length;
    for (let i = 0; i < s.length; i++) { if (isHiragana(s[i])) { cut = i; break; } }
    const head = s.slice(0, cut) || s;
    return head + "さん";
  }
  // 先頭が漢字: 最後に漢字で終わる位置まで(途中の記号・カタカナ許容)
  let lastKanji = 0;
  for (let i = 0; i < s.length; i++) {
    if (isHiragana(s[i])) break;
    if (isKanjiChar(s[i])) lastKanji = i;
  }
  return s.slice(0, lastKanji + 1) + "さん";
}
// 全角スペース詰め(PC: PadName)
function padName(s, width) {
  let len = 0;
  for (const ch of s) len += (ch.codePointAt(0) > 0xFF) ? 2 : 1;
  const pad = Math.max(0, width * 2 - len);
  return s + "　".repeat(Math.floor(pad / 2)) + (pad % 2 ? " " : "");
}

// 終了時刻計算(PC: ReservationDialog.CalcEnd)
function calcEnd(startMin, course, ext) {
  let e = startMin + course + Math.max(0, ext || 0);
  if (e > BIZ_END_MIN) e = BIZ_END_MIN;
  return e;
}

// 総額計算(PC: RecalcTotal 拡張。OP金額・指名料適用は設定から解決して渡す)
function calcTotal(prices, course, ext, discount, opPrice, applyNomFee, nominationFee) {
  const base = prices.coursePrice[course];
  if (base == null) return null;
  const unit = Math.max(1, prices.extensionUnitMinutes);
  const extPrice = Math.floor(Math.max(0, ext || 0) / unit) * Math.max(0, prices.extensionUnitPrice);
  const op = Math.max(0, opPrice || 0);
  const nomFee = applyNomFee ? Math.max(0, nominationFee || 0) : 0;
  let total = base + extPrice + op + nomFee - Math.max(0, discount || 0);
  return total < 0 ? 0 : total;
}

/* ★M-V12: セラピスト送信文生成(PC: SendMessageBuilder と同一仕様・同一出力)
   変数: {開始}{終了}{分}{コース}{延長}{属性}{顧客名}{下四桁}{金額}{割引}{指名文言}{指名}{セラピスト}{OP}{メモ}
   ・{金額} = (コース料金+延長料金+指名料) − 割引 (0未満は0・OPは含めない)
   ・行内の既知変数がすべて空(数値0含む)ならその行を丸ごと省略
   ・空値の変数は直後の空白(半角/全角)1文字も除去 / 連続空行は1行に / 先頭末尾の空行は除去 */
function fmtMsgTime(min) { // ★M-V12.5: 出力統一のため24時以降は巻き戻す表記(最短取得コピーと同じfmtNormal仕様)
  if (min == null || min < 0) return "";
  return fmtNormal(min);
}
function resolveAttrDisplay(rules, attr, nom) {
  for (const rule of (rules || [])) {
    if (!rule) continue;
    const attrOk = !rule.input || rule.input === attr;
    const nomOk = !rule.nom || rule.nom === nom;
    if (attrOk && nomOk) return rule.output || "";
  }
  return attr;
}
function renderSendTemplate(template, vars) {
  const lines = String(template || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    // 1周目: 既知変数の有無と空判定
    let hasVar = false, allEmpty = true;
    let i = 0;
    while (i < line.length) {
      const open = line.indexOf("{", i);
      if (open < 0) break;
      const close = line.indexOf("}", open + 1);
      if (close < 0) break;
      const name = line.slice(open + 1, close);
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        hasVar = true;
        if (vars[name] !== "") allEmpty = false;
      }
      i = close + 1;
    }
    if (hasVar && allEmpty) continue; // 変数がすべて空 → 行ごと省略
    // 2周目: 置換(空値は直後の空白1文字も除去)
    let sb = "";
    i = 0;
    while (i < line.length) {
      const open = line.indexOf("{", i);
      if (open < 0) { sb += line.slice(i); break; }
      const close = line.indexOf("}", open + 1);
      if (close < 0) { sb += line.slice(i); break; }
      sb += line.slice(i, open);
      const name = line.slice(open + 1, close);
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        sb += vars[name];
        i = close + 1;
        if (vars[name] === "" && i < line.length && (line[i] === " " || line[i] === "　")) i++;
      } else {
        sb += line.slice(open, close + 1); // 未知の変数は文字通り残す
        i = close + 1;
      }
    }
    out.push(sb);
  }
  // 連続する空行を1行にまとめ、先頭・末尾の空行は除去
  const collapsed = [];
  for (const l of out) {
    if (l === "" && collapsed.length > 0 && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(l);
  }
  while (collapsed.length > 0 && collapsed[0] === "") collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed.join("\n");
}
function buildTherapistMessage(inp, prices, fmt) {
  const base = prices.coursePrice[inp.courseMinutes] ?? 0;
  const unit = Math.max(1, prices.extensionUnitMinutes);
  const extPrice = Math.floor(Math.max(0, inp.extensionMinutes || 0) / unit) * Math.max(0, prices.extensionUnitPrice);
  const discount = Math.max(0, inp.discountAmount || 0);
  let amount = base + extPrice + Math.max(0, inp.nominationFeeApplied || 0) - discount;
  if (amount < 0) amount = 0;
  const totalMinutes = Math.max(0, inp.courseMinutes || 0) + Math.max(0, inp.extensionMinutes || 0);
  const nomPhrase = (fmt.nomPhrases || []).find(m => m.input === (inp.nominationType || ""));
  const vars = {
    "開始": fmtMsgTime(inp.start),
    "終了": fmtMsgTime(inp.end),
    "分": totalMinutes > 0 ? String(totalMinutes) : "",
    "コース": inp.courseMinutes > 0 ? String(inp.courseMinutes) : "",
    "延長": inp.extensionMinutes > 0 ? String(inp.extensionMinutes) : "",
    "属性": resolveAttrDisplay(fmt.attrMap, inp.customerAttr || "", inp.nominationType || ""),
    "顧客名": inp.customer || "",
    "下四桁": inp.phoneLast4 || "",
    "金額": amount > 0 ? String(amount) : "",
    "割引": discount > 0 ? String(discount) : "",
    "指名文言": nomPhrase ? (nomPhrase.output || "") : "",
    "指名": inp.nominationType || "",
    "セラピスト": inp.therapistName || "",
    "OP": inp.opFlag || "",
    "メモ": inp.memo || ""
  };
  return renderSendTemplate(fmt.therapistTemplate, vars);
}

// 重複検出(PC: FindOverlaps)
function findOverlaps(reservations, r, editId) {
  const s = normSpan(r.start), e0 = normSpan(r.end);
  const e = e0 <= s ? e0 + 24 * 60 : e0;
  return reservations.filter(x => {
    if (x.therapistId !== r.therapistId) return false;
    if (editId && x.id === editId) return false;
    let xs = normSpan(x.start), xe = normSpan(x.end);
    if (xe <= xs) xe += 24 * 60;
    return s < xe && e > xs;
  });
}

// 退勤超過(PC: IsOverEndOfShift)
function isOverShiftEnd(attendance, r) {
  const a = attendance.find(x => x.therapistId === r.therapistId);
  if (!a || a.endMin == null) return false;
  const { e } = normAttendance(a);
  return normSpan(r.end) > e;
}

// 仮押さえセル集合 → 連続レンジ [{s,e}(分)]
function holdCellsToRanges(cols) {
  const sorted = [...cols].sort((a, b) => a - b);
  const out = [];
  let st = null, prev = null;
  for (const c of sorted) {
    if (st === null) { st = prev = c; continue; }
    if (c === prev + 1) { prev = c; continue; }
    out.push({ s: BIZ_START_MIN + st * MINUTE_STEP, e: BIZ_START_MIN + (prev + 1) * MINUTE_STEP });
    st = prev = c;
  }
  if (st !== null) out.push({ s: BIZ_START_MIN + st * MINUTE_STEP, e: BIZ_START_MIN + (prev + 1) * MINUTE_STEP });
  return out;
}

/* レポート1行(PC: ReportBuilder.FormatLine 移植) */
function reportFormatLine(r) {
  const start = fmtNormal(r.start); // ★M-V12.5: 出力統一のため24時以降は巻き戻す表記
  let dur = `${r.courseMinutes}分`;
  if ((r.extensionMinutes || 0) > 0) dur += `+${r.extensionMinutes}分`;
  const cust = (r.customer || "").trim();
  const last4 = (r.phoneLast4 || "").trim();
  const attr = (r.customerAttr || "").trim();
  const nom = (r.nominationType || "").trim();
  let attrNom = "";
  if (attr !== "" || nom !== "") attrNom = ` ${attr}/${nom} `;
  let opt = "";
  // 2000円以上の割引のみ表示(例: ［2000割］)。PAYPAYは［PAY］
  if ((r.discountAmount || 0) >= 2000) opt += `［${r.discountAmount}割］`;
  if ((r.paymentType || "").trim().toUpperCase() === "PAYPAY") opt += "［PAY］";
  return `${start}～${dur}${attrNom}${cust}様${last4}${opt}`;
}

/* レポート全体(PC: ReportBuilder.Build 移植)
 * items: 予約配列(therapistName付与済み) → {text, count} */
function buildReport(items, includeA, includeB) {
  const filtered = items.filter(r =>
    (r.type === "A" && includeA) || (r.type === "B" && includeB));
  const groups = new Map();
  for (const r of filtered) {
    const key = (r.therapistName || "").trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const keys = [...groups.keys()].sort(); // Ordinal(コードポイント順)
  const lines = [];
  let first = true;
  for (const k of keys) {
    if (!first) lines.push("");
    first = false;
    lines.push(`★${k}`);
    for (const r of groups.get(k).sort((a, b) => a.start - b.start)) {
      lines.push(reportFormatLine(r));
    }
  }
  return { text: lines.join("\n"), count: filtered.length };
}

/* セラピスト検索(PC: FilterPredicate 移植: 部分一致 or 編集距離<=2) */
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  return dp[a.length][b.length];
}
function therapistMatches(name, query) {
  const q = (query || "").trim();
  if (q === "") return true;
  const n = (name || "").trim();
  if (n === "") return false;
  if (n.toLowerCase().includes(q.toLowerCase())) return true;
  return levenshtein(n.toLowerCase(), q.toLowerCase()) <= 2;
}

/* メモ自動生成(PC: BuildMemo 移植) 顔:{}/体:{}/寛:{}/{指名料}/[{注意点}] */
function buildTherapistMemo(face, body, kan, fee, caution) {
  const c = (caution || "").trim();
  return `顔:${face}/体:${body}/寛:${kan}/${fee}/[${c}]`;
}

/* ================= Node テスト用エクスポート ================= */
if (typeof module !== "undefined") {
  module.exports = {
    parseBizTime, fmtBiz, fmtNormal, getBusinessDate, mapNowToBizMin, defaultBaseMin,
    parseIntervalMinutes, tryFindEarliestSlot, maxText, sanName, padName,
    calcEnd, calcTotal, findOverlaps, isOverShiftEnd, holdCellsToRanges, normAttendance,
    reportFormatLine, buildReport, levenshtein, therapistMatches, buildTherapistMemo,
    findSlotForCourse, maxTextEx, findLastSlotForCourse
  };
}
if (typeof window === "undefined") {
  // Node環境ではここで終了(以降はブラウザUI)
} else {

/* =====================================================================
 * ここからブラウザUI
 * ===================================================================== */

/* ================= 永続化(localStorage) ================= */
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { alert("保存に失敗しました: " + e.message); return false; }
  }
};
const K = {
  therapists: "este.therapists",
  attendance: d => `este.attendance.${d}`,
  reservations: d => `este.reservations.${d}`,
  holds: d => `este.holds.${d}`,
  sendQueue: "este.sendQueue",
  prices: "este.prices",
  discounts: "este.discounts",
  snsFormat: "este.snsFormat",
  sendFormat: "este.sendFormat", // ★M-V12: 送信文フォーマット(PC V4.0〜と共通・同期対象)
  seq: "este.therapistSeq"
};

function loadTherapists() { return LS.get(K.therapists, []); }
function touchMeta(key) { LS.set("este.meta." + key, Date.now()); }
function saveTherapists(list) { LS.set(K.therapists, list); touchMeta(K.therapists); }
function loadAttendance(d) { return LS.get(K.attendance(d), []); }
function saveAttendance(d, list) { LS.set(K.attendance(d), list); touchMeta(K.attendance(d)); }
function loadReservations(d) { return LS.get(K.reservations(d), []); }
function saveReservations(d, list) { LS.set(K.reservations(d), list); touchMeta(K.reservations(d)); }
function loadHolds(d) { return LS.get(K.holds(d), []); }
function saveHolds(d, list) { LS.set(K.holds(d), list); touchMeta(K.holds(d)); }
function loadSendQueue() { return LS.get(K.sendQueue, {}); }
function saveSendQueue(q) { LS.set(K.sendQueue, q); }
function loadPrices() {
  return LS.get(K.prices, {
    coursePrice: { 60: 15000, 80: 20000, 100: 25000, 120: 30000 },
    extensionUnitMinutes: 20, extensionUnitPrice: 5000, opPrice: 5000
  });
}
function savePrices(p) { LS.set(K.prices, p); touchMeta(K.prices); }
function saveDiscounts(d) { LS.set(K.discounts, d); touchMeta(K.discounts); }
const DEFAULT_SETTINGS = {
  staffs: [],
  attrs: ["N", "R"],
  nomTypes: [
    { name: "F", fee: false }, { name: "写", fee: false },
    { name: "本", fee: true }, { name: "姫", fee: false }
  ],
  options: [{ name: "有", price: 5000 }],
  areas: ["A", "B"],
  calc: { prep: 15, defaultInterval: 20, roundTo: 5 }
};
function loadSettings() {
  const s = LS.get("este.settings", null);
  if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  // 欠損補完(旧バージョンからの移行)
  const d = DEFAULT_SETTINGS;
  return {
    staffs: Array.isArray(s.staffs) ? s.staffs : [],
    attrs: Array.isArray(s.attrs) && s.attrs.length ? s.attrs : d.attrs.slice(),
    nomTypes: Array.isArray(s.nomTypes) && s.nomTypes.length ? s.nomTypes : JSON.parse(JSON.stringify(d.nomTypes)),
    options: Array.isArray(s.options) ? s.options : JSON.parse(JSON.stringify(d.options)),
    areas: Array.isArray(s.areas) && s.areas.length ? s.areas : d.areas.slice(),
    calc: {
      prep: s.calc && Number.isFinite(s.calc.prep) ? s.calc.prep : d.calc.prep,
      defaultInterval: s.calc && Number.isFinite(s.calc.defaultInterval) ? s.calc.defaultInterval : d.calc.defaultInterval,
      roundTo: s.calc && Number.isFinite(s.calc.roundTo) && s.calc.roundTo >= 1 ? s.calc.roundTo : d.calc.roundTo
    }
  };
}
function saveSettings(s) { LS.set("este.settings", s); touchMeta("este.settings"); }
let CFG = null; // 起動時と設定保存時に更新
function loadDiscounts() { return LS.get(K.discounts, [0, 1000, 2000, 3000, 5000]); }
function loadSnsFormat() { return LS.get(K.snsFormat, { header: "", footer: "" }); }
function saveSnsFormat(f) { LS.set(K.snsFormat, f); }

/* ★M-V12: 送信文フォーマット(セラピスト向け)。PC版 V4.0〜 と同一のJSON構造・同一の出力。
   attrMap: 属性表示ルール [{input:属性, nom:指名, output:表示}] 空欄は任意一致・上から先勝ち
   nomPhrases: 指名文言 [{input:指名種別, output:文言}] */
const DEFAULT_SEND_FORMAT = {
  therapistTemplate:
    "ご予約いただきまして、\n" +
    "{開始}〜{分}分\n" +
    "{属性}　{顧客名}様\n" +
    "{金額}円+オプション確認お願いします！\n" +
    "\n" +
    "{割引}円割引適用になります🙏\n" +
    "{指名文言}\n" +
    "よろしくお願いいたします🙏",
  attrMap: [
    { input: "", nom: "本", output: "本指名" },
    { input: "", nom: "姫", output: "姫予約" },
    { input: "R", nom: "", output: "リピーター" },
    { input: "N", nom: "", output: "新規" }
  ],
  nomPhrases: [
    { input: "本", output: "本指名様、ありがとうございます！" }
  ]
};
function loadSendFormat() {
  const raw = LS.get(K.sendFormat, null);
  const d = JSON.parse(JSON.stringify(DEFAULT_SEND_FORMAT));
  if (!raw || typeof raw !== "object") return d;
  const c = {
    therapistTemplate: typeof raw.therapistTemplate === "string" && raw.therapistTemplate.trim()
      ? raw.therapistTemplate : d.therapistTemplate,
    attrMap: Array.isArray(raw.attrMap) ? raw.attrMap : [],
    nomPhrases: Array.isArray(raw.nomPhrases) ? raw.nomPhrases : []
  };
  // 正規化(PC: NormalizeSendFormat と同一): 3項目すべて空の行は除去
  c.attrMap = c.attrMap
    .filter(r => r && typeof r === "object")
    .map(r => ({ input: String(r.input ?? "").trim(), nom: String(r.nom ?? "").trim(), output: String(r.output ?? "").trim() }))
    .filter(r => r.input !== "" || r.nom !== "" || r.output !== "");
  c.nomPhrases = c.nomPhrases
    .filter(m => m && typeof m === "object")
    .map(m => ({ input: String(m.input ?? "").trim(), output: String(m.output ?? "").trim() }))
    .filter(m => m.input !== "");
  // PC V4.0/4.1 の旧初期値(R/Nの2行のみ)なら新初期値へ自動アップグレード(PC: LoadSendFormat と同一)
  if (c.attrMap.length === 2 &&
      c.attrMap[0].input === "R" && c.attrMap[0].nom === "" && c.attrMap[0].output === "リピーター" &&
      c.attrMap[1].input === "N" && c.attrMap[1].nom === "" && c.attrMap[1].output === "新規") {
    c.attrMap = JSON.parse(JSON.stringify(d.attrMap));
  }
  return c;
}
function saveSendFormat(f) { LS.set(K.sendFormat, f); touchMeta(K.sendFormat); }
function nextTherapistId() {
  const n = LS.get(K.seq, 0) + 1; LS.set(K.seq, n); return n;
}
function newGuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function AREAS() { return CFG.areas; }
function loadCurrentStaff() { return LS.get("este.currentStaff", ""); }
function saveCurrentStaff(v) { LS.set("este.currentStaff", v); }
function refreshStaffChip() {
  const cur = loadCurrentStaff();
  document.getElementById("staffLink").textContent = "担当: " + (cur || "-");
}
function IV(t) { return parseIntervalMinutes(t.interval, CFG.calc.defaultInterval); }
CFG = loadSettings();

/* ================= アプリ状態 ================= */
const state = {
  dateKey: getBusinessDate(new Date()),
  mode: "accept",        // accept | hold
  therapists: [],
  attendance: [],
  reservations: [],
  holdCells: {},         // therapistId -> Set(col)
  shortestBaseMin: null, // 最短パネルの基準(分)
  editing: null          // {id} 編集中予約
};

function presentTherapists() {
  const out = [];
  for (const a of state.attendance) {
    const t = state.therapists.find(x => x.id === a.therapistId);
    if (t) out.push({ t, a });
  }
  return out;
}

function reloadDate() {
  state.attendance = loadAttendance(state.dateKey);
  state.reservations = loadReservations(state.dateKey);
  state.holdCells = {};
  for (const h of loadHolds(state.dateKey)) {
    const col = Math.floor((normSpan(h.startMin) - BIZ_START_MIN) / MINUTE_STEP);
    if (col < 0 || col >= COLUMNS) continue;
    (state.holdCells[h.therapistId] ||= new Set()).add(col);
  }
  state.shortestBaseMin = defaultBaseMin(state.dateKey, new Date(), CFG.calc.roundTo);
  render();
  refreshSendBadge();
}

/* ================= 送信待機(登録・状態のみ / 一覧UIはM-V2) ================= */
function enqueueSend(id) {
  const q = loadSendQueue();
  q[id] = q[id] || { date: state.dateKey, customer: false, therapist: false };
  saveSendQueue(q);
}
function dequeueSend(id) {
  const q = loadSendQueue(); delete q[id]; saveSendQueue(q);
}
function setSendStatus(id, c, t) {
  const q = loadSendQueue();
  if (!q[id]) q[id] = { date: state.dateKey, customer: false, therapist: false };
  q[id].customer = c; q[id].therapist = t;
  saveSendQueue(q);
}
function getSendStatus(id) {
  const q = loadSendQueue();
  if (!q[id]) return { tracked: false, customer: false, therapist: false };
  return { tracked: true, customer: !!q[id].customer, therapist: !!q[id].therapist };
}
function findQueueReservation(entry, id) {
  const list = loadReservations(entry.date);
  return list.find(r => r.id === id) || null;
}
// 未送信一覧: 予約実体と結合し、消えた予約はキューから掃除(PC版のJOIN相当)
function loadPendingSends() {
  const q = loadSendQueue();
  const out = [];
  let dirty = false;
  for (const [id, entry] of Object.entries(q)) {
    const r = findQueueReservation(entry, id);
    if (!r) { delete q[id]; dirty = true; continue; }
    if (entry.customer && entry.therapist) continue;
    const t = state.therapists.find(x => x.id === r.therapistId);
    out.push({
      id, date: entry.date, startMin: r.start,
      therapistName: t ? t.name : "",
      customer: r.customer, phoneLast4: r.phoneLast4,
      customerDone: !!entry.customer, therapistDone: !!entry.therapist
    });
  }
  if (dirty) saveSendQueue(q);
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
}
function countPendingSends() {
  return loadPendingSends().length;
}
function refreshSendBadge() {
  const el = document.getElementById("sendBadge");
  const n = countPendingSends();
  el.textContent = n;
  el.style.display = n > 0 ? "inline-block" : "none";
  document.getElementById("btnSendQueue").classList.toggle("alert", n > 0);
}

/* ================= レンダリング ================= */
const CELL_W = 22, ROW_H = 56, LEFT_W = 96, HEAD_H = 26;
const X = min => Math.round((min - BIZ_START_MIN) / MINUTE_STEP * CELL_W);

function render() {
  document.getElementById("dateLabel").textContent = fmtDateLabel(state.dateKey);
  document.getElementById("modeLink").textContent = state.mode === "hold" ? "仮押さえ" : "受付";
  document.getElementById("modeLink").classList.toggle("holdmode", state.mode === "hold");

  const rows = document.getElementById("rows");
  rows.innerHTML = "";
  const present = presentTherapists();
  const inner = document.getElementById("ttInner");
  inner.style.width = (LEFT_W + COLUMNS * CELL_W) + "px";

  if (present.length === 0) {
    rows.innerHTML = `<div class="empty">出勤登録がありません。<br>右上の「出勤」から登録してください。</div>`;
  }

  present.forEach(({ t, a }, rowIdx) => {
    const { s: attS, e: attE } = normAttendance(a);
    const row = document.createElement("div");
    row.className = "row";
    const cautionLine = (t.caution || "").split(/\r?\n/)[0] || "";
    const areaTag = AREAS().includes(a.area) ? `<span class="area-tag">${a.area}</span>` : "";
    row.innerHTML = `<div class="th-name"><span class="nm">${areaTag}${esc(t.name)}</span><small>${fmtBiz(a.startMin ?? BIZ_START_MIN)}〜${fmtBiz(a.endMin ?? 30 * 60)}</small>${cautionLine ? `<small class="cau">${esc(cautionLine)}</small>` : ""}</div>`;
    row.querySelector(".th-name").addEventListener("click", () => openCautionEditor(t.id));
    const cells = document.createElement("div");
    cells.className = "cells";

    // 縦線
    for (let h = 0; h <= 24; h++) {
      const v = document.createElement("div");
      v.className = "vline h"; v.style.left = (h * 6 * CELL_W) + "px";
      cells.appendChild(v);
      if (h < 24) for (let k = 1; k < 6; k++) {
        const v2 = document.createElement("div");
        v2.className = "vline"; v2.style.left = (h * 6 * CELL_W + k * CELL_W) + "px";
        cells.appendChild(v2);
      }
    }
    // 出勤外グレー
    addBlock(cells, "off", 0, X(attS));
    addBlock(cells, "off", X(Math.min(attE, BIZ_END_MIN + 1)), COLUMNS * CELL_W - X(Math.min(attE, BIZ_END_MIN + 1)));

    // インターバル(黄): 各予約の終了〜終了+IV、次予約開始でクリップ
    const myRes = state.reservations.filter(r => r.therapistId === t.id)
      .map(r => ({ ...r, s: normSpan(r.start), e: normSpan(r.end) }))
      .sort((x, y) => x.s - y.s);
    const iv = IV(t);
    for (const r of myRes) {
      let ge = r.e + iv;
      const nexts = myRes.filter(x => x.s > r.e).map(x => x.s);
      if (nexts.length) ge = Math.min(ge, Math.min(...nexts));
      if (ge > r.e) {
        const d = document.createElement("div");
        d.className = "itv";
        d.style.left = X(r.e) + "px"; d.style.width = Math.max(CELL_W / 2, X(ge) - X(r.e)) + "px";
        cells.appendChild(d);
      }
    }

    // 予約ブロック
    for (const r of myRes) {
      const d = document.createElement("div");
      d.className = "res " + (r.type === "A" ? "A" : "B");
      d.style.left = X(r.s) + "px";
      d.style.width = Math.max(CELL_W * 3, X(Math.min(r.e, BIZ_END_MIN + 1)) - X(r.s)) + "px";
      let badge = "";
      if (r.nominationType === "本") badge = "［本］";
      else if (!r.nominationType) badge = "［未］";
      const line2 = `${fmtBiz(r.s)}〜${fmtBiz(r.e)}（${fmtBiz(r.e + iv)}〜）`;
      d.innerHTML = `<b>${esc(r.customer)}<span class="bd${badge === "［本］" ? " red" : ""}">${badge}</span> ${esc(r.phoneLast4)}</b><span>${line2}</span>`;
      d.addEventListener("click", ev => { ev.stopPropagation(); openReservationForm(r.id); });
      cells.appendChild(d);
    }

    // 仮押さえ(赤帯)
    const set = state.holdCells[t.id];
    if (set && set.size) {
      for (const rg of holdCellsToRanges(set)) {
        const d = document.createElement("div");
        d.className = "hold";
        d.style.left = X(rg.s) + "px"; d.style.width = (X(rg.e) - X(rg.s)) + "px";
        cells.appendChild(d);
      }
    }

    // セルタップ
    cells.addEventListener("click", ev => {
      const rect = cells.getBoundingClientRect();
      const col = Math.max(0, Math.min(COLUMNS - 1, Math.floor((ev.clientX - rect.left) / CELL_W)));
      if (state.mode === "hold") {
        toggleHold(t.id, col);
      } else {
        const startMin = BIZ_START_MIN + col * MINUTE_STEP;
        openReservationForm(null, { therapistId: t.id, startMin, lockTherapist: true });
      }
    });

    row.appendChild(cells);
    rows.appendChild(row);
  });

  // 現在時刻ライン
  const old = document.getElementById("nowline");
  if (old) old.remove();
  if (state.dateKey === getBusinessDate(new Date())) {
    const nowMin = mapNowToBizMin(new Date()) + (new Date().getMinutes() % 10); // 分精度
    const nl = document.createElement("div");
    nl.id = "nowline"; nl.className = "nowline";
    nl.style.left = (LEFT_W + X(nowMin)) + "px";
    inner.appendChild(nl);
  }
}

function addBlock(parent, cls, left, width) {
  if (width <= 0) return;
  const d = document.createElement("div");
  d.className = cls;
  d.style.left = left + "px"; d.style.width = width + "px";
  parent.appendChild(d);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDateLabel(key) {
  const d = dateKeyToDate(key);
  const w = "日月火水木金土"[d.getDay()];
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} (${w})`;
}

/* ================= 仮押さえ ================= */
function toggleHold(tid, col) {
  const set = (state.holdCells[tid] ||= new Set());
  if (set.has(col)) set.delete(col); else set.add(col);
  persistHolds();
  render();
}
function persistHolds() {
  const items = [];
  for (const [tid, set] of Object.entries(state.holdCells)) {
    for (const col of set) items.push({ therapistId: Number(tid), startMin: BIZ_START_MIN + col * MINUTE_STEP });
  }
  saveHolds(state.dateKey, items);
}

/* ================= 日付操作 ================= */
function shiftDate(days) {
  const d = dateKeyToDate(state.dateKey);
  d.setDate(d.getDate() + days);
  state.dateKey = toDateKey(d);
  reloadDate();
}
document.getElementById("prevDay").addEventListener("click", () => shiftDate(-1));
document.getElementById("nextDay").addEventListener("click", () => shiftDate(1));
document.getElementById("dateLabel").addEventListener("click", () => {
  const inp = document.getElementById("datePick");
  inp.value = state.dateKey;
  try { if (inp.showPicker) { inp.showPicker(); return; } } catch {}
  inp.focus(); inp.click();
});
document.getElementById("datePick").addEventListener("change", e => {
  if (e.target.value) { state.dateKey = e.target.value; reloadDate(); }
});
document.getElementById("modeLink").addEventListener("click", () => {
  state.mode = state.mode === "accept" ? "hold" : "accept";
  render();
});

/* ================= 現在時刻ジャンプ ================= */
document.getElementById("btnNow").addEventListener("click", () => {
  closeSheets();
  const target = (state.dateKey === getBusinessDate(new Date())) ? mapNowToBizMin(new Date()) : BIZ_START_MIN;
  const tt = document.getElementById("tt");
  tt.scrollLeft = Math.max(0, LEFT_W + X(target) - tt.clientWidth / 2);
});

/* ================= 出勤登録 ================= */
const attSheet = document.getElementById("attSheet");
document.getElementById("btnAttendance").addEventListener("click", () => { closeSheets(); openAttendance(); });

/* 出勤登録: 検索して追加方式(M-V10)
 * 上部の検索(部分一致+あいまい一致)から候補をタップして行を追加する。
 * 追加済みの行: 名前(固定) / 出勤 / 終了 / エリア / 削除 */
function attAddedIds() {
  return new Set([...document.querySelectorAll("#attRows .att-entry")]
    .map(el => Number(el.dataset.tid)));
}
function attRefreshEmpty() {
  const empty = document.getElementById("attEmpty");
  empty.classList.toggle("show", document.querySelectorAll("#attRows .att-entry").length === 0);
}
function attAddRow(t, cur, focusStart) {
  const body = document.getElementById("attRows");
  const wrap = document.createElement("div"); // ★M-V12.5: 出勤行+SNS表示補足をまとめる当日限りの入れ物
  wrap.className = "att-entry";
  wrap.dataset.tid = String(t.id);
  const tr = document.createElement("div");
  tr.className = "att-row";
  const nm = document.createElement("div");
  nm.className = "nm-label";
  nm.textContent = t.name;
  const s = document.createElement("input");
  s.placeholder = "出勤"; s.inputMode = "numeric"; s.className = "tm";
  const e = document.createElement("input");
  e.placeholder = "終了"; e.inputMode = "numeric"; e.className = "tm";
  const ar = document.createElement("select");
  ar.className = "ar";
  ar.innerHTML = AREAS().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if (cur) {
    s.value = fmtBiz(cur.startMin); e.value = fmtBiz(cur.endMin);
    if (AREAS().includes(cur.area)) ar.value = cur.area;
  }
  [s, e].forEach(inp => inp.addEventListener("blur", () => {
    const v = parseBizTime(inp.value);
    if (inp.value.trim() !== "") inp.value = v == null ? inp.value : fmtBiz(v);
  }));
  const del = document.createElement("button");
  del.className = "x-del";
  del.textContent = "×";
  del.addEventListener("click", () => {
    wrap.remove();
    attRefreshEmpty();
    renderAttSuggestions(); // 候補に戻す
  });
  tr.append(nm, s, e, ar, del);
  const sns = document.createElement("input"); // ★M-V12.5: SNS表示補足(この日の出勤データにのみ紐づく・翌日には残らない)
  sns.className = "att-sns";
  sns.placeholder = "SNS表示補足(最短取得コピー用・任意・例: 23:00まで)";
  if (cur && cur.snsSuffix) sns.value = cur.snsSuffix;
  wrap.append(tr, sns);
  body.appendChild(wrap);
  attRefreshEmpty();
  if (focusStart) s.focus();
}
function renderAttSuggestions() {
  const q = document.getElementById("attSearch").value.trim();
  const sug = document.getElementById("attSug");
  if (q === "") { sug.classList.remove("show"); sug.innerHTML = ""; return; }
  const added = attAddedIds();
  const hits = state.therapists
    .filter(t => !added.has(t.id) && therapistMatches(t.name, q))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "ja"))
    .slice(0, 8);
  sug.innerHTML = "";
  for (const t of hits) {
    const b = document.createElement("button");
    b.textContent = t.name;
    b.addEventListener("click", () => {
      attAddRow(t, null, true);
      document.getElementById("attSearch").value = "";
      renderAttSuggestions();
    });
    sug.appendChild(b);
  }
  // 完全一致が無ければ新規登録を提示(未追加の同名がいない場合)
  const exact = state.therapists.some(t => t.name === q);
  if (!exact) {
    const b = document.createElement("button");
    b.className = "new";
    b.textContent = `＋「${q}」を新規登録して追加`;
    b.addEventListener("click", () => {
      const t = {
        id: nextTherapistId(), name: q, nominationFee: 1000, maxCourse: 120,
        caution: "", interval: "20", memo: ""
      };
      state.therapists.push(t);
      saveTherapists(state.therapists);
      attAddRow(t, null, true);
      document.getElementById("attSearch").value = "";
      renderAttSuggestions();
      toast(`${q} を登録しました`);
    });
    sug.appendChild(b);
  }
  sug.classList.toggle("show", sug.children.length > 0);
}
document.getElementById("attSearch").addEventListener("input", renderAttSuggestions);

function openAttendance() {
  document.getElementById("attSearch").value = "";
  document.getElementById("attSug").classList.remove("show");
  const body = document.getElementById("attRows");
  body.innerHTML = "";
  for (const cur of state.attendance) {
    const t = state.therapists.find(x => x.id === cur.therapistId);
    if (t) attAddRow(t, cur, false);
  }
  attRefreshEmpty();
  openSheet(attSheet);
}
document.getElementById("attSave").addEventListener("click", () => {
  const out = [];
  const errs = [];
  for (const wrap of document.querySelectorAll("#attRows .att-entry")) {
    const tid = Number(wrap.dataset.tid);
    const tr = wrap.querySelector(".att-row");
    const [, s, e, ar] = tr.children;
    const snsSuffix = wrap.querySelector(".att-sns").value.trim(); // ★M-V12.5
    const sv = parseBizTime(s.value), ev = parseBizTime(e.value);
    const t = state.therapists.find(x => x.id === tid);
    const nm = t ? t.name : "?";
    if (sv == null || ev == null) { errs.push(`${nm}: 出勤・終了時刻を入力してください(例: 1200 / 2630)`); continue; }
    out.push({ therapistId: tid, startMin: sv, endMin: ev, area: ar.value, snsSuffix });
  }
  if (errs.length) { alert(errs.join("\n")); return; }
  state.attendance = out;
  saveAttendance(state.dateKey, out);
  closeSheets();
  render();
});

/* ================= 最短取得 ================= */
const shortSheet = document.getElementById("shortSheet");
let shortestArea = "全"; // 最短取得のエリアフィルタ
let slotArea = "全";     // 空枠検索のエリアフィルタ
function buildAreaSeg(containerId, current) {
  const el = document.getElementById(containerId);
  el.innerHTML = ["全", ...AREAS()].map(v =>
    `<button data-v="${esc(v)}"${v === current ? ' class="on"' : ""}>${esc(v)}</button>`).join("");
}
document.getElementById("shortArea").addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  shortestArea = btn.dataset.v;
  document.querySelectorAll("#shortArea button").forEach(b =>
    b.classList.toggle("on", b.dataset.v === shortestArea));
  renderShortest();
});
document.getElementById("slotArea").addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  slotArea = btn.dataset.v;
  document.querySelectorAll("#slotArea button").forEach(b =>
    b.classList.toggle("on", b.dataset.v === slotArea));
  // 検索結果が出ていれば再検索
  if (document.querySelector("#slotResult table")) runSlotSearch();
});
document.getElementById("btnShortest").addEventListener("click", () => {
  // 深夜帯は前営業日へ自動補正(PC: AutoAdjustSelectedDateForOverMidnightBusiness)
  const now = new Date();
  if (now.getHours() < CUTOFF_HOUR && state.dateKey === toDateKey(now)) {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    state.dateKey = toDateKey(d);
    reloadDate();
  }
  state.shortestBaseMin = defaultBaseMin(state.dateKey, new Date(), CFG.calc.roundTo);
  document.getElementById("baseTime").value = fmtBiz(state.shortestBaseMin);
  shortestArea = "全";
  buildAreaSeg("shortArea", "全");
  renderShortest();
  openSheet(shortSheet);
});
document.getElementById("baseNow").addEventListener("click", () => {
  state.shortestBaseMin = defaultBaseMin(state.dateKey, new Date(), CFG.calc.roundTo);
  document.getElementById("baseTime").value = fmtBiz(state.shortestBaseMin);
  renderShortest();
});
document.getElementById("baseRecalc").addEventListener("click", recalcBase);
document.getElementById("baseTime").addEventListener("blur", recalcBase);
function recalcBase() {
  const v = parseBizTime(document.getElementById("baseTime").value);
  if (v == null) { document.getElementById("baseTime").value = fmtBiz(state.shortestBaseMin); return; }
  state.shortestBaseMin = Math.floor(v / CFG.calc.roundTo) * CFG.calc.roundTo;
  document.getElementById("baseTime").value = fmtBiz(state.shortestBaseMin);
  renderShortest();
}

function computeCandidates(baseMin) {
  const out = [];
  for (const { t, a } of presentTherapists()) {
    const interval = IV(t);
    const blocks = state.reservations.filter(r => r.therapistId === t.id)
      .map(r => ({ s: r.start, e: r.end, hold: false }));
    const set = state.holdCells[t.id];
    if (set && set.size) blocks.push(...holdCellsToRanges(set).map(rg => ({ ...rg, hold: true })));
    const f = tryFindEarliestSlot(a, blocks, baseMin, interval, CFG.calc.prep);
    out.push({
      therapistId: t.id, name: t.name, cap: t.maxCourse ?? 120,
      startMin: f.found ? f.startMin : null,
      maxMinutes: (f.found && f.maxCourse >= 60) ? f.maxCourse : 0
    });
  }
  return out.sort((x, y) => (x.maxMinutes <= 0 ? 1 : 0) - (y.maxMinutes <= 0 ? 1 : 0) || (x.startMin ?? 1e9) - (y.startMin ?? 1e9));
}

function renderShortest() {
  const base = state.shortestBaseMin;
  // エリアフィルタ: 出勤登録のエリアで絞り込み(「全」は全員)
  const areaOf = new Map(state.attendance.map(a => [a.therapistId, a.area]));
  const cands = computeCandidates(base)
    .filter(c => c.maxMinutes === 0 || c.startMin >= base)
    .filter(c => shortestArea === "全" || areaOf.get(c.therapistId) === shortestArea);
  const snsSuffixOf = new Map(state.attendance.map(a => [a.therapistId, (a.snsSuffix || "").trim()])); // ★M-V12.5: この日の出勤データから(翌日には残らない)
  const tb = document.getElementById("candBody");
  tb.innerHTML = "";
  for (const c of cands) {
    const tr = document.createElement("tr");
    tr.className = c.maxMinutes > 0 ? "ok" : "ng";
    tr.innerHTML = `<td>${esc(c.name)}</td><td>${c.maxMinutes > 0 ? fmtBiz(c.startMin) : "—"}</td><td>${c.maxMinutes > 0 ? maxText(c.maxMinutes, c.cap) : "本日受付終了"}</td><td></td>`;
    if (c.maxMinutes > 0) {
      tr.addEventListener("click", () => {
        closeSheets();
        openReservationForm(null, { therapistId: c.therapistId, startMin: c.startMin, lockTherapist: true });
      });
      // ★M-V12.5: 最短取得の画面からSNS表示補足を直接編集(出勤登録を開かずに済む・当日のみ有効)
      const cur = snsSuffixOf.get(c.therapistId) || "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cand-sns-btn" + (cur ? " set" : "");
      btn.textContent = cur || "＋補足";
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        const v = prompt(`${c.name} さんの補足(SNSコピーの「〜」の直後に付く文言・今日のみ有効)`, cur);
        if (v === null) return;
        const idx = state.attendance.findIndex(a => a.therapistId === c.therapistId);
        if (idx < 0) return; // 出勤データが無い(通常は起こらない)
        state.attendance[idx] = { ...state.attendance[idx], snsSuffix: v.trim() };
        saveAttendance(state.dateKey, state.attendance);
        renderShortest();
      });
      tr.children[3].appendChild(btn);
    }
    tb.appendChild(tr);
  }
  // SNSテキスト
  const fm = loadSnsFormat();
  const lines = [];
  if (fm.header && fm.header.trim()) { lines.push(fm.header); lines.push(""); }
  for (const c of cands) {
    if (c.maxMinutes <= 0) continue;
    const suffix = snsSuffixOf.get(c.therapistId) || ""; // ★M-V12.5: セラピスト別「〜」の後の固定文言(当日のみ)
    lines.push(`${padName(sanName(c.name), 5)} ${fmtNormal(c.startMin)}〜${suffix}`);
  }
  if (fm.footer && fm.footer.trim()) { lines.push(""); lines.push(fm.footer); }
  document.getElementById("snsText").value = lines.join("\n");
}
document.getElementById("snsCopy").addEventListener("click", async () => {
  const txt = document.getElementById("snsText").value;
  try { await navigator.clipboard.writeText(txt); toast("コピーしました"); }
  catch {
    const ta = document.getElementById("snsText");
    ta.focus(); ta.select();
    document.execCommand && document.execCommand("copy");
    toast("コピーしました");
  }
});
document.getElementById("snsFormat").addEventListener("click", () => {
  const fm = loadSnsFormat();
  const h = prompt("ヘッダー(冒頭に付ける文)", fm.header ?? "");
  if (h === null) return;
  const f = prompt("フッター(末尾に付ける文)", fm.footer ?? "");
  if (f === null) return;
  saveSnsFormat({ header: h, footer: f });
  renderShortest();
});

/* ================= 空枠検索 ================= */
const slotSheet = document.getElementById("slotSheet");
document.getElementById("btnSlotSearch").addEventListener("click", () => {
  const present = presentTherapists();
  if (present.length === 0) { alert("先に出勤登録をしてください。"); return; }
  document.getElementById("slotTime").value = "";
  slotMode = "first";
  slotArea = "全";
  buildAreaSeg("slotArea", "全");
  document.getElementById("slotResult").innerHTML =
    `<div class="sq-empty">時刻とコースを指定して「検索」を押してください。<br>時刻が空白の場合は現在からの最短を検索します。</div>`;
  openSheet(slotSheet);
});
let slotMode = "first"; // first=最短 / last=ラスト枠
document.getElementById("slotRun").addEventListener("click", () => { slotMode = "first"; runSlotSearch(); });
document.getElementById("slotLast").addEventListener("click", () => { slotMode = "last"; runSlotSearch(); });
document.getElementById("slotTime").addEventListener("blur", () => {
  const el = document.getElementById("slotTime");
  if (el.value.trim() === "") return;
  const v = parseBizTime(el.value);
  if (v != null) el.value = fmtBiz(v);
});
function runSlotSearch() {
  const timeRaw = document.getElementById("slotTime").value.trim();
  let baseMin;
  if (timeRaw === "") {
    baseMin = defaultBaseMin(state.dateKey, new Date(), CFG.calc.roundTo);
  } else {
    const v = parseBizTime(timeRaw);
    if (v == null) { alert("時刻は4桁の数字で入力してください。例: 2130 / 空白=現在から"); return; }
    baseMin = Math.floor(v / CFG.calc.roundTo) * CFG.calc.roundTo;
    document.getElementById("slotTime").value = fmtBiz(baseMin);
  }
  const course = Number(document.getElementById("slotCourse").value);

  const rows = [];
  for (const { t, a } of presentTherapists()) {
    if (slotArea !== "全" && a.area !== slotArea) continue; // エリアフィルタ
    const interval = IV(t);
    const blocks = state.reservations.filter(r => r.therapistId === t.id)
      .map(r => ({ s: r.start, e: r.end, hold: false }));
    const set = state.holdCells[t.id];
    if (set && set.size) blocks.push(...holdCellsToRanges(set).map(rg => ({ ...rg, hold: true })));
    const f = slotMode === "last"
      ? findLastSlotForCourse(a, blocks, baseMin, interval, course, SEARCH_COURSES, CFG.calc.prep)
      : findSlotForCourse(a, blocks, baseMin, interval, course, SEARCH_COURSES, CFG.calc.prep);
    rows.push({
      therapistId: t.id, name: t.name, cap: t.maxCourse ?? 120,
      startMin: f.found ? f.startMin : null,
      maxCourse: f.found ? f.maxCourse : 0,
      ok: f.found && (f.found ? f.startMin >= baseMin : false)
    });
  }
  if (slotMode === "last") {
    rows.sort((x, y) => (x.ok ? 0 : 1) - (y.ok ? 0 : 1) || (y.startMin ?? -1) - (x.startMin ?? -1));
  } else {
    rows.sort((x, y) => (x.ok ? 0 : 1) - (y.ok ? 0 : 1) || (x.startMin ?? 1e9) - (y.startMin ?? 1e9));
  }

  const el = document.getElementById("slotResult");
  el.innerHTML = "";
  const table = document.createElement("table");
  const headLabel = slotMode === "last" ? "ラスト開始" : "最短開始";
  table.innerHTML = `<thead><tr><th>セラピスト</th><th>${headLabel}</th><th>最大対応コース</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = r.ok ? "ok" : "ng";
    const capMark = (r.ok && course > r.cap) ? " ⚠上限超" : "";
    tr.innerHTML = `<td>${esc(r.name)}${capMark ? `<br><small style="color:#c00000">${capMark.trim()}</small>` : ""}</td>` +
      `<td>${r.ok ? fmtBiz(r.startMin) : "—"}</td>` +
      `<td>${r.ok ? maxTextEx(r.maxCourse, r.cap, SEARCH_COURSES) : "対応不可"}</td>`;
    if (r.ok) {
      tr.addEventListener("click", () => {
        closeSheets();
        // 予約データのコースは最大120。140以上は「120+延長」に変換して入力済みにする
        const courseVal = Math.min(course, 120);
        const extVal = Math.max(0, course - 120);
        openReservationForm(null, {
          therapistId: r.therapistId, startMin: r.startMin,
          lockTherapist: true, presetCourse: courseVal, presetExt: extVal
        });
      });
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  el.appendChild(table);
}

/* ================= 予約入力フォーム ================= */
const formPage = document.getElementById("formPage");
let formCtx = null; // {editId, therapistLocked}

function openReservationForm(editId, seed) {
  const present = presentTherapists().map(p => p.t);
  if (present.length === 0) { alert("先に出勤登録をしてください。"); return; }

  const r = editId ? state.reservations.find(x => x.id === editId) : null;
  if (editId && !r) { alert("予約が見つかりません。"); return; }
  formCtx = { editId: editId || null };

  document.getElementById("formTitle").textContent = editId ? "予約編集" : "予約追加";
  document.getElementById("fSave").textContent = editId ? "更新" : "登録";
  const selT = document.getElementById("fTherapist");
  const targetTid = r ? r.therapistId : seed.therapistId;
  let opts = present.slice();
  // 編集対象のセラピストが出勤リストに無い場合も選択肢に含める(担当の化け防止)
  if (!opts.some(t => t.id === targetTid)) {
    const t0 = state.therapists.find(t => t.id === targetTid);
    if (t0) opts = [t0, ...opts];
  }
  selT.innerHTML = opts.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  selT.value = String(targetTid);
  selT.disabled = !!(seed && seed.lockTherapist);

  document.getElementById("fStart").value = fmtBiz(r ? r.start : seed.startMin);
  const selC = document.getElementById("fCourse");
  selC.innerHTML = `<option value=""></option>` + COURSES.map(c => `<option value="${c}">${c}</option>`).join("");
  selC.value = r && r.courseMinutes ? String(r.courseMinutes)
    : (seed && seed.presetCourse ? String(seed.presetCourse) : "");
  const selE = document.getElementById("fExt");
  let extOpts = `<option value="0"></option>`;
  for (let m = 20; m <= 200; m += 20) extOpts += `<option value="${m}">${m}</option>`;
  selE.innerHTML = extOpts;
  selE.value = r && r.extensionMinutes ? String(r.extensionMinutes)
    : (seed && seed.presetExt ? String(seed.presetExt) : "0");

  document.getElementById("fCustomer").value = r ? r.customer : "";
  document.getElementById("fPhone").value = r ? r.phoneLast4 : "";
  // 属性・指名・OPの選択肢は設定から生成(編集中の旧値がリストに無い場合も選べるよう追加)
  const attrVals = CFG.attrs.slice();
  if (r && r.customerAttr && !attrVals.includes(r.customerAttr)) attrVals.unshift(r.customerAttr);
  document.getElementById("fAttr").innerHTML =
    `<option value=""></option>` + attrVals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  const nomVals = CFG.nomTypes.map(n => n.name);
  if (r && r.nominationType && !nomVals.includes(r.nominationType)) nomVals.unshift(r.nominationType);
  document.getElementById("fNom").innerHTML =
    `<option value=""></option>` + nomVals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  const opVals = CFG.options.map(o => o.name);
  if (!opVals.includes("無")) opVals.push("無");
  if (r && r.opFlag && !opVals.includes(r.opFlag)) opVals.unshift(r.opFlag);
  document.getElementById("fOp").innerHTML =
    `<option value=""></option>` + opVals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  document.getElementById("fAttr").value = r ? (r.customerAttr || "") : "";
  document.getElementById("fNom").value = r ? (r.nominationType || "") : "";
  setPay(r ? (r.paymentType === "PAYPAY" ? "PAYPAY" : "現金") : "現金");
  const selD = document.getElementById("fDiscount");
  selD.innerHTML = `<option value=""></option>` + loadDiscounts().map(v => `<option value="${v}">${v.toLocaleString()}</option>`).join("");
  selD.value = r && r.discountAmount != null ? String(r.discountAmount) : "";
  document.getElementById("fOp").value = r ? (r.opFlag || "") : "";
  document.getElementById("fMemo").value = r ? (r.memo || "") : "";

  const st = editId ? getSendStatus(editId) : { customer: false, therapist: false };
  document.getElementById("fSendC").checked = st.customer;
  document.getElementById("fSendT").checked = st.therapist;

  document.getElementById("fDelete").style.display = editId ? "block" : "none";
  updateCaution(); recalcForm();
  formPage.classList.add("open");
}
function setPay(v) {
  document.getElementById("payCash").classList.toggle("on", v === "現金");
  document.getElementById("payPaypay").classList.toggle("on", v === "PAYPAY");
  document.getElementById("payCash").dataset.sel = v === "現金" ? "1" : "";
}
document.getElementById("payCash").addEventListener("click", () => { setPay("現金"); recalcForm(); });
document.getElementById("payPaypay").addEventListener("click", () => { setPay("PAYPAY"); recalcForm(); });

function currentPay() { return document.getElementById("payCash").classList.contains("on") ? "現金" : "PAYPAY"; }

function updateCaution() {
  const tid = Number(document.getElementById("fTherapist").value);
  const t = state.therapists.find(x => x.id === tid);
  const el = document.getElementById("fCaution");
  const c = t && t.caution ? t.caution : "";
  el.textContent = c;
  el.style.display = c.trim() ? "block" : "none";
}
function recalcForm() {
  const startMin = parseBizTime(document.getElementById("fStart").value);
  const course = Number(document.getElementById("fCourse").value) || null;
  const ext = Number(document.getElementById("fExt").value) || 0;
  document.getElementById("fEnd").value = (startMin != null && course) ? fmtBiz(calcEnd(startMin, course, ext)) : "";
  const tid = Number(document.getElementById("fTherapist").value);
  const t = state.therapists.find(x => x.id === tid);
  const opSel = document.getElementById("fOp").value;
  const prices = loadPrices();
  let opPrice = 0;
  const opDef = CFG.options.find(o => o.name === opSel);
  if (opDef) opPrice = opDef.price;
  else if (opSel === "有") opPrice = prices.opPrice; // 旧データ互換
  const nomSel = document.getElementById("fNom").value;
  const nomDef = CFG.nomTypes.find(n => n.name === nomSel);
  const applyFee = nomDef ? !!nomDef.fee : nomSel === "本"; // 旧データ互換
  const total = course ? calcTotal(prices, course, ext,
    Number(document.getElementById("fDiscount").value) || 0,
    opPrice, applyFee, t ? t.nominationFee : 0) : null;
  document.getElementById("fTotal").textContent = total != null ? "¥ " + total.toLocaleString() : "—";
}
["fStart", "fCourse", "fExt", "fDiscount", "fOp", "fNom", "fTherapist"].forEach(id =>
  document.getElementById(id).addEventListener("change", () => { recalcForm(); if (id === "fTherapist") updateCaution(); }));
document.getElementById("fStart").addEventListener("blur", () => {
  const v = parseBizTime(document.getElementById("fStart").value);
  document.getElementById("fStart").value = v == null ? "" : fmtBiz(v);
  recalcForm();
});

/* ★M-V12: セラピスト送信文コピー(PC: CopyTherapistMessage と同一仕様) */
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* フォールバックへ */ }
  // 旧iOS等向けフォールバック
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.top = "0";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
document.getElementById("fCopyTherapist").addEventListener("click", async () => {
  const startMin = parseBizTime(document.getElementById("fStart").value);
  if (startMin == null) { alert("開始時刻を入力してください。例: 0930 / 22:00 / 26:30"); return; }
  const course = Number(document.getElementById("fCourse").value) || null;
  if (!course) { alert("コース分を選択してください。(60/80/100/120)"); return; }
  const ext = Number(document.getElementById("fExt").value) || 0;
  const tid = Number(document.getElementById("fTherapist").value);
  const t = state.therapists.find(x => x.id === tid);
  // 指名料の適用判定(recalcForm と同ルール。旧データ互換: 設定に無い「本」は指名料あり)
  const nomSel = document.getElementById("fNom").value;
  const nomDef = CFG.nomTypes.find(n => n.name === nomSel);
  const applyFee = nomDef ? !!nomDef.fee : nomSel === "本";
  const nominationFee = (applyFee && t) ? Math.max(0, t.nominationFee || 0) : 0;
  const inp = {
    start: startMin,
    end: calcEnd(startMin, course, ext),
    courseMinutes: course,
    extensionMinutes: ext,
    customerAttr: document.getElementById("fAttr").value,
    customer: document.getElementById("fCustomer").value.trim(),
    phoneLast4: document.getElementById("fPhone").value.trim(),
    nominationType: nomSel,
    therapistName: t ? t.name : "",
    nominationFeeApplied: nominationFee,
    discountAmount: Number(document.getElementById("fDiscount").value) || 0,
    opFlag: document.getElementById("fOp").value,
    memo: document.getElementById("fMemo").value
  };
  const message = buildTherapistMessage(inp, loadPrices(), loadSendFormat());
  if (!message) { alert("送信文が空になりました。設定の送信フォーマットを確認してください。"); return; }
  if (await copyTextToClipboard(message)) {
    toast("送信文をコピーしました");
  } else {
    // コピー不能環境では文面を表示して手動コピーしてもらう
    alert("クリップボードへのコピーに失敗しました。以下を長押しコピーしてください。\n\n" + message);
  }
});

document.getElementById("fBack").addEventListener("click", () => formPage.classList.remove("open"));

document.getElementById("fDelete").addEventListener("click", () => {
  if (!formCtx.editId) return;
  if (!confirm("この予約を削除しますか？")) return;
  state.reservations = state.reservations.filter(x => x.id !== formCtx.editId);
  saveReservations(state.dateKey, state.reservations);
  dequeueSend(formCtx.editId);
  refreshSendBadge();
  formPage.classList.remove("open");
  render();
});

document.getElementById("fSave").addEventListener("click", () => {
  const tid = Number(document.getElementById("fTherapist").value);
  const startMin = parseBizTime(document.getElementById("fStart").value);
  if (startMin == null) { alert("開始時刻を入力してください。例: 0930 / 22:00 / 26:30"); return; }
  const course = Number(document.getElementById("fCourse").value) || null;
  if (!course) { alert("コース分を選択してください。(60/80/100/120)"); return; }
  const ext = Number(document.getElementById("fExt").value) || 0;
  const customer = document.getElementById("fCustomer").value.trim();
  if (!customer) { alert("顧客名を入力してください。"); return; }
  const phone = document.getElementById("fPhone").value.trim();
  if (!/^\d{4}$/.test(phone)) { alert("下四桁は4桁の数字で入力してください。"); return; }

  const t = state.therapists.find(x => x.id === tid);
  const cap = (t && t.maxCourse) || 120;
  if (course > cap) {
    if (!confirm(`このセラピストのコース上限（${cap}分）を超えています。\nこのまま登録しますか？`)) return;
  }

  const endMin = calcEnd(startMin, course, ext);
  const old = formCtx.editId ? state.reservations.find(x => x.id === formCtx.editId) : null;
  const r = {
    id: formCtx.editId || newGuid(),
    therapistId: tid,
    customer, phoneLast4: phone,
    start: startMin, end: endMin,
    type: old ? old.type : "B",
    courseMinutes: course, extensionMinutes: ext,
    customerAttr: document.getElementById("fAttr").value,
    nominationType: document.getElementById("fNom").value,
    paymentType: currentPay(),
    discountAmount: document.getElementById("fDiscount").value === "" ? null : Number(document.getElementById("fDiscount").value),
    opFlag: document.getElementById("fOp").value,
    totalAmount: (() => {
      const v = document.getElementById("fTotal").textContent.replace(/[^\d]/g, "");
      return v ? Number(v) : null;
    })(),
    memo: document.getElementById("fMemo").value,
    staff: old ? (old.staff || "") : loadCurrentStaff()
  };

  // 重複・退勤超過の確認(PC: ConfirmBeforeCommit)
  const overlaps = findOverlaps(state.reservations, r, formCtx.editId);
  if (overlaps.length) {
    const list = overlaps.map(o => `・${fmtBiz(o.start)}〜${fmtBiz(o.end)}  ${o.customer} ${o.phoneLast4}`).join("\n");
    if (!confirm(`同一セラピストの既存予約と重なっています。\n\n${list}\n\n登録しますか？`)) return;
  }
  if (isOverShiftEnd(state.attendance, r)) {
    if (!confirm("終了時間が退勤時刻を超過しますが、よろしいですか？")) return;
  }

  if (formCtx.editId) {
    const i = state.reservations.findIndex(x => x.id === formCtx.editId);
    if (i >= 0) state.reservations[i] = r;
  } else {
    state.reservations.push(r);
  }
  saveReservations(state.dateKey, state.reservations);

  // 送信待機の登録・反映
  const sc = document.getElementById("fSendC").checked;
  const st2 = document.getElementById("fSendT").checked;
  if (!formCtx.editId) {
    enqueueSend(r.id); setSendStatus(r.id, sc, st2);
  } else {
    const cur = getSendStatus(r.id);
    if (cur.tracked || sc || st2) { if (!cur.tracked) enqueueSend(r.id); setSendStatus(r.id, sc, st2); }
  }
  refreshSendBadge();
  formPage.classList.remove("open");
  render();
});

/* ================= 引継登録(Type:A一括) ================= */
const hoSheet = document.getElementById("hoSheet");
const HO_MAX_ROWS = 20;
document.getElementById("btnHandover").addEventListener("click", () => {
  closeSheets();
  const present = presentTherapists();
  if (present.length === 0) { alert("先に出勤登録をしてください。"); return; }
  document.getElementById("hoRows").innerHTML = "";
  for (let i = 0; i < 5; i++) addHandoverRow();
  openSheet(hoSheet);
});
function addHandoverRow() {
  const wrap = document.getElementById("hoRows");
  if (wrap.children.length >= HO_MAX_ROWS) { toast(`最大${HO_MAX_ROWS}行までです`); return; }
  const present = presentTherapists().map(p => p.t).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const row = document.createElement("div");
  row.className = "ho-row";
  const sel = document.createElement("select");
  sel.className = "c-th";
  sel.innerHTML = `<option value=""></option>` + present.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  const tm = document.createElement("input");
  tm.className = "c-tm"; tm.placeholder = "2130"; tm.inputMode = "numeric";
  tm.addEventListener("blur", () => {
    const v = parseBizTime(tm.value);
    if (tm.value.trim() !== "") tm.value = v == null ? tm.value : fmtBiz(v);
  });
  const cs = document.createElement("select");
  cs.className = "c-cs";
  cs.innerHTML = `<option value=""></option>` + COURSES.map(c => `<option value="${c}">${c}</option>`).join("");
  const nm = document.createElement("input");
  nm.className = "c-nm"; nm.placeholder = "顧客名";
  const p4 = document.createElement("input");
  p4.className = "c-p4"; p4.placeholder = "0000"; p4.inputMode = "numeric"; p4.maxLength = 4;
  row.append(sel, tm, cs, nm, p4);
  wrap.appendChild(row);
}
document.getElementById("hoAddRow").addEventListener("click", addHandoverRow);
document.getElementById("hoSave").addEventListener("click", () => {
  const rows = [...document.querySelectorAll("#hoRows .ho-row")];
  const errors = [];
  const buffer = [];
  rows.forEach((row, i) => {
    const [sel, tm, cs, nm, p4] = row.children;
    const emptyRow = !sel.value && !tm.value.trim() && !cs.value && !nm.value.trim() && !p4.value.trim();
    if (!sel.value) {
      if (emptyRow) return; // 空行はスキップ(PC版準拠)
      errors.push(`${i + 1}行目: セラピスト未選択`); return;
    }
    const start = parseBizTime(tm.value);
    if (start == null) { errors.push(`${i + 1}行目: 開始時刻が不正（例: 0930 / 21:00 / 26:30）`); return; }
    const course = Number(cs.value) || null;
    if (!course) { errors.push(`${i + 1}行目: コース分(60/80/100/120) 未選択`); return; }
    if (!nm.value.trim()) { errors.push(`${i + 1}行目: 顧客名 未入力`); return; }
    if (!/^\d{4}$/.test(p4.value.trim())) { errors.push(`${i + 1}行目: 下4桁は4桁数字で入力`); return; }
    buffer.push({
      id: newGuid(),
      therapistId: Number(sel.value),
      customer: nm.value.trim(), phoneLast4: p4.value.trim(),
      start, end: calcEnd(start, course, 0),
      type: "A",
      courseMinutes: course, extensionMinutes: 0,
      customerAttr: "", nominationType: "",
      paymentType: "現金", discountAmount: null, opFlag: "", totalAmount: null,
      memo: "[引継]",
      staff: loadCurrentStaff()
    });
  });
  if (errors.length) { alert(errors.join("\n")); return; }
  if (buffer.length === 0) { alert("有効な行がありません。"); return; }

  // 1件ずつ重複・退勤超過を確認(拒否した行はスキップ = PC版準拠)
  let added = 0;
  for (const r of buffer) {
    const overlaps = findOverlaps(state.reservations, r, null);
    if (overlaps.length) {
      const list = overlaps.map(o => `・${fmtBiz(o.start)}〜${fmtBiz(o.end)}  ${o.customer} ${o.phoneLast4}`).join("\n");
      if (!confirm(`【${r.customer}】同一セラピストの既存予約と重なっています。\n\n${list}\n\n登録しますか？`)) continue;
    }
    if (isOverShiftEnd(state.attendance, r)) {
      if (!confirm(`【${r.customer}】終了時間が退勤時刻を超過しますが、よろしいですか？`)) continue;
    }
    state.reservations.push(r);
    added++;
  }
  if (added > 0) {
    saveReservations(state.dateKey, state.reservations);
    render();
  }
  closeSheets();
  toast(`${added}件登録しました`);
});

/* ================= 送信待機一覧 ================= */
const sqSheet = document.getElementById("sqSheet");
document.getElementById("btnSendQueue").addEventListener("click", () => {
  renderSendQueue();
  openSheet(sqSheet);
});
function renderSendQueue() {
  const body = document.getElementById("sqBody");
  const items = loadPendingSends();
  if (items.length === 0) {
    body.innerHTML = `<div class="sq-empty">送信待機の予約はありません。</div>`;
    refreshSendBadge();
    return;
  }
  body.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "sq-item";
    const cust = it.phoneLast4 ? `${it.customer}（${it.phoneLast4}）` : it.customer;
    el.innerHTML = `
      <div class="sq-line1">
        <span class="dt">${esc(fmtQueueDate(it.date))} ${fmtBiz(it.startMin)}</span>
        <b>${esc(it.therapistName)}</b>
        <span>${esc(cust)}</span>
        <button class="sq-open">開く</button>
      </div>
      <div class="sq-line2">
        <label><input type="checkbox" class="cq" ${it.customerDone ? "checked" : ""}>顧客送信</label>
        <label><input type="checkbox" class="tq" ${it.therapistDone ? "checked" : ""}>セラピスト送信</label>
      </div>`;
    const sync = () => {
      const c = el.querySelector(".cq").checked, t = el.querySelector(".tq").checked;
      setSendStatus(it.id, c, t);
      refreshSendBadge();
      if (c && t) {
        el.remove();
        if (!document.querySelector("#sqBody .sq-item")) renderSendQueue();
      }
    };
    el.querySelector(".cq").addEventListener("change", sync);
    el.querySelector(".tq").addEventListener("change", sync);
    el.querySelector(".sq-open").addEventListener("click", () => {
      closeSheets();
      if (state.dateKey !== it.date) { state.dateKey = it.date; reloadDate(); }
      openReservationForm(it.id);
    });
    body.appendChild(el);
  }
  refreshSendBadge();
}
function fmtQueueDate(key) {
  const d = dateKeyToDate(key);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} (${"日月火水木金土"[d.getDay()]})`;
}

/* ================= 担当内勤の切替 ================= */
document.getElementById("staffLink").addEventListener("click", () => {
  if (CFG.staffs.length === 0) {
    alert("担当内勤が未登録です。データ → 設定 →「担当内勤」で登録してください。");
    return;
  }
  const wrap = document.getElementById("staffList");
  wrap.innerHTML = "";
  const cur = loadCurrentStaff();
  for (const name of CFG.staffs) {
    const b = document.createElement("button");
    b.textContent = name + (name === cur ? " ✓" : "");
    if (name === cur) b.className = "cur";
    b.addEventListener("click", () => {
      saveCurrentStaff(name);
      refreshStaffChip();
      closeSheets();
      toast(`担当: ${name}`);
    });
    wrap.appendChild(b);
  }
  openSheet(document.getElementById("staffSheet"));
});

/* ================= 注意点編集(セラピスト名タップ = PC版[M]) ================= */
const cauSheet = document.getElementById("cauSheet");
let cauTargetId = null;
function openCautionEditor(tid) {
  const t = state.therapists.find(x => x.id === tid);
  if (!t) return;
  cauTargetId = tid;
  document.getElementById("cauTitle").childNodes[0].textContent = `注意点編集: ${t.name}`;
  document.getElementById("cauText").value = t.caution || "";
  openSheet(cauSheet);
}
document.getElementById("cauSave").addEventListener("click", () => {
  const t = state.therapists.find(x => x.id === cauTargetId);
  if (t) {
    t.caution = document.getElementById("cauText").value;
    saveTherapists(state.therapists);
    render();
  }
  closeSheets();
});

/* ================= レポート ================= */
const repPage = document.getElementById("repPage");
let repDateKey = null;
document.getElementById("openReport").addEventListener("click", () => {
  closeSheets();
  repDateKey = state.dateKey;
  // 担当フィルタの選択肢: 全 + 設定の担当 + データ上に存在する担当
  const names = new Set(CFG.staffs);
  for (const r of loadReservations(repDateKey)) if (r.staff) names.add(r.staff);
  document.getElementById("repStaff").innerHTML =
    `<option value="">全</option>` + [...names].map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  document.getElementById("repDateLabel").textContent = fmtDateLabel(repDateKey);
  document.getElementById("repOut").value = "";
  document.getElementById("repCount").textContent = "0件";
  document.getElementById("repStatus").textContent = "日付とTypeを選択して「生成してコピー」を押してください。";
  repPage.classList.add("open");
});
document.getElementById("repBack").addEventListener("click", () => repPage.classList.remove("open"));
function repShift(days) {
  const d = dateKeyToDate(repDateKey);
  d.setDate(d.getDate() + days);
  repDateKey = toDateKey(d);
  document.getElementById("repDateLabel").textContent = fmtDateLabel(repDateKey);
}
document.getElementById("repPrev").addEventListener("click", () => repShift(-1));
document.getElementById("repNext").addEventListener("click", () => repShift(1));
document.getElementById("repBuild").addEventListener("click", async () => {
  const incA = document.getElementById("repA").checked;
  const incB = document.getElementById("repB").checked;
  const status = document.getElementById("repStatus");
  if (!incA && !incB) {
    document.getElementById("repOut").value = "";
    status.textContent = "Type A / Type B のどちらかを選択してください。";
    return;
  }
  const staffFilter = document.getElementById("repStaff").value;
  const items = loadReservations(repDateKey)
    .filter(r => staffFilter === "" || (r.staff || "") === staffFilter)
    .map(r => {
      const t = state.therapists.find(x => x.id === r.therapistId);
      return { ...r, therapistName: t ? t.name : "" };
    });
  const { text, count } = buildReport(items, incA, incB);
  document.getElementById("repOut").value = text;
  document.getElementById("repCount").textContent = `${count}件`;
  if (!text.trim()) { status.textContent = "該当データがありません。"; return; }
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = `コピーしました（${repDateKey}）。`;
  } catch {
    status.textContent = "生成しました。長押しでコピーしてください。";
  }
});

/* ================= セラピスト管理 ================= */
const tmPage = document.getElementById("tmPage");
const RATING_OPTIONS = ["", "◎", "〇", "△", "ー", "✖"];
let tmSelectedId = null;

for (const id of ["tmFace", "tmBody", "tmKan"]) {
  document.getElementById(id).innerHTML =
    RATING_OPTIONS.map(v => `<option value="${v}">${v}</option>`).join("");
}
document.getElementById("openTherapistMgmt").addEventListener("click", () => {
  closeSheets();
  document.getElementById("tmFilter").value = "";
  tmClearForm();
  renderTmList();
  tmPage.classList.add("open");
});
document.getElementById("tmBack").addEventListener("click", () => {
  tmPage.classList.remove("open");
  render(); // 名前・注意点等の変更をタイムテーブルへ反映
});
document.getElementById("tmFilter").addEventListener("input", renderTmList);

function renderTmList() {
  const q = document.getElementById("tmFilter").value;
  const list = state.therapists
    .filter(t => therapistMatches(t.name, q))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "ja"));
  const el = document.getElementById("tmList");
  if (list.length === 0) {
    el.innerHTML = `<div class="tm-empty">該当するセラピストがいません。</div>`;
    return;
  }
  el.innerHTML = "";
  for (const t of list) {
    const d = document.createElement("div");
    d.className = "tm-item" + (t.id === tmSelectedId ? " sel" : "");
    d.innerHTML = `<b>${esc(t.name)}</b><small>${esc(t.memo || "")}</small>`;
    d.addEventListener("click", () => { tmSelect(t.id); });
    el.appendChild(d);
  }
}
function tmSelect(id) {
  const t = state.therapists.find(x => x.id === id);
  if (!t) return;
  tmSelectedId = id;
  document.getElementById("tmName").value = t.name;
  document.getElementById("tmFace").value = RATING_OPTIONS.includes(t.face || "") ? (t.face || "") : "";
  document.getElementById("tmBody").value = RATING_OPTIONS.includes(t.body || "") ? (t.body || "") : "";
  document.getElementById("tmKan").value = RATING_OPTIONS.includes(t.kan || "") ? (t.kan || "") : "";
  document.getElementById("tmFee").value = t.nominationFee === 2000 ? "2000円" : "1000円";
  document.getElementById("tmMax").value =
    t.maxCourse === 60 ? "60分" : t.maxCourse === 80 ? "80分" : t.maxCourse === 100 ? "100分" : "120分";
  document.getElementById("tmCaution").value = t.caution || "";
  document.getElementById("tmInterval").value = t.interval != null && String(t.interval).trim() !== "" ? String(t.interval) : "";
  document.getElementById("tmUpdate").disabled = false;
  document.getElementById("tmDelete").disabled = false;
  tmUpdateMemoPreview();
  renderTmList();
}
function tmClearForm() {
  tmSelectedId = null;
  document.getElementById("tmName").value = "";
  document.getElementById("tmFace").value = "";
  document.getElementById("tmBody").value = "";
  document.getElementById("tmKan").value = "";
  document.getElementById("tmFee").value = "1000円";
  document.getElementById("tmMax").value = "120分";
  document.getElementById("tmCaution").value = "";
  document.getElementById("tmInterval").value = "";
  document.getElementById("tmUpdate").disabled = true;
  document.getElementById("tmDelete").disabled = true;
  tmUpdateMemoPreview();
  renderTmList();
}
function tmUpdateMemoPreview() {
  const fee = document.getElementById("tmFee").value.includes("2000") ? 2000 : 1000;
  document.getElementById("tmMemo").value = buildTherapistMemo(
    document.getElementById("tmFace").value,
    document.getElementById("tmBody").value,
    document.getElementById("tmKan").value,
    fee,
    document.getElementById("tmCaution").value);
}
for (const id of ["tmFace", "tmBody", "tmKan", "tmFee", "tmCaution"]) {
  document.getElementById(id).addEventListener("input", tmUpdateMemoPreview);
  document.getElementById(id).addEventListener("change", tmUpdateMemoPreview);
}
document.getElementById("tmInterval").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/[^0-9]/g, ""); // 数字のみ(PC版準拠)
});
function tmBuildFromForm() {
  const name = document.getElementById("tmName").value.trim();
  if (!name) { alert("セラピスト名は必須です。"); return null; }
  const face = document.getElementById("tmFace").value;
  const body = document.getElementById("tmBody").value;
  const kan = document.getElementById("tmKan").value;
  const fee = document.getElementById("tmFee").value.includes("2000") ? 2000 : 1000;
  const maxText = document.getElementById("tmMax").value;
  const maxCourse = maxText.includes("60") ? 60 : maxText.includes("80") ? 80 : maxText.includes("100") ? 100 : 120;
  const caution = document.getElementById("tmCaution").value.trim();
  const ivText = document.getElementById("tmInterval").value.trim();
  let interval = "";
  if (ivText !== "") {
    const v = parseInt(ivText, 10);
    if (isNaN(v)) { alert("インターバルは数字のみです。"); return null; }
    interval = String(v);
  }
  return {
    name, face, body, kan,
    nominationFee: fee, maxCourse, caution, interval,
    memo: buildTherapistMemo(face, body, kan, fee, caution)
  };
}
document.getElementById("tmAdd").addEventListener("click", () => {
  const t = tmBuildFromForm();
  if (!t) return;
  t.id = nextTherapistId();
  state.therapists.push(t);
  saveTherapists(state.therapists);
  tmClearForm();
  toast("追加しました");
});
document.getElementById("tmUpdate").addEventListener("click", () => {
  if (tmSelectedId == null) return;
  const t = tmBuildFromForm();
  if (!t) return;
  t.id = tmSelectedId;
  const i = state.therapists.findIndex(x => x.id === tmSelectedId);
  if (i >= 0) state.therapists[i] = t;
  saveTherapists(state.therapists);
  tmClearForm();
  toast("更新しました");
});
document.getElementById("tmDelete").addEventListener("click", () => {
  if (tmSelectedId == null) return;
  const t = state.therapists.find(x => x.id === tmSelectedId);
  if (!t) return;
  if (!confirm(`選択中のセラピスト『${t.name}』を削除します。よろしいですか？`)) return;
  state.therapists = state.therapists.filter(x => x.id !== tmSelectedId);
  saveTherapists(state.therapists);
  tmClearForm();
  toast("削除しました");
});
document.getElementById("tmClear").addEventListener("click", tmClearForm);

/* ================= 設定画面 ================= */
const setPage = document.getElementById("setPage");
document.getElementById("openSettings").addEventListener("click", () => {
  closeSheets();
  loadSettingsIntoForm();
  setPage.classList.add("open");
});
document.getElementById("setBack").addEventListener("click", () => setPage.classList.remove("open"));

function loadSettingsIntoForm() {
  const p = loadPrices();
  document.getElementById("sp60").value = p.coursePrice[60];
  document.getElementById("sp80").value = p.coursePrice[80];
  document.getElementById("sp100").value = p.coursePrice[100];
  document.getElementById("sp120").value = p.coursePrice[120];
  document.getElementById("spExtMin").value = p.extensionUnitMinutes;
  document.getElementById("spExtPrice").value = p.extensionUnitPrice;
  document.getElementById("sDiscounts").value = loadDiscounts().join("\n");
  document.getElementById("sAttrs").value = CFG.attrs.join("\n");
  document.getElementById("sStaffs").value = CFG.staffs.join("\n");
  document.getElementById("sAreas").value = CFG.areas.join("\n");
  document.getElementById("scPrep").value = CFG.calc.prep;
  document.getElementById("scIv").value = CFG.calc.defaultInterval;
  document.getElementById("scRound").value = CFG.calc.roundTo;
  // 指名種別
  const nomWrap = document.getElementById("sNomRows");
  nomWrap.innerHTML = "";
  for (const n of CFG.nomTypes) addNomRow(n.name, n.fee);
  // オプション
  const opWrap = document.getElementById("sOpRows");
  opWrap.innerHTML = "";
  for (const o of CFG.options) addOpRow(o.name, o.price);
  // ★M-V12: 送信フォーマット
  const sf = loadSendFormat();
  document.getElementById("sSendTemplate").value = sf.therapistTemplate;
  const arWrap = document.getElementById("sAttrRuleRows");
  arWrap.innerHTML = "";
  for (const r of sf.attrMap) addAttrRuleRow(r.input, r.nom, r.output);
  const npWrap = document.getElementById("sNomPhraseRows");
  npWrap.innerHTML = "";
  for (const m of sf.nomPhrases) addNomPhraseRow(m.input, m.output);
}
/* ★M-V12: 属性表示ルール行(属性/指名/表示) */
function addAttrRuleRow(attr = "", nom = "", output = "") {
  const wrap = document.getElementById("sAttrRuleRows");
  const row = document.createElement("div");
  row.className = "set-row";
  row.innerHTML = `<input class="s-sm s-attr" placeholder="属性" value="${esc(attr)}">` +
    `<input class="s-sm s-nom" placeholder="指名" value="${esc(nom)}">` +
    `<input class="s-name s-out" placeholder="表示" value="${esc(output)}">` +
    `<button class="s-del" type="button">×</button>`;
  row.querySelector(".s-del").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}
/* ★M-V12: 指名文言行(指名種別/追加文言) */
function addNomPhraseRow(input = "", output = "") {
  const wrap = document.getElementById("sNomPhraseRows");
  const row = document.createElement("div");
  row.className = "set-row";
  row.innerHTML = `<input class="s-sm s-nom" placeholder="指名" value="${esc(input)}">` +
    `<input class="s-name s-out" placeholder="追加文言" value="${esc(output)}">` +
    `<button class="s-del" type="button">×</button>`;
  row.querySelector(".s-del").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}
function addNomRow(name = "", fee = false) {
  const wrap = document.getElementById("sNomRows");
  const row = document.createElement("div");
  row.className = "set-row";
  row.innerHTML = `<input class="s-name" placeholder="種別名" value="${esc(name)}">` +
    `<label class="s-fee"><input type="checkbox" ${fee ? "checked" : ""}>指名料</label>` +
    `<button class="s-del">×</button>`;
  row.querySelector(".s-del").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}
function addOpRow(name = "", price = 0) {
  const wrap = document.getElementById("sOpRows");
  const row = document.createElement("div");
  row.className = "set-row";
  row.innerHTML = `<input class="s-name" placeholder="オプション名" value="${esc(name)}">` +
    `<input class="s-price" inputmode="numeric" placeholder="金額" value="${price}">` +
    `<button class="s-del">×</button>`;
  row.querySelector(".s-del").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}
document.getElementById("sNomAdd").addEventListener("click", () => addNomRow());
document.getElementById("sOpAdd").addEventListener("click", () => addOpRow());
// ★M-V12: 送信フォーマットの行追加・テンプレート初期化
document.getElementById("sAttrRuleAdd").addEventListener("click", () => addAttrRuleRow());
document.getElementById("sNomPhraseAdd").addEventListener("click", () => addNomPhraseRow());
document.getElementById("sSendTplReset").addEventListener("click", () => {
  if (confirm("テンプレートを初期値に戻しますか？")) {
    document.getElementById("sSendTemplate").value = DEFAULT_SEND_FORMAT.therapistTemplate;
  }
});

document.getElementById("setSave").addEventListener("click", () => {
  // 料金
  const nums = {};
  for (const [id, label] of [["sp60","60分"],["sp80","80分"],["sp100","100分"],["sp120","120分"],
                             ["spExtMin","延長単位(分)"],["spExtPrice","延長単価"]]) {
    const v = parseInt(document.getElementById(id).value, 10);
    if (isNaN(v) || v < 0) { alert(`料金設定: ${label} は0以上の数字で入力してください。`); return; }
    nums[id] = v;
  }
  if (nums.spExtMin < 1) { alert("延長単位(分)は1以上にしてください。"); return; }
  // 割引
  const discounts = [];
  for (const line of document.getElementById("sDiscounts").value.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    const v = parseInt(t, 10);
    if (isNaN(v) || v < 0) { alert(`割引: 「${t}」は数字で入力してください。`); return; }
    discounts.push(v);
  }
  if (discounts.length === 0) discounts.push(0);
  // 属性・エリア
  const attrs = document.getElementById("sAttrs").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const staffs = document.getElementById("sStaffs").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (new Set(staffs).size !== staffs.length) { alert("担当内勤の名前が重複しています。"); return; }
  const areas = document.getElementById("sAreas").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (attrs.length === 0) { alert("顧客属性を1つ以上入力してください。"); return; }
  if (areas.length === 0) { alert("エリアを1つ以上入力してください。"); return; }
  if (new Set(areas).size !== areas.length) { alert("エリア名が重複しています。"); return; }
  // 指名種別
  const nomTypes = [];
  for (const row of document.querySelectorAll("#sNomRows .set-row")) {
    const name = row.querySelector(".s-name").value.trim();
    if (name === "") continue;
    if (nomTypes.some(n => n.name === name)) { alert(`指名種別「${name}」が重複しています。`); return; }
    nomTypes.push({ name, fee: row.querySelector('input[type="checkbox"]').checked });
  }
  if (nomTypes.length === 0) { alert("指名種別を1つ以上入力してください。"); return; }
  // オプション
  const options = [];
  for (const row of document.querySelectorAll("#sOpRows .set-row")) {
    const name = row.querySelector(".s-name").value.trim();
    if (name === "") continue;
    const v = parseInt(row.querySelector(".s-price").value, 10);
    if (isNaN(v) || v < 0) { alert(`オプション「${name}」の金額は0以上の数字で入力してください。`); return; }
    if (options.some(o => o.name === name)) { alert(`オプション「${name}」が重複しています。`); return; }
    options.push({ name, price: v });
  }
  // 最短計算
  const prep = parseInt(document.getElementById("scPrep").value, 10);
  const iv = parseInt(document.getElementById("scIv").value, 10);
  const round = parseInt(document.getElementById("scRound").value, 10);
  if (isNaN(prep) || prep < 0) { alert("準備時間は0以上の数字で入力してください。"); return; }
  if (isNaN(iv) || iv < 0) { alert("既定インターバルは0以上の数字で入力してください。"); return; }
  if (isNaN(round) || round < 1) { alert("基準時刻の丸め(分)は1以上の数字で入力してください。"); return; }

  // ★M-V12: 送信フォーマット(PC: SettingsDialog と同一の検証)
  const attrRules = [];
  for (const row of document.querySelectorAll("#sAttrRuleRows .set-row")) {
    const attr = row.querySelector(".s-attr").value.trim();
    const nom = row.querySelector(".s-nom").value.trim();
    const output = row.querySelector(".s-out").value.trim();
    if (attr === "" && nom === "" && output === "") continue; // 空行は無視
    if (attrRules.some(r => r.input === attr && r.nom === nom)) {
      alert(`属性表示変換: 属性「${attr || "（空欄）"}」×指名「${nom || "（空欄）"}」の行が重複しています。`);
      return;
    }
    attrRules.push({ input: attr, nom, output });
  }
  const nomPhrases = [];
  for (const row of document.querySelectorAll("#sNomPhraseRows .set-row")) {
    const input = row.querySelector(".s-nom").value.trim();
    const output = row.querySelector(".s-out").value.trim();
    if (input === "") continue;
    if (nomPhrases.some(m => m.input === input)) {
      alert(`指名文言: 指名種別「${input}」が重複しています。`);
      return;
    }
    nomPhrases.push({ input, output });
  }
  let sendTemplate = document.getElementById("sSendTemplate").value.replace(/\r\n/g, "\n");
  if (!sendTemplate.trim()) sendTemplate = DEFAULT_SEND_FORMAT.therapistTemplate;

  const p = loadPrices();
  p.coursePrice = { 60: nums.sp60, 80: nums.sp80, 100: nums.sp100, 120: nums.sp120 };
  p.extensionUnitMinutes = nums.spExtMin;
  p.extensionUnitPrice = nums.spExtPrice;
  savePrices(p);
  saveDiscounts(discounts);
  const s = { staffs, attrs, nomTypes, options, areas, calc: { prep, defaultInterval: iv, roundTo: round } };
  saveSettings(s);
  // ★M-V12: 送信フォーマットの保存(PCと同一のJSON構造)
  saveSendFormat({ therapistTemplate: sendTemplate, attrMap: attrRules, nomPhrases });
  CFG = loadSettings();
  // 現在の担当がリストから消えていたらリセット
  if (loadCurrentStaff() && !CFG.staffs.includes(loadCurrentStaff())) saveCurrentStaff("");
  refreshStaffChip();
  setPage.classList.remove("open");
  render();
  toast("設定を保存しました");
});

/* ================= クラウド同期(GitHub) ================= */
const SYNC_PATH = "este-data.json";
function loadSyncConfig() { return LS.get("este.sync", null); }
function saveSyncConfig(c) { LS.set("este.sync", c); }
function loadSyncState() { return LS.get("este.syncState", null); }
function saveSyncState(s) { LS.set("este.syncState", s); }

function collectDataDump() {
  const dump = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("este.")) continue;
    if (k === "este.sync" || k === "este.syncState") continue; // トークン等は預けない
    dump[k] = localStorage.getItem(k);
  }
  return dump;
}
function applyDataDump(dump) {
  // 同期設定以外の este.* を置き換え
  const keep = {};
  for (const k of ["este.sync", "este.syncState"]) {
    const v = localStorage.getItem(k);
    if (v != null) keep[k] = v;
  }
  const del = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("este.")) del.push(k);
  }
  for (const k of del) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(dump)) localStorage.setItem(k, v);
  state.therapists = loadTherapists();
  CFG = loadSettings();
  refreshStaffChip();
  reloadDate();
}
function localChangedSince(ts) {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("este.meta.")) continue;
    const v = Number(localStorage.getItem(k));
    if (Number.isFinite(v) && v > ts) return true;
  }
  return false;
}
// UTF-8 <-> base64
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function b64DecodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function ghHeaders(cfg) {
  return {
    "Authorization": "Bearer " + cfg.token,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}
function ghUrl(cfg) {
  return `https://api.github.com/repos/${cfg.repo}/contents/${SYNC_PATH}`;
}
// クラウドの現状取得: {exists, sha, payload} / 認証エラー等はthrow
async function cloudFetch(cfg) {
  const res = await fetch(ghUrl(cfg), { headers: ghHeaders(cfg), cache: "no-store" });
  if (res.status === 404) return { exists: false, sha: null, payload: null };
  if (res.status === 401 || res.status === 403) throw new Error("認証エラー: トークンを確認してください");
  if (!res.ok) throw new Error("取得失敗: HTTP " + res.status);
  const obj = await res.json();
  let payload = null;
  try { payload = JSON.parse(b64DecodeUtf8(obj.content || "")); } catch { payload = null; }
  return { exists: true, sha: obj.sha, payload };
}
async function cloudPut(cfg, payload, sha) {
  const body = {
    message: `este-mobile deposit ${new Date().toISOString()}`,
    content: b64EncodeUtf8(JSON.stringify(payload))
  };
  if (sha) body.sha = sha;
  const res = await fetch(ghUrl(cfg), {
    method: "PUT", headers: { ...ghHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (res.status === 401 || res.status === 403) throw new Error("認証エラー: トークンを確認してください");
  if (res.status === 409 || res.status === 422) throw new Error("競合が発生しました。もう一度「預ける」を押してください");
  if (!res.ok) throw new Error("保存失敗: HTTP " + res.status);
}
function requireSyncConfig() {
  const cfg = loadSyncConfig();
  if (!cfg || !cfg.token || !cfg.repo) {
    closeSheets();
    openSyncConfig();
    return null;
  }
  return cfg;
}

// ☁ 預ける
document.getElementById("cloudPush").addEventListener("click", async () => {
  const cfg = requireSyncConfig();
  if (!cfg) return;
  const btn = document.getElementById("cloudPush");
  btn.disabled = true;
  try {
    const cur = await cloudFetch(cfg);
    const st = loadSyncState() || { lastCloudSeen: 0, lastSyncAt: 0 };
    if (cur.exists && cur.payload && Number(cur.payload.exportedAt || 0) > Number(st.lastCloudSeen || 0)) {
      if (!confirm("クラウドに別の端末から預けられた新しいデータがあります。\nこの端末の内容で上書きして預けますか？")) { btn.disabled = false; return; }
    }
    const payload = { app: "este-mobile", version: 2, exportedAt: Date.now(), data: collectDataDump() };
    await cloudPut(cfg, payload, cur.sha);
    saveSyncState({ lastCloudSeen: payload.exportedAt, lastSyncAt: Date.now() });
    refreshSyncInfo();
    closeSheets();
    toast("☁ 預けました");
  } catch (e) {
    alert("預けられませんでした。\n" + e.message);
  }
  btn.disabled = false;
});

// ☁ 受け取る(手動)
document.getElementById("cloudPull").addEventListener("click", async () => {
  const cfg = requireSyncConfig();
  if (!cfg) return;
  const btn = document.getElementById("cloudPull");
  btn.disabled = true;
  try {
    const cur = await cloudFetch(cfg);
    if (!cur.exists || !cur.payload || cur.payload.app !== "este-mobile" || !cur.payload.data) {
      alert("クラウドに預けたデータがまだありません。先に「預ける」を実行してください。");
      btn.disabled = false; return;
    }
    if (!confirm("この端末のデータをクラウドの内容で上書きします。よろしいですか？")) { btn.disabled = false; return; }
    applyDataDump(cur.payload.data);
    saveSyncState({ lastCloudSeen: Number(cur.payload.exportedAt || 0), lastSyncAt: Date.now() });
    refreshSyncInfo();
    closeSheets();
    toast("☁ 受け取りました");
  } catch (e) {
    alert("受け取れませんでした。\n" + e.message);
  }
  btn.disabled = false;
});

// 起動時の自動受信
async function autoReceive() {
  const cfg = loadSyncConfig();
  const st = loadSyncState();
  if (!cfg || !cfg.token || !cfg.repo || !st) return; // 一度も同期していない端末では自動適用しない
  if (navigator.onLine === false) return;
  try {
    const cur = await cloudFetch(cfg);
    if (!cur.exists || !cur.payload || cur.payload.app !== "este-mobile" || !cur.payload.data) return;
    const cloudAt = Number(cur.payload.exportedAt || 0);
    if (cloudAt <= Number(st.lastCloudSeen || 0)) return; // 新しいものなし
    if (localChangedSince(Number(st.lastSyncAt || 0))) {
      if (!confirm("クラウドに新しいデータがあります。\nこの端末には未預けの変更があります。クラウドの内容で上書きしますか？\n(キャンセル=この端末のまま。あとで「預ける」か「受け取る」を選べます)")) return;
    }
    applyDataDump(cur.payload.data);
    saveSyncState({ lastCloudSeen: cloudAt, lastSyncAt: Date.now() });
    refreshSyncInfo();
    toast("☁ クラウドの最新データを受信しました");
  } catch (e) {
    // オフライン等は黙って続行(オフラインファースト)
    console.warn("auto receive skipped:", e.message);
  }
}

/* ---- 同期設定シート ---- */
function openSyncConfig() {
  const cfg = loadSyncConfig() || { token: "", repo: "" };
  document.getElementById("syRepo").value = cfg.repo || "";
  document.getElementById("syToken").value = cfg.token || "";
  refreshSyncInfo();
  openSheet(document.getElementById("syncSheet"));
}
document.getElementById("openSyncConfig").addEventListener("click", () => { closeSheets(); openSyncConfig(); });
function refreshSyncInfo() {
  const el = document.getElementById("syInfo");
  if (!el) return;
  const st = loadSyncState();
  el.textContent = st && st.lastSyncAt
    ? "最終同期: " + new Date(st.lastSyncAt).toLocaleString("ja-JP")
    : "まだ同期していません";
}
document.getElementById("syTest").addEventListener("click", async () => {
  const repo = document.getElementById("syRepo").value.trim();
  const token = document.getElementById("syToken").value.trim();
  if (!repo.includes("/") || !token) { alert("リポジトリ名(ユーザー名/リポジトリ名)とトークンを入力してください。"); return; }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json" }, cache: "no-store"
    });
    if (res.status === 401 || res.status === 403) throw new Error("認証エラー: トークンが無効か権限不足です");
    if (res.status === 404) throw new Error("リポジトリが見つかりません(名前の誤り、またはトークンにこのリポジトリへの権限が無い)");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const meta = await res.json();
    alert(meta.private ? "接続OK(非公開リポジトリ)" : "接続OKですが、このリポジトリは【公開】です。\n業務データを預けるので、非公開(Private)リポジトリの使用を強くおすすめします。");
  } catch (e) {
    alert("接続テスト失敗: " + e.message);
  }
});
document.getElementById("sySave").addEventListener("click", () => {
  const repo = document.getElementById("syRepo").value.trim();
  const token = document.getElementById("syToken").value.trim();
  if (!repo.includes("/") || !token) { alert("リポジトリ名(ユーザー名/リポジトリ名)とトークンを入力してください。"); return; }
  saveSyncConfig({ repo, token });
  closeSheets();
  toast("同期設定を保存しました");
});

/* ================= データ移行(エクスポート/インポート) ================= */
document.getElementById("btnMenu").addEventListener("click", () => openSheet(document.getElementById("menuSheet")));
function buildExportMd() {
  const dump = collectDataDump(); // 同期トークン等は含めない
  const now = new Date();
  const stamp = `${toDateKey(now)} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  const payload = JSON.stringify({ app: "este-mobile", version: 2, exportedAt: Date.now(), data: dump });
  return [
    "# サロン受付 バックアップ",
    "",
    `- バージョン: ${APP_VERSION}`,
    `- 作成日時: ${stamp}`,
    "- 内容: 予約・出勤・仮押さえ・セラピスト・送信待機・設定(料金/指名種別/顧客属性/割引/オプション/エリア/最短計算)の全データ",
    "",
    "このファイルをアプリの「インポート」で読み込むと復元できます。",
    "下のデータ部分は編集しないでください。",
    "",
    "## データ",
    "",
    "```json",
    payload,
    "```",
    ""
  ].join("\n");
}
document.getElementById("expData").addEventListener("click", () => {
  const blob = new Blob([buildExportMd()], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `este-backup-${state.dateKey}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById("impData").addEventListener("click", () => document.getElementById("impFile").click());
document.getElementById("impFile").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    let obj = null;
    // md形式: ```json ブロックを抽出。旧json形式もそのまま受け付ける
    const m = text.match(/```json\s*([\s\S]*?)```/);
    obj = JSON.parse(m ? m[1].trim() : text);
    if (!obj || obj.app !== "este-mobile" || !obj.data) throw new Error("形式が違います");
    if (!confirm("インポートすると同じ項目は上書きされます。実行しますか？")) return;
    for (const [k, v] of Object.entries(obj.data)) {
      if (k === "este.sync" || k === "este.syncState") continue;
      localStorage.setItem(k, v);
    }
    state.therapists = loadTherapists();
    CFG = loadSettings();
    refreshStaffChip();
    reloadDate();
    closeSheets();
    toast("インポートしました");
  } catch (err) {
    alert("インポート失敗: " + err.message);
  }
  e.target.value = "";
});

/* ================= シート共通・トースト ================= */
function openSheet(sheet) {
  document.getElementById("sheetBg").classList.add("open");
  sheet.classList.add("open");
}
function closeSheets() {
  document.getElementById("sheetBg").classList.remove("open");
  document.querySelectorAll(".sheet").forEach(s => s.classList.remove("open"));
}
document.getElementById("sheetBg").addEventListener("click", closeSheets);
document.querySelectorAll(".sheet-close").forEach(b => b.addEventListener("click", closeSheets));

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/* ================= 起動 ================= */
state.therapists = loadTherapists();
reloadDate();
// 初期スクロール: 現在時刻付近
setTimeout(() => document.getElementById("btnNow").click(), 50);
// 1分ごとに現在時刻ラインを更新
setInterval(() => { if (!formPage.classList.contains("open")) render(); }, 60000);

refreshStaffChip();

// クラウド自動受信(設定済み端末のみ・オフライン時はスキップ)
setTimeout(autoReceive, 300);

// バージョン表示
{
  const v = document.getElementById("verLabel");
  if (v) v.textContent = APP_VERSION;
}

// Service Worker 登録(オフライン対応)+新バージョン検知
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then(reg => {
    function watch(worker) {
      worker.addEventListener("statechange", () => {
        // 既存ページを制御中に新SWがinstalled = 新バージョンあり
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateBanner(worker);
        }
      });
    }
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    if (reg.installing) watch(reg.installing);
    reg.addEventListener("updatefound", () => { if (reg.installing) watch(reg.installing); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
function showUpdateBanner(worker) {
  const el = document.getElementById("updBanner");
  el.style.display = "flex";
  document.getElementById("updBtn").onclick = () => {
    worker.postMessage({ type: "SKIP_WAITING" });
  };
}

} // end browser block
