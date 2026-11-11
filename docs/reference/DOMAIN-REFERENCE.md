# 领域、字典、配置与测试精确参考

快照：2026-11-12，V2.0.0本地修复候选工作树，未部署。由build-documentation-reference.mjs机械生成；每块保存原始字节和SHA256。

先读[最新验收](../ACCEPTANCE-2026-10-01.md)、[重建规范](../REBUILD-SPEC.md)和[恢复流程](../DEPLOYMENT-ROLLBACK.md)。这是代码快照，不保证所有发布门禁已完成。SQL含历史身份种子，新项目先安全替换。包中无云端历史数据、用户上传图片或服务私钥。

## src/lib/account.ts

<!-- source: src/lib/account.ts sha256: 51b4c246404d70bfe8190846f26a02658ad437988826d36763a64ab73b306c18 encoding: utf8 -->
````typescript
import { supabase } from "./supabase";
import type { ApiQuotaSnapshot, OwnerManagedUser } from "../types";
import { edgeFunctionMessage } from "./functionError";

export async function getApiQuota() {
  const { data, error } = await supabase.functions.invoke("get-api-quota", { body: {} });
  if (error || !data?.data) throw new Error("暂时无法读取智能服务额度");
  return data.data as ApiQuotaSnapshot;
}

export async function redeemInvite(code: string) {
  const { data, error } = await supabase.functions.invoke("redeem-invite", { body: { code } });
  if (error) throw new Error(await edgeFunctionMessage(error, "邀请码暂时无法验证"));
  if (data?.error) throw new Error(data.error.message || "邀请码无效");
  return data.data as { tier: "friend" | "owner" };
}

export async function getOwnerManagedUsers(query = "") {
  const { data, error } = await supabase.functions.invoke("owner-admin", { body: { action: "list", query } });
  if (error) throw new Error(await edgeFunctionMessage(error, "暂时无法读取账号列表"));
  if (data?.error) throw new Error(data.error.message || "暂时无法读取账号列表");
  return (data?.data?.users || []) as OwnerManagedUser[];
}

export async function setOwnerManagedUserTier(targetUserId: string, tier: "standard" | "friend") {
  const { data, error } = await supabase.functions.invoke("owner-admin", { body: { action: "set_tier", targetUserId, tier } });
  if (error) throw new Error(await edgeFunctionMessage(error, "权限修改失败，请稍后重试"));
  if (data?.error) throw new Error(data.error.message || "权限修改失败，请稍后重试");
  return data.data as { ok: true; old_tier: string; new_tier: "standard" | "friend" };
}

async function digest(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function startDemoSession() {
  let seed = localStorage.getItem("life-tracker-demo-device");
  if (!seed) {
    seed = crypto.randomUUID();
    localStorage.setItem("life-tracker-demo-device", seed);
  }
  const { data, error } = await supabase.functions.invoke("start-demo-session", { body: { deviceHash: await digest(seed) } });
  if (error || !data?.data?.token) throw new Error(error ? await edgeFunctionMessage(error, "暂时无法进入演示模式，请稍后重试") : "暂时无法进入演示模式，请稍后重试");
  localStorage.setItem("life-tracker-demo-session", data.data.token);
  localStorage.setItem("life-tracker-demo-session-expires", data.data.expiresAt);
  return data.data as { token: string; expiresAt: string };
}

````

## src/lib/ai.ts

<!-- source: src/lib/ai.ts sha256: fdc2c1585d9b6645bf9f00709112464fed4f9e1f51aa4e8db88a35381b987a7a encoding: utf8 -->
````typescript
import { supabase } from "./supabase";
import type { ExpenseCategory } from "../types";
import { edgeFunctionMessage } from "./functionError";

export type AiAction = "route" | "expense_parse" | "note_polish" | "trip_recap" | "daily_summary";

export interface ParsedExpense {
  amount: number | null;
  currency: string | null;
  category: ExpenseCategory | null;
  merchant: string | null;
  note: string | null;
}

export interface AiResponse<T> {
  action: AiAction; cached?: boolean; skipped?: boolean; result: T;
  generatedAt?: string; persisted?: boolean; warning?: string; recoveryToken?: string;
  contextKey?: string; usageLogPending?: boolean; recoverySaved?: boolean; newerPreserved?: boolean;
}

export interface PendingAiRecovery {
  id: string; action: AiAction; targetKey: string; createdAt: string; generatedAt?: string;
  result: unknown; recoveryToken?: string; warning?: string; error?: string;
}

export const AI_RECOVERY_CHANGED = "life-tracker-ai-recovery-change";
const recoveryKey = (userId: string) => `life-tracker-ai-recovery:${userId}`;

export function pendingAiRecoveries(userId: string): PendingAiRecovery[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recoveryKey(userId)) || "[]");
    return Array.isArray(value) ? value.filter((item): item is PendingAiRecovery => item && typeof item.id === "string" && typeof item.action === "string" && typeof item.createdAt === "string") : [];
  } catch { return []; }
}

function saveRecoveries(userId: string, items: PendingAiRecovery[]) {
  localStorage.setItem(recoveryKey(userId), JSON.stringify(items));
  window.dispatchEvent(new CustomEvent(AI_RECOVERY_CHANGED));
}

function quotaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function recoveryTarget(action: AiAction, payload: Record<string, unknown>) {
  if (action === "trip_recap") return `trip:${String(payload.tripId)}`;
  if (action === "daily_summary") return payload.clientContext ? `daily:${String(payload.clientContext)}` : `daily:${quotaDate()}:default`;
  return "";
}

function demoToken() {
  return localStorage.getItem("life-tracker-demo-session") || undefined;
}

export async function deepseekAssist<T>(action: AiAction, payload: Record<string, unknown>, isDemo = false) {
  const ownerId = isDemo ? undefined : (await supabase.auth.getSession()).data.session?.user.id;
  if (!isDemo && !ownerId) throw new Error("请先登录后再使用智能服务。");
  const assertCurrentOwner = async () => {
    if (ownerId && (await supabase.auth.getSession()).data.session?.user.id !== ownerId) throw new Error("账号已切换，已停止展示上一账号的 AI 结果。请在当前账号中重新操作。");
  };
  const targetKey = recoveryTarget(action, payload);
  if (ownerId && targetKey && payload.regenerate !== true) {
    const pending = pendingAiRecoveries(ownerId).find((item) => item.action === action && item.targetKey === targetKey);
    if (pending) {
      await assertCurrentOwner();
      return { action, result: pending.result as T, generatedAt: pending.generatedAt, persisted: false, recoveryToken: pending.recoveryToken,
        warning: pending.warning || "这份结果尚未保存到云端，请先重试保存；不会重复调用 AI。" } satisfies AiResponse<T>;
    }
  }
  const requestId = crypto.randomUUID();
  await assertCurrentOwner();
  const { data, error } = await supabase.functions.invoke("deepseek-assist", {
    body: { ...payload, action, requestId, ...(isDemo ? { demoSessionToken: demoToken() } : { expectedOwner: ownerId }) }
  });
  if (error) throw new Error(await edgeFunctionMessage(error, "智能服务暂时不可用，请稍后重试或继续手动填写。"));
  if (data?.error) throw new Error(data.error.message || "智能服务暂时不可用");
  const response = data?.data as AiResponse<T>;
  if (!response || !("result" in response)) throw new Error("智能服务没有返回有效结果。");
  const stillOwner = !ownerId || (await supabase.auth.getSession()).data.session?.user.id === ownerId;
  if (ownerId && response.persisted === false) {
    try {
      const items = pendingAiRecoveries(ownerId);
      items.push({ id: requestId, action, targetKey, createdAt: new Date().toISOString(), result: response.result,
        generatedAt: response.generatedAt, recoveryToken: response.recoveryToken, warning: response.warning });
      saveRecoveries(ownerId, items);
    } catch {
      response.warning = "内容已生成，但云端同步及本机备份均未完成。请立即复制保存这份内容，不要反复重新生成。";
    }
  }
  // A server-validated old-account response may be backed up only under that
  // original owner. Never return its content into the newly active account UI.
  if (!stillOwner) throw new Error("账号已切换，已停止展示上一账号的 AI 结果。尚未同步的内容只保留在原账号中。");
  return response;
}

/** Persistence retry only: the Edge endpoint neither reserves quota nor calls DeepSeek. */
export async function retryAiPersistence(userId: string) {
  const currentOwner = async () => (await supabase.auth.getSession()).data.session?.user.id;
  if (await currentOwner() !== userId) throw new Error("请在原账号中重试保存这份内容。");
  let saved = 0;
  const errors: string[] = [];
  for (const item of pendingAiRecoveries(userId)) {
    if (await currentOwner() !== userId) break;
    if (!item.recoveryToken) { errors.push("这份内容没有可用的保存凭据，请先复制保存本地副本。"); continue; }
    try {
      const { data, error } = await supabase.functions.invoke("deepseek-assist", { body: { action: "retry_save", recoveryToken: item.recoveryToken } });
      if (error) throw new Error(await edgeFunctionMessage(error, "云端保存仍未完成，请保留本地副本后稍后再试。"));
      if (data?.error || data?.data?.persisted !== true) throw new Error(data?.error?.message || "云端保存仍未完成。");
      // The response belongs to the account captured above; a switch can stop
      // later requests, but must not move or expose this result to the new user.
      saveRecoveries(userId, pendingAiRecoveries(userId).filter((entry) => entry.id !== item.id));
      saved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "云端保存仍未完成。";
      errors.push(message);
      try { saveRecoveries(userId, pendingAiRecoveries(userId).map((entry) => entry.id === item.id ? { ...entry, error: message } : entry)); } catch { /* Never remove a result whose retry was not confirmed. */ }
    }
  }
  return { saved, remaining: pendingAiRecoveries(userId).length, errors };
}

export async function parseExpense(text: string, isDemo = false) {
  return deepseekAssist<ParsedExpense>("expense_parse", { text }, isDemo);
}

export async function polishNote(text: string, isDemo = false) {
  return deepseekAssist<string>("note_polish", { text }, isDemo);
}

export async function generateTripRecap(tripId: string, regenerate = false, isDemo = false) {
  return deepseekAssist<string>("trip_recap", { tripId, regenerate }, isDemo);
}

export async function generateDailySummary(clientContext?: string) {
  // The backend owns the calendar calculation; do not send a device/Shanghai
  // date as if it were the business date of every trip.
  return deepseekAssist<string>("daily_summary", { ...(clientContext ? { clientContext } : {}) });
}

````

## src/lib/aircraftTypes.ts

<!-- source: src/lib/aircraftTypes.ts sha256: 4cc95ac2374ce2cda9f9ad6c6060e814647cc97c04b1889a33e6c509c73e8fc4 encoding: utf8 -->
````typescript
export interface AircraftTypeOption {
  canonical: string;
  aliases: string[];
}

// Common commercial aircraft names plus frequently seen IATA/ICAO/provider
// designators. Unknown values deliberately remain untouched.
export const AIRCRAFT_TYPES: AircraftTypeOption[] = [
  { canonical: "A220-100", aliases: ["221", "A221", "BCS1", "CS100"] },
  { canonical: "A220-300", aliases: ["223", "A223", "BCS3", "CS300"] },
  { canonical: "A319-100", aliases: ["319", "A319"] },
  { canonical: "A320-200", aliases: ["320", "A320"] },
  { canonical: "A320neo", aliases: ["32N", "A20N", "A320N", "A320NEO"] },
  { canonical: "A321-200", aliases: ["321", "A321"] },
  { canonical: "A321neo", aliases: ["32Q", "A21N", "A321N", "A321NEO"] },
  { canonical: "A330-200", aliases: ["332", "A332"] },
  { canonical: "A330-300", aliases: ["333", "A333"] },
  { canonical: "A330-800neo", aliases: ["338", "A338", "A330-800"] },
  { canonical: "A330-900neo", aliases: ["339", "A339", "A330-900"] },
  { canonical: "A340-300", aliases: ["343", "A343"] },
  { canonical: "A340-600", aliases: ["346", "A346"] },
  { canonical: "A350-900", aliases: ["359", "A359", "A350900"] },
  { canonical: "A350-1000", aliases: ["35K", "A35K", "A3501000"] },
  { canonical: "A380-800", aliases: ["388", "A388", "A380"] },
  { canonical: "737-700", aliases: ["73G", "B737", "B737-700", "7377"] },
  { canonical: "737-800", aliases: ["738", "73H", "B738", "B737-800", "7378"] },
  { canonical: "737-900ER", aliases: ["739", "B739", "B737-900ER", "739ER"] },
  { canonical: "737 MAX 8", aliases: ["7M8", "B38M", "737-8", "737MAX8", "B737MAX8"] },
  { canonical: "737 MAX 9", aliases: ["7M9", "B39M", "737-9", "737MAX9", "B737MAX9"] },
  { canonical: "747-400", aliases: ["744", "B744", "B747-400"] },
  { canonical: "747-8", aliases: ["748", "B748", "B747-8", "7478"] },
  { canonical: "757-200", aliases: ["752", "B752", "B757-200"] },
  { canonical: "757-300", aliases: ["753", "B753", "B757-300"] },
  { canonical: "767-300ER", aliases: ["763", "B763", "B767-300ER", "763ER"] },
  { canonical: "767-400ER", aliases: ["764", "B764", "B767-400ER", "764ER"] },
  { canonical: "777-200", aliases: ["772", "B772", "B777-200"] },
  { canonical: "777-200ER", aliases: ["772ER", "B777-200ER"] },
  { canonical: "777-200LR", aliases: ["77L", "B77L", "B777-200LR"] },
  { canonical: "777-300", aliases: ["773", "B773", "B777-300"] },
  { canonical: "777-300ER", aliases: ["77W", "B77W", "773ER", "B777-300ER"] },
  { canonical: "777-8", aliases: ["778", "B778", "B777-8"] },
  { canonical: "777-9", aliases: ["779", "B779", "B777-9"] },
  { canonical: "787-8", aliases: ["788", "B788", "B787-8", "7878"] },
  { canonical: "787-9", aliases: ["789", "B789", "B787-9", "7879"] },
  { canonical: "787-10", aliases: ["78X", "B78X", "B787-10", "7810", "7871000", "787-1000"] },
  { canonical: "E170", aliases: ["E70", "E170", "ERJ170"] },
  { canonical: "E175", aliases: ["E75", "E175", "ERJ175", "E75L", "E75S"] },
  { canonical: "E190", aliases: ["E90", "E190", "ERJ190"] },
  { canonical: "E195", aliases: ["E95", "E195", "ERJ195"] },
  { canonical: "E190-E2", aliases: ["E290", "E190E2"] },
  { canonical: "E195-E2", aliases: ["E295", "E195E2"] },
  { canonical: "ATR 72-600", aliases: ["AT7", "AT76", "ATR72", "ATR72600"] },
  { canonical: "CRJ-700", aliases: ["CR7", "CRJ7", "CRJ700"] },
  { canonical: "CRJ-900", aliases: ["CR9", "CRJ9", "CRJ900"] },
  { canonical: "CRJ-1000", aliases: ["CRK", "CRJ1000"] },
  { canonical: "MD-11", aliases: ["M11", "MD11"] }
];

function key(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const LOOKUP = new Map(AIRCRAFT_TYPES.flatMap((option) => [option.canonical, ...option.aliases].map((alias) => [key(alias), option.canonical] as const)));

export function normalizeAircraftType(value: string | null | undefined) {
  const trimmed = value?.trim() || "";
  return trimmed ? LOOKUP.get(key(trimmed)) || trimmed : "";
}

export function searchAircraftTypes(query: string, limit = 6) {
  const needle = key(query);
  if (!needle) return [];
  return AIRCRAFT_TYPES.map((option) => {
    const values = [option.canonical, ...option.aliases].map(key);
    const exact = values.includes(needle);
    const starts = values.some((value) => value.startsWith(needle));
    const contains = values.some((value) => value.includes(needle));
    return { option, score: exact ? 100 : starts ? 50 : contains ? 10 : 0 };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.option.canonical.localeCompare(right.option.canonical)).slice(0, limit).map((item) => item.option);
}

````

## src/lib/airlines.ts

<!-- source: src/lib/airlines.ts sha256: a316d7523ff107077786c380ba8416e0e42f75ccecb380c7328ce29ab62fc150 encoding: utf8 -->
````typescript
export interface AirlineOption {
  iata: string;
  name: string;
  nameEn: string;
  aliases: string[];
}

// Curated passenger-airline lookup, not a live timetable or an exhaustive registry.
// Reference: https://www.iata.org/en/about/members/airline-list/
// Airport directory for regional carriers: https://www.fukuoka-airport.jp/tw/flight/airline/
const ROWS = [
  "CA|中国国际航空|Air China|国航 airchina",
  "MU|中国东方航空|China Eastern Airlines|东航 eastern",
  "CZ|中国南方航空|China Southern Airlines|南航 southern",
  "HU|海南航空|Hainan Airlines|海航 hainan",
  "ZH|深圳航空|Shenzhen Airlines|深航 shenzhen",
  "MF|厦门航空|Xiamen Airlines|厦航 xiamen",
  "3U|四川航空|Sichuan Airlines|川航 sichuan",
  "SC|山东航空|Shandong Airlines|山航 shandong",
  "HO|吉祥航空|Juneyao Airlines|吉祥 juneyao",
  "9C|春秋航空|Spring Airlines|春秋 spring",
  "JD|首都航空|Beijing Capital Airlines|首航 capital",
  "GS|天津航空|Tianjin Airlines|天航 tianjin",
  "PN|西部航空|West Air|西部 westair",
  "8L|祥鹏航空|Lucky Air|祥鹏 lucky",
  "KN|中国联合航空|China United Airlines|中联航 chinaunited",
  "EU|成都航空|Chengdu Airlines|成航 chengdu",
  "G5|华夏航空|China Express Airlines|华夏 chinaexpress",
  "TV|西藏航空|Tibet Airlines|藏航 tibet",
  "DR|瑞丽航空|Ruili Airlines|瑞丽 ruili",
  "QW|青岛航空|Qingdao Airlines|青岛 qingdao",
  "GX|北部湾航空|GX Airlines|北部湾 beibuwan",
  "GJ|长龙航空|Loong Air|长龙 loong",
  "UQ|乌鲁木齐航空|Urumqi Air|乌航 urumqi",
  "OQ|重庆航空|Chongqing Airlines|重庆 chongqing",
  "FM|上海航空|Shanghai Airlines|上航 shanghai",
  "CX|国泰航空|Cathay Pacific|国泰 cathay",
  "HX|香港航空|Hong Kong Airlines|港航 hongkongairlines",
  "UO|香港快运|HK Express|香港快运航空 港快 hkexpress",
  "NX|澳门航空|Air Macau|澳门 macau",
  "CI|中华航空|China Airlines|华航 中華航空 chinaairlines",
  "BR|长荣航空|EVA Air|长荣 長榮航空 eva",
  "JX|星宇航空|STARLUX Airlines|星宇 starlux",
  "IT|台湾虎航|Tigerair Taiwan|台灣虎航 虎航 tigerair",
  "B7|立荣航空|UNI Air|立榮航空 uniair",
  "AE|华信航空|Mandarin Airlines|華信航空 mandarin",
  "NH|全日空 ANA|All Nippon Airways|全日空 全日本空输 全日本空輸 ana",
  "JL|日本航空 JAL|Japan Airlines|日本航空 日航 jal",
  "MM|乐桃航空|Peach Aviation|乐桃 樂桃 peach",
  "GK|捷星日本|Jetstar Japan|捷星日本航空 jetstarjapan",
  "BC|天马航空|Skymark Airlines|天馬航空 skymark",
  "7G|星悦航空|StarFlyer|星悅航空 starflyer",
  "HD|北海道国际航空|AIRDO|北海道航空 airdo",
  "KE|大韩航空|Korean Air|大韓航空 korean",
  "OZ|韩亚航空|Asiana Airlines|韓亞航空 asiana",
  "7C|济州航空|Jeju Air|濟州航空 jeju",
  "LJ|真航空|Jin Air|진에어 jinair",
  "TW|德威航空|T'way Air|德威 tway",
  "BX|釜山航空|Air Busan|釜山 busan",
  "RS|首尔航空|Air Seoul|首爾航空 seoul",
  "SQ|新加坡航空|Singapore Airlines|新航 singapore",
  "TR|酷航|Scoot|scoot",
  "MH|马来西亚航空|Malaysia Airlines|马航 malaysia",
  "AK|亚洲航空（马来西亚）|AirAsia Malaysia|亚洲航空 亚航 airasia",
  "FD|泰国亚洲航空|Thai AirAsia|泰国亚航 thaiairasia",
  "QZ|印度尼西亚亚洲航空|Indonesia AirAsia|印尼亚航 indonesiaairasia",
  "D7|亚洲航空长途|AirAsia X|亚航长途 airasiax",
  "TG|泰国国际航空|Thai Airways|泰航 thai",
  "PG|曼谷航空|Bangkok Airways|曼谷 bangkok",
  "VN|越南航空|Vietnam Airlines|越航 vietnam",
  "VJ|越捷航空|VietJet Air|越捷 vietjet",
  "GA|印尼鹰航|Garuda Indonesia|嘉鲁达印度尼西亚航空 garuda",
  "PR|菲律宾航空|Philippine Airlines|菲航 philippine",
  "5J|宿务太平洋航空|Cebu Pacific|宿务 宿霧 cebupacific",
  "BI|文莱皇家航空|Royal Brunei Airlines|文莱 汶萊 brunei",
  "AI|印度航空|Air India|印航 airindia",
  "6E|靛蓝航空|IndiGo|靛蓝 indigo",
  "UL|斯里兰卡航空|SriLankan Airlines|斯里兰卡 srilankan",
  "EK|阿联酋航空|Emirates|阿航 emirates",
  "QR|卡塔尔航空|Qatar Airways|卡航 qatar",
  "EY|阿提哈德航空|Etihad Airways|阿提哈德 etihad",
  "FZ|迪拜航空|flydubai|迪拜 flydubai",
  "G9|阿拉伯航空|Air Arabia|airarabia",
  "SV|沙特阿拉伯航空|Saudia|沙特 saudia",
  "WY|阿曼航空|Oman Air|阿曼 oman",
  "GF|海湾航空|Gulf Air|海湾 gulf",
  "KU|科威特航空|Kuwait Airways|科威特 kuwait",
  "TK|土耳其航空|Turkish Airlines|土航 turkish",
  "LH|汉莎航空|Lufthansa|汉莎 lufthansa",
  "AF|法国航空|Air France|法航 airfrance",
  "KL|荷兰皇家航空|KLM Royal Dutch Airlines|荷航 klm",
  "BA|英国航空|British Airways|英航 british",
  "VS|维珍大西洋航空|Virgin Atlantic|维珍大西洋 virginatlantic",
  "LX|瑞士国际航空|SWISS|瑞航 瑞士航空 swiss",
  "OS|奥地利航空|Austrian Airlines|奥航 austrian",
  "AY|芬兰航空|Finnair|芬航 finnair",
  "SK|北欧航空|Scandinavian Airlines|北欧 sas",
  "IB|伊比利亚航空|Iberia|伊比利亚 iberia",
  "TP|葡萄牙航空|TAP Air Portugal|葡航 tap",
  "LO|波兰航空|LOT Polish Airlines|波航 lot",
  "AZ|意大利航空 ITA|ITA Airways|ita 意大利 itaairways",
  "A3|爱琴海航空|Aegean Airlines|爱琴海 aegean",
  "EI|爱尔兰航空|Aer Lingus|爱尔兰 aerlingus",
  "UA|联合航空|United Airlines|美联航 美国联合航空 united",
  "AA|美国航空|American Airlines|美航 american",
  "DL|达美航空|Delta Air Lines|达美 delta",
  "AS|阿拉斯加航空|Alaska Airlines|阿拉斯加 alaska",
  "WN|美国西南航空|Southwest Airlines|西南 southwest",
  "B6|捷蓝航空|JetBlue Airways|捷蓝 jetblue",
  "HA|夏威夷航空|Hawaiian Airlines|夏威夷 hawaiian",
  "AC|加拿大航空|Air Canada|加航 aircanada",
  "WS|西捷航空|WestJet|西捷 westjet",
  "AM|墨西哥航空|Aeromexico|墨西哥 aeromexico",
  "LA|拉塔姆航空|LATAM Airlines|南美 latam",
  "AV|哥伦比亚航空|Avianca|哥伦比亚 avianca",
  "CM|巴拿马航空|Copa Airlines|巴拿马 copa",
  "QF|澳洲航空|Qantas|澳航 澳洲 qantas",
  "JQ|捷星航空|Jetstar Airways|捷星 jetstar",
  "VA|维珍澳大利亚航空|Virgin Australia|维珍澳洲 virginaustralia",
  "NZ|新西兰航空|Air New Zealand|纽航 新西兰 airnewzealand",
  "FJ|斐济航空|Fiji Airways|斐济 fiji",
  "ET|埃塞俄比亚航空|Ethiopian Airlines|埃航 ethiopian",
  "KQ|肯尼亚航空|Kenya Airways|肯尼亚 kenya",
  "MS|埃及航空|Egyptair|埃及 egyptair",
  "AT|摩洛哥皇家航空|Royal Air Maroc|摩洛哥 maroc"
];

export const AIRLINES: AirlineOption[] = ROWS.map((row) => {
  const [iata, name, nameEn, aliases] = row.split("|");
  return { iata, name, nameEn, aliases: aliases.split(" ") };
});

function key(value: string) { return value.normalize("NFKC").toUpperCase().replace(/[\s()（）'’·.-]/g, ""); }

export function resolveAirline(value: string): AirlineOption | undefined {
  const query = key(value);
  if (!query) return undefined;
  return AIRLINES.find((airline) => [airline.iata, airline.name, airline.nameEn, ...airline.aliases].some((alias) => key(alias) === query));
}

export function searchAirlines(value: string, limit = 12): AirlineOption[] {
  const query = key(value);
  const exact = resolveAirline(value);
  return AIRLINES.filter((airline) => !query || [airline.iata, airline.name, airline.nameEn, ...airline.aliases].some((alias) => key(alias).includes(query)))
    .sort((a, b) => Number(b === exact) - Number(a === exact)).slice(0, limit);
}

export function normalizeFlightNumber(value: string) { return value.normalize("NFKC").toUpperCase().replace(/\s/g, ""); }
export function isFlightNumberSuffix(value: string) { return /^\d{1,4}[A-Z]?$/.test(normalizeFlightNumber(value)); }
export function isCompleteFlightNumber(value: string) { return /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}[A-Z]?$/.test(normalizeFlightNumber(value)); }

export function completeFlightNumber(value: string, airline: string): string {
  const normalized = normalizeFlightNumber(value);
  const selected = resolveAirline(airline);
  return selected && isFlightNumberSuffix(normalized) ? `${selected.iata}${normalized}` : normalized;
}

// Existing full numbers remain intact, including a codeshare's marketing code.
export function flightNumberInput(value: string, airline: string): string {
  const selected = resolveAirline(airline);
  const normalized = normalizeFlightNumber(value);
  return selected && isCompleteFlightNumber(normalized) && normalized.startsWith(selected.iata) ? normalized.slice(2) : normalized;
}

````

## src/lib/airports.ts

<!-- source: src/lib/airports.ts sha256: ec1b5e6e5a3005992460cf8ba4bc6e46df88d52f0e72495ab2c9b7d6b241d7c9 encoding: utf8 -->
````typescript
export interface AirportOption {
  iata: string;
  nameZh: string;
  nameEn: string;
  city: string;
  timezone: string;
  aliases: string[];
}

// Curated offline catalogue of major scheduled-service airports. The list is
// deliberately bundled with the app: searching never consumes Aviationstack
// quota and remains available while offline.
const ROWS = [
  "HND|东京羽田国际机场|Tokyo Haneda Airport|东京 Tokyo|Asia/Tokyo|羽田 haneda dongjing",
  "NRT|东京成田国际机场|Narita International Airport|东京 Tokyo|Asia/Tokyo|成田 narita dongjing",
  "KIX|关西国际机场|Kansai International Airport|大阪 Osaka|Asia/Tokyo|关西 大阪 kansai osaka",
  "ITM|大阪伊丹机场|Osaka Itami Airport|大阪 Osaka|Asia/Tokyo|伊丹 itami osaka",
  "NGO|中部国际机场|Chubu Centrair International Airport|名古屋 Nagoya|Asia/Tokyo|名古屋 中部 centair nagoya",
  "CTS|新千岁机场|New Chitose Airport|札幌 Sapporo|Asia/Tokyo|新千岁 札幌 chitose sapporo",
  "FUK|福冈机场|Fukuoka Airport|福冈 Fukuoka|Asia/Tokyo|fukuoka",
  "OKA|那霸机场|Naha Airport|冲绳 Okinawa|Asia/Tokyo|那霸 冲绳 naha okinawa",
  "PEK|北京首都国际机场|Beijing Capital International Airport|北京 Beijing|Asia/Shanghai|首都机场 shoudu beijing",
  "PKX|北京大兴国际机场|Beijing Daxing International Airport|北京 Beijing|Asia/Shanghai|大兴 daxing beijing",
  "PVG|上海浦东国际机场|Shanghai Pudong International Airport|上海 Shanghai|Asia/Shanghai|浦东 pudong shanghai",
  "SHA|上海虹桥国际机场|Shanghai Hongqiao International Airport|上海 Shanghai|Asia/Shanghai|虹桥 hongqiao shanghai",
  "CAN|广州白云国际机场|Guangzhou Baiyun International Airport|广州 Guangzhou|Asia/Shanghai|白云 baiyun guangzhou",
  "SZX|深圳宝安国际机场|Shenzhen Bao'an International Airport|深圳 Shenzhen|Asia/Shanghai|宝安 baoan shenzhen",
  "CTU|成都双流国际机场|Chengdu Shuangliu International Airport|成都 Chengdu|Asia/Shanghai|双流 shuangliu chengdu",
  "TFU|成都天府国际机场|Chengdu Tianfu International Airport|成都 Chengdu|Asia/Shanghai|天府 tianfu chengdu",
  "CKG|重庆江北国际机场|Chongqing Jiangbei International Airport|重庆 Chongqing|Asia/Shanghai|江北 jiangbei chongqing",
  "XIY|西安咸阳国际机场|Xi'an Xianyang International Airport|西安 Xian|Asia/Shanghai|咸阳 xianyang xian",
  "HGH|杭州萧山国际机场|Hangzhou Xiaoshan International Airport|杭州 Hangzhou|Asia/Shanghai|萧山 xiaoshan hangzhou",
  "NKG|南京禄口国际机场|Nanjing Lukou International Airport|南京 Nanjing|Asia/Shanghai|禄口 lukou nanjing",
  "WUH|武汉天河国际机场|Wuhan Tianhe International Airport|武汉 Wuhan|Asia/Shanghai|天河 tianhe wuhan",
  "CSX|长沙黄花国际机场|Changsha Huanghua International Airport|长沙 Changsha|Asia/Shanghai|黄花 huanghua changsha",
  "KMG|昆明长水国际机场|Kunming Changshui International Airport|昆明 Kunming|Asia/Shanghai|长水 changshui kunming",
  "XMN|厦门高崎国际机场|Xiamen Gaoqi International Airport|厦门 Xiamen|Asia/Shanghai|高崎 gaoqi xiamen",
  "TAO|青岛胶东国际机场|Qingdao Jiaodong International Airport|青岛 Qingdao|Asia/Shanghai|胶东 jiaodong qingdao",
  "TSN|天津滨海国际机场|Tianjin Binhai International Airport|天津 Tianjin|Asia/Shanghai|滨海 binhai tianjin",
  "DLC|大连周水子国际机场|Dalian Zhoushuizi International Airport|大连 Dalian|Asia/Shanghai|周水子 dalian",
  "HKG|香港国际机场|Hong Kong International Airport|香港 Hong Kong|Asia/Hong_Kong|赤鱲角 chek lap kok hongkong",
  "MFM|澳门国际机场|Macau International Airport|澳门 Macau|Asia/Macau|macau aomen",
  "TPE|台北桃园国际机场|Taiwan Taoyuan International Airport|台北 Taipei|Asia/Taipei|桃园 taoyuan taipei",
  "TSA|台北松山机场|Taipei Songshan Airport|台北 Taipei|Asia/Taipei|松山 songshan taipei",
  "KHH|高雄国际机场|Kaohsiung International Airport|高雄 Kaohsiung|Asia/Taipei|kaohsiung gaoxiong",
  "ICN|仁川国际机场|Incheon International Airport|首尔 Seoul|Asia/Seoul|仁川 incheon seoul",
  "GMP|首尔金浦国际机场|Gimpo International Airport|首尔 Seoul|Asia/Seoul|金浦 gimpo seoul",
  "PUS|釜山金海国际机场|Gimhae International Airport|釜山 Busan|Asia/Seoul|金海 gimhae busan",
  "SIN|新加坡樟宜机场|Singapore Changi Airport|新加坡 Singapore|Asia/Singapore|樟宜 changi",
  "BKK|曼谷素万那普机场|Suvarnabhumi Airport|曼谷 Bangkok|Asia/Bangkok|素万那普 suvarnabhumi bangkok",
  "DMK|曼谷廊曼国际机场|Don Mueang International Airport|曼谷 Bangkok|Asia/Bangkok|廊曼 don mueang bangkok",
  "HKT|普吉国际机场|Phuket International Airport|普吉 Phuket|Asia/Bangkok|phuket puji",
  "KUL|吉隆坡国际机场|Kuala Lumpur International Airport|吉隆坡 Kuala Lumpur|Asia/Kuala_Lumpur|klia kuala lumpur",
  "CGK|雅加达苏加诺-哈达国际机场|Soekarno-Hatta International Airport|雅加达 Jakarta|Asia/Jakarta|soekarno hatta jakarta",
  "DPS|巴厘岛伍拉·赖国际机场|I Gusti Ngurah Rai International Airport|巴厘岛 Bali|Asia/Makassar|登巴萨 denpasar bali",
  "MNL|马尼拉尼诺伊·阿基诺国际机场|Ninoy Aquino International Airport|马尼拉 Manila|Asia/Manila|naia manila",
  "SGN|胡志明市新山一国际机场|Tan Son Nhat International Airport|胡志明市 Ho Chi Minh City|Asia/Ho_Chi_Minh|新山一 saigon ho chi minh",
  "HAN|河内内排国际机场|Noi Bai International Airport|河内 Hanoi|Asia/Ho_Chi_Minh|内排 noi bai hanoi",
  "DEL|德里英迪拉·甘地国际机场|Indira Gandhi International Airport|德里 Delhi|Asia/Kolkata|new delhi",
  "BOM|孟买贾特拉帕蒂·希瓦吉国际机场|Chhatrapati Shivaji Maharaj International Airport|孟买 Mumbai|Asia/Kolkata|mumbai bombay",
  "DXB|迪拜国际机场|Dubai International Airport|迪拜 Dubai|Asia/Dubai|dubai",
  "AUH|阿布扎比扎耶德国际机场|Zayed International Airport|阿布扎比 Abu Dhabi|Asia/Dubai|abu dhabi",
  "DOH|多哈哈马德国际机场|Hamad International Airport|多哈 Doha|Asia/Qatar|hamad doha",
  "IST|伊斯坦布尔机场|Istanbul Airport|伊斯坦布尔 Istanbul|Europe/Istanbul|istanbul",
  "LHR|伦敦希思罗机场|London Heathrow Airport|伦敦 London|Europe/London|希思罗 heathrow london",
  "LGW|伦敦盖特威克机场|London Gatwick Airport|伦敦 London|Europe/London|盖特威克 gatwick london",
  "CDG|巴黎戴高乐机场|Paris Charles de Gaulle Airport|巴黎 Paris|Europe/Paris|戴高乐 charles de gaulle paris",
  "ORY|巴黎奥利机场|Paris Orly Airport|巴黎 Paris|Europe/Paris|奥利 orly paris",
  "FRA|法兰克福机场|Frankfurt Airport|法兰克福 Frankfurt|Europe/Berlin|frankfurt",
  "MUC|慕尼黑机场|Munich Airport|慕尼黑 Munich|Europe/Berlin|munich",
  "AMS|阿姆斯特丹史基浦机场|Amsterdam Airport Schiphol|阿姆斯特丹 Amsterdam|Europe/Amsterdam|史基浦 schiphol amsterdam",
  "MAD|马德里巴拉哈斯机场|Adolfo Suárez Madrid-Barajas Airport|马德里 Madrid|Europe/Madrid|barajas madrid",
  "BCN|巴塞罗那埃尔普拉特机场|Barcelona-El Prat Airport|巴塞罗那 Barcelona|Europe/Madrid|el prat barcelona",
  "FCO|罗马菲乌米奇诺机场|Rome Fiumicino Airport|罗马 Rome|Europe/Rome|fiumicino rome",
  "MXP|米兰马尔彭萨机场|Milan Malpensa Airport|米兰 Milan|Europe/Rome|malpensa milan",
  "ZRH|苏黎世机场|Zurich Airport|苏黎世 Zurich|Europe/Zurich|zurich",
  "VIE|维也纳国际机场|Vienna International Airport|维也纳 Vienna|Europe/Vienna|vienna",
  "CPH|哥本哈根凯斯楚普机场|Copenhagen Airport|哥本哈根 Copenhagen|Europe/Copenhagen|kastrup copenhagen",
  "HEL|赫尔辛基万塔机场|Helsinki Airport|赫尔辛基 Helsinki|Europe/Helsinki|vantaa helsinki",
  "SVO|莫斯科谢列梅捷沃机场|Sheremetyevo International Airport|莫斯科 Moscow|Europe/Moscow|sheremetyevo moscow",
  "JFK|纽约肯尼迪国际机场|John F. Kennedy International Airport|纽约 New York|America/New_York|kennedy new york nyc",
  "EWR|纽约纽瓦克自由国际机场|Newark Liberty International Airport|纽约 New York|America/New_York|newark new york nyc",
  "LGA|纽约拉瓜迪亚机场|LaGuardia Airport|纽约 New York|America/New_York|laguardia new york nyc",
  "LAX|洛杉矶国际机场|Los Angeles International Airport|洛杉矶 Los Angeles|America/Los_Angeles|los angeles la",
  "SFO|旧金山国际机场|San Francisco International Airport|旧金山 San Francisco|America/Los_Angeles|san francisco",
  "SEA|西雅图-塔科马国际机场|Seattle-Tacoma International Airport|西雅图 Seattle|America/Los_Angeles|seatac seattle",
  "ORD|芝加哥奥黑尔国际机场|O'Hare International Airport|芝加哥 Chicago|America/Chicago|ohare chicago",
  "DFW|达拉斯-沃思堡国际机场|Dallas Fort Worth International Airport|达拉斯 Dallas|America/Chicago|dallas fort worth",
  "ATL|亚特兰大哈茨菲尔德-杰克逊机场|Hartsfield-Jackson Atlanta International Airport|亚特兰大 Atlanta|America/New_York|atlanta",
  "BOS|波士顿洛根国际机场|Boston Logan International Airport|波士顿 Boston|America/New_York|logan boston",
  "IAD|华盛顿杜勒斯国际机场|Washington Dulles International Airport|华盛顿 Washington|America/New_York|dulles washington dc",
  "MIA|迈阿密国际机场|Miami International Airport|迈阿密 Miami|America/New_York|miami",
  "DEN|丹佛国际机场|Denver International Airport|丹佛 Denver|America/Denver|denver",
  "LAS|拉斯维加斯哈里·里德国际机场|Harry Reid International Airport|拉斯维加斯 Las Vegas|America/Los_Angeles|las vegas mccarran",
  "HNL|檀香山丹尼尔·井上国际机场|Daniel K. Inouye International Airport|檀香山 Honolulu|Pacific/Honolulu|honolulu hawaii 夏威夷",
  "YYZ|多伦多皮尔逊国际机场|Toronto Pearson International Airport|多伦多 Toronto|America/Toronto|pearson toronto",
  "YVR|温哥华国际机场|Vancouver International Airport|温哥华 Vancouver|America/Vancouver|vancouver",
  "SYD|悉尼金斯福德·史密斯机场|Sydney Kingsford Smith Airport|悉尼 Sydney|Australia/Sydney|sydney",
  "MEL|墨尔本机场|Melbourne Airport|墨尔本 Melbourne|Australia/Melbourne|tullamarine melbourne",
  "BNE|布里斯班机场|Brisbane Airport|布里斯班 Brisbane|Australia/Brisbane|brisbane",
  "PER|珀斯机场|Perth Airport|珀斯 Perth|Australia/Perth|perth",
  "AKL|奥克兰机场|Auckland Airport|奥克兰 Auckland|Pacific/Auckland|auckland",
  "GRU|圣保罗瓜鲁柳斯国际机场|São Paulo-Guarulhos International Airport|圣保罗 Sao Paulo|America/Sao_Paulo|guarulhos sao paulo",
  "MEX|墨西哥城贝尼托·华雷斯国际机场|Mexico City International Airport|墨西哥城 Mexico City|America/Mexico_City|benito juarez mexico city",
  "JNB|约翰内斯堡奥利弗·坦博国际机场|O. R. Tambo International Airport|约翰内斯堡 Johannesburg|Africa/Johannesburg|tambo johannesburg",
  "CPT|开普敦国际机场|Cape Town International Airport|开普敦 Cape Town|Africa/Johannesburg|cape town",
  "CAI|开罗国际机场|Cairo International Airport|开罗 Cairo|Africa/Cairo|cairo"
];

export const AIRPORTS: AirportOption[] = ROWS.map((row) => {
  const [iata, nameZh, nameEn, city, timezone, aliases] = row.split("|");
  return { iata, nameZh, nameEn, city, timezone, aliases: aliases.split(" ") };
});

function normalize(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, " ").trim();
}

export function searchAirports(query: string, limit = 8) {
  const needle = normalize(query);
  if (!needle) return [];
  return AIRPORTS.map((airport) => {
    const haystack = normalize([airport.iata, airport.nameZh, airport.nameEn, airport.city, ...airport.aliases].join(" "));
    const exactIata = airport.iata.toLocaleLowerCase() === needle;
    const starts = haystack.split(" ").some((word) => word.startsWith(needle));
    const includes = haystack.includes(needle);
    return { airport, score: exactIata ? 100 : starts ? 50 : includes ? 10 : 0 };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.airport.iata.localeCompare(right.airport.iata)).slice(0, limit).map((item) => item.airport);
}

export function airportLabel(airport: AirportOption) {
  return `${airport.nameZh} (${airport.iata})`;
}

````

## src/lib/calendar.ts

<!-- source: src/lib/calendar.ts sha256: 3501a95a78bcfad247bf1ddd8b2fb380c77d8aa6c7eff01b6cdcb1dae8d09a0f encoding: utf8 -->
````typescript
import type { FlightDetails, LifeRecord, Trip } from "../types";
import { dateInZone } from "./tripDates";
import { flightTripPlacement } from "./flightTripPlacement";
import { normalizeScheduleDetails, scheduleDayEntries } from "./schedules";

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function validTimeZone(timeZone: string) { try { new Intl.DateTimeFormat("en", { timeZone }).format(); return true; } catch { return false; } }
export function tripToday(trip: Pick<Trip, "timezone">, now = new Date()) { return dateInZone(now.toISOString(), validTimeZone(trip.timezone) ? trip.timezone : "UTC"); }
export function tripDayNumber(trip: Pick<Trip, "start_date" | "timezone">, now = new Date()) {
  return Math.round((Date.parse(`${tripToday(trip, now)}T12:00:00Z`) - Date.parse(`${trip.start_date}T12:00:00Z`)) / 86_400_000) + 1;
}
export function activeTrip(trips: Trip[], now = new Date()) { return trips.find(trip => { const today = tripToday(trip, now); return trip.start_date <= today && trip.end_date >= today; }); }
export function plansForDay(records: LifeRecord[], trip: Trip, day: string) {
  return records.filter(record => {
    if (record.trip_id !== trip.id || record.record_type !== "trip" || record.parent_plan_id || record.plan_status === "cancelled") return false;
    if (normalizeScheduleDetails(record.schedule_details)) return scheduleDayEntries([record], day).length > 0;
    if (record.transport_type === "flight" && record.transport_details) return flightTripPlacement(record.transport_details as FlightDetails, trip).day === day;
    return dateInZone(record.event_at, validTimeZone(trip.timezone) ? trip.timezone : "UTC") === day;
  }).sort((a, b) => {
    const aAll = Boolean(normalizeScheduleDetails(a.schedule_details)), bAll = Boolean(normalizeScheduleDetails(b.schedule_details));
    return Number(bAll) - Number(aAll) || a.event_at.localeCompare(b.event_at) || a.id.localeCompare(b.id);
  });
}
export function timelineDate(record: LifeRecord, timeZone = deviceTimeZone()) {
  const schedule = normalizeScheduleDetails(record.schedule_details);
  if (schedule) return schedule.start_date;
  if (record.transport_type === "flight" && record.transport_details) return (record.transport_details as FlightDetails).departure.date;
  return dateInZone(record.event_at, timeZone);
}
export function groupTimeline(records: LifeRecord[], timeZone = deviceTimeZone()) {
  const groups = new Map<string, LifeRecord[]>();
  for (const record of records) { const date = timelineDate(record, timeZone); groups.set(date, [...(groups.get(date) || []), record]); }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, items]) => [date, items.sort((a, b) => b.event_at.localeCompare(a.event_at) || a.id.localeCompare(b.id))] as const);
}

````

## src/lib/data.ts

<!-- source: src/lib/data.ts sha256: c9b3e24a3af2b96b23bd46d7741c3c9c2cb1170d6715f4f0212ca9f319d5cc65 encoding: utf8 -->
````typescript
import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { claimMutation, failMutation, finishMutation, listMutations, loadSnapshot, queueMutation, reconcileMutations, saveSnapshot, type PendingMutation } from "./offline";
import { replayMutation, type SaveResult } from "./syncEngine";
import { invalidateChangedFlight } from "./flightMatchState";
import type { Changelog, Currency, ExchangeRate, LifeRecord, RecordDraft, Trip, TripDraft, UserProfile, UserSettings } from "../types";
import { APP_VERSION } from "../version";
import { normalizeTransport } from "./transport";
import { mergeBundledReleaseNotes } from "./releaseNotes";
import { normalizeAircraftType } from "./aircraftTypes";
import { normalizeScheduleDetails } from "./schedules";
import { readAllPages } from "../../supabase/functions/_shared/pagination";

export interface AppData {
  records: LifeRecord[];
  trips: Trip[];
  rates: ExchangeRate[];
  settings: UserSettings;
  profile: UserProfile;
  changelogs: Changelog[];
}

const now = () => new Date().toISOString();

export function defaultSettings(userId: string): UserSettings {
  const timestamp = now();
  return {
    user_id: userId,
    base_currency: "USD",
    theme: "system",
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function defaultProfile(user: User): UserProfile {
  const timestamp = now();
  const metadataName = user.user_metadata?.display_name || user.user_metadata?.full_name || user.user_metadata?.name;
  return {
    user_id: user.id,
    display_name: String(metadataName || user.email?.split("@")[0] || "Life Tracker 用户").slice(0, 40),
    avatar_url: null,
    avatar_color: "#0A84FF",
    has_seen_onboarding: false,
    last_seen_version: APP_VERSION,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export const normalizeRecord = (row: Record<string, unknown>): LifeRecord => {
  const transport = normalizeTransport(row.transport_type, row.transport_details);
  const actualInfo = row.actual_info as NonNullable<LifeRecord["actual_info"]> | null;
  return {
    ...(row as unknown as LifeRecord),
    amount: row.amount == null ? null : Number(row.amount),
    sort_order: row.sort_order == null ? null : Number(row.sort_order),
    ...(row.schedule_details !== undefined ? { schedule_details: normalizeScheduleDetails(row.schedule_details) } : {}),
    actual_match_status: (row.actual_match_status || "never") as LifeRecord["actual_match_status"],
    actual_info: actualInfo ? { ...actualInfo, aircraft_type: normalizeAircraftType(actualInfo.aircraft_type) } : null,
    actual_info_matched: Boolean(row.actual_info_matched),
    actual_matched_at: typeof row.actual_matched_at === "string" ? row.actual_matched_at : null,
    actual_match_provider: typeof row.actual_match_provider === "string" ? row.actual_match_provider : null,
    actual_match_request_id: typeof row.actual_match_request_id === "string" ? row.actual_match_request_id : null,
    ...transport
  };
};

const normalizeRate = (row: Record<string, unknown>): ExchangeRate => ({
  ...(row as unknown as ExchangeRate),
  rate: Number(row.rate)
});

export async function fetchAppData(user: User): Promise<AppData> {
  const authBefore = (await supabase.auth.getSession()).data.session;
  if (authBefore?.user.id !== user.id) throw new Error("账号已切换，请在原账号中读取数据");
  const collection = (table: "records" | "trips" | "exchange_rates" | "changelogs") => readAllPages((cursor) => {
    let query = supabase.from(table).select("*").order("id", { ascending: true }).limit(500);
    if (table !== "changelogs") query = query.eq("user_id", user.id);
    if (table === "trips") query = query.is("archived_at", null);
    if (cursor) query = query.gt("id", cursor);
    return query;
  });
  const [recordRows, tripRows, settingsResult, rateRows, profileResult, changelogRows] = await Promise.all([
    collection("records"),
    collection("trips"),
    supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle(),
    collection("exchange_rates"),
    supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle(),
    collection("changelogs")
  ]);

  const firstError = settingsResult.error || profileResult.error;
  if (firstError) throw firstError;
  const authAfter = (await supabase.auth.getSession()).data.session;
  if (authAfter?.user.id !== user.id || authAfter.access_token !== authBefore.access_token) throw new Error("登录会话已更新，请重新读取云端数据");

  let settings = (settingsResult.data as UserSettings | null) || defaultSettings(user.id);
  if (!settingsResult.data) {
    const inserted = await supabase.from("user_settings").upsert(settings, { onConflict: "user_id", ignoreDuplicates: true });
    if (inserted.error) throw inserted.error;
    const saved = await supabase.from("user_settings").select().eq("user_id", user.id).single();
    if (saved.error) throw saved.error;
    settings = saved.data as UserSettings;
  }
  const profile = (profileResult.data as UserProfile | null) || defaultProfile(user);
  if (!profileResult.data) {
    const inserted = await supabase.from("profiles").upsert(profile, { onConflict: "user_id", ignoreDuplicates: true });
    if (inserted.error) throw inserted.error;
    const saved = await supabase.from("profiles").select().eq("user_id", user.id).single();
    if (saved.error) throw saved.error;
    Object.assign(profile, saved.data);
  }

  const data: AppData = {
    records: recordRows.map((row) => normalizeRecord(row)).sort((a, b) => b.event_at.localeCompare(a.event_at) || a.id.localeCompare(b.id)),
    trips: (tripRows as Trip[]).sort((a, b) => b.start_date.localeCompare(a.start_date) || a.id.localeCompare(b.id)),
    settings,
    rates: rateRows.map((row) => normalizeRate(row)).sort((a, b) => b.rate_date.localeCompare(a.rate_date) || a.id.localeCompare(b.id)),
    profile,
    changelogs: mergeBundledReleaseNotes(changelogRows as Changelog[])
  };
  for (const item of await listMutations(user.id)) {
    // Rejected/conflicting drafts remain visible and exportable, never silently
    // replaced by an older cloud row. Legacy unproven queue entries stay isolated.
    if (item.legacy || item.supersededBy) continue;
    if (item.table === "records") data.records = [normalizeRecord(item.payload), ...data.records.filter((row) => row.id !== item.entityId)];
    if (item.table === "trips") data.trips = [item.payload as unknown as Trip, ...data.trips.filter((row) => row.id !== item.entityId)];
    if (item.table === "user_settings") data.settings = item.payload as unknown as UserSettings;
    if (item.table === "profiles") data.profile = item.payload as unknown as UserProfile;
    if (item.table === "exchange_rates") data.rates = [normalizeRate(item.payload), ...data.rates.filter((row) => row.id !== item.entityId)];
  }
  await saveSnapshot({ userId: user.id, ...data, savedAt: now() });
  return data;
}

export async function cachedAppData(user: User): Promise<AppData | null> {
  const cached = await loadSnapshot(user.id);
  if (!cached) return null;
  return {
    records: cached.records.map((record) => normalizeRecord(record as unknown as Record<string, unknown>)),
    trips: cached.trips,
    rates: cached.rates,
    settings: cached.settings,
    profile: cached.profile || defaultProfile(user),
    changelogs: mergeBundledReleaseNotes(cached.changelogs || [])
  };
}

const editableFields: Record<string, string[]> = {
  records: ["id", "user_id", "record_type", "content", "notes", "amount", "currency", "expense_category", "location", "event_at", "trip_id", "plan_status", "sort_order", "parent_plan_id", "transport_type", "transport_details", "schedule_details", "image_path"],
  trips: ["id", "user_id", "name", "destination", "start_date", "end_date", "timezone", "archived_at"],
  user_settings: ["user_id", "base_currency", "theme"],
  profiles: ["user_id", "display_name", "avatar_url", "avatar_color", "has_seen_onboarding", "last_seen_version"],
  exchange_rates: ["id", "user_id", "base_currency", "quote_currency", "rate", "rate_date", "source"]
};
const syncAdapter = {
  currentOwner: async () => (await supabase.auth.getSession()).data.session?.user.id,
  claim: claimMutation, finish: finishMutation, fail: failMutation,
  write: async (item: Awaited<ReturnType<typeof queueMutation>>) => {
    const payload = Object.fromEntries(Object.entries(item.payload).filter(([key]) => editableFields[item.table].includes(key)));
    return await supabase.rpc("save_user_mutation", { p_table: item.table, p_payload: payload, p_expected_updated_at: item.expectedUpdatedAt, p_request_id: item.id });
  }
};

export async function inspectSyncConflict(item: PendingMutation) {
  if (await syncAdapter.currentOwner() !== item.ownerId) throw new Error("账号已切换");
  const inspected = (await listMutations(item.ownerId)).filter(old => !old.supersededBy && old.table === item.table && old.entityId === item.entityId);
  const key = item.table === "profiles" || item.table === "user_settings" ? "user_id" : "id";
  const { data: cloud, error } = await supabase.from(item.table).select("*").eq("user_id", item.ownerId).eq(key, item.entityId).maybeSingle();
  if (error) throw error;
  if (await syncAdapter.currentOwner() !== item.ownerId) throw new Error("账号已切换");
  return { inspected, cloud: cloud as Record<string, unknown> | null };
}

export async function resolveSyncConflict(review: Awaited<ReturnType<typeof inspectSyncConflict>>, choice: "cloud" | "local") {
  const owner = review.inspected[0]?.ownerId;
  if (!owner || await syncAdapter.currentOwner() !== owner) throw new Error("账号已切换");
  const queued = await reconcileMutations(review.inspected, review.cloud, choice);
  if (queued) {
    const result = await replayMutation(queued, syncAdapter);
    if (result?.state !== "confirmed") throw new Error("尚未确认保存；若云端再次变化，请重新比较冲突。本机副本已保留。");
  }
}
async function upsertOrQueue(table: Awaited<ReturnType<typeof queueMutation>>["table"], payload: Record<string, unknown>, previous?: { updated_at: string }): Promise<SaveResult> {
  const item = await queueMutation({ ownerId: String(payload.user_id), table, operation: "upsert", payload, expectedUpdatedAt: previous?.updated_at || null });
  if (navigator.onLine) return await replayMutation(item, syncAdapter) || { state: "pending", row: payload };
  return { state: "pending", row: payload };
}

export async function syncOutbox(ownerId: string) {
  if (!navigator.onLine) return 0;
  let synced = 0;
  for (const item of await listMutations(ownerId)) {
    const result = await replayMutation(item, syncAdapter);
    if (result?.state === "confirmed") synced += 1;
  }
  return synced;
}

export function makeRecord(user: User, draft: RecordDraft): LifeRecord {
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    user_id: user.id,
    record_type: draft.record_type,
    content: draft.content.trim(),
    notes: draft.notes?.trim() || null,
    amount: draft.amount ?? null,
    currency: draft.currency ?? null,
    expense_category: draft.expense_category ?? null,
    location: draft.location?.trim() || null,
    event_at: draft.event_at || timestamp,
    trip_id: draft.trip_id || null,
    plan_status: draft.plan_status || null,
    sort_order: draft.sort_order ?? null,
    parent_plan_id: draft.parent_plan_id || null,
    transport_type: draft.transport_type ?? null,
    transport_details: draft.transport_details ?? null,
    ...(draft.schedule_details ? { schedule_details: normalizeScheduleDetails(draft.schedule_details) } : {}),
    actual_match_status: "never",
    actual_info: null,
    actual_info_matched: false,
    actual_matched_at: null,
    actual_match_provider: null,
    actual_match_request_id: null,
    image_path: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function makeTrip(user: User, draft: TripDraft): Trip {
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    user_id: user.id,
    name: draft.name.trim(),
    destination: draft.destination.trim(),
    start_date: draft.start_date,
    end_date: draft.end_date,
    timezone: draft.timezone,
    archived_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export async function persistRecord(record: LifeRecord, previous?: LifeRecord) {
  const safe = previous ? invalidateChangedFlight(previous, record) : record;
  const result = await upsertOrQueue("records", safe as unknown as Record<string, unknown>, previous);
  return { ...result, row: normalizeRecord(result.row) as unknown as Record<string, unknown> };
}

export async function persistTrip(trip: Trip, previous?: Trip) {
  return upsertOrQueue("trips", trip as unknown as Record<string, unknown>, previous);
}

export async function persistSettings(settings: UserSettings, previous?: UserSettings) {
  return upsertOrQueue("user_settings", settings as unknown as Record<string, unknown>, previous);
}

export async function persistProfile(profile: UserProfile, previous?: UserProfile) {
  return upsertOrQueue("profiles", profile as unknown as Record<string, unknown>, previous);
}

export async function uploadAvatar(user: User, avatar: Blob) {
  if (!navigator.onLine) throw new Error("上传头像时需要连接网络");
  const path = `${user.id}/avatar.webp`;
  const { error } = await supabase.storage.from("avatars").upload(path, avatar, {
    contentType: "image/webp",
    cacheControl: "3600",
    upsert: true
  });
  if (error) throw error;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

export async function persistRates(rates: ExchangeRate[]) {
  for (const rate of rates) {
    const result = await upsertOrQueue("exchange_rates", rate as unknown as Record<string, unknown>);
    if (result.state === "failed" || result.state === "conflict") throw new Error(result.error);
  }
}

export async function refreshRates(user: User, quote: Currency, currencies: Currency[], persist = true) {
  const unique = [...new Set(currencies.filter((currency) => currency !== quote))];
  const fetched = await Promise.all(unique.map(async (base) => {
    const response = await fetch(`https://api.frankfurter.dev/v2/rate/${base}/${quote}`);
    if (!response.ok) throw new Error(`无法获取 ${base}/${quote} 汇率`);
    const body = await response.json() as { date: string; base: Currency; quote: Currency; rate: number };
    const timestamp = now();
    return {
      id: crypto.randomUUID(),
      user_id: user.id,
      base_currency: base,
      quote_currency: quote,
      rate: Number(body.rate),
      rate_date: body.date,
      source: "api" as const,
      created_at: timestamp,
      updated_at: timestamp
    } satisfies ExchangeRate;
  }));
  if (persist) await persistRates(fetched);
  return fetched;
}

export async function updateCachedData(userId: string, data: AppData) {
  await saveSnapshot({ userId, ...data, savedAt: now() });
}

````

## src/lib/demo.ts

<!-- source: src/lib/demo.ts sha256: ac5a16e029642a5ae95482a854f64bf3a0486627912c841995d882e4feef3924 encoding: utf8 -->
````typescript
import type { User } from "@supabase/supabase-js";
import type { AppData } from "./data";
import type { LifeRecord, Trip } from "../types";
import { mergeBundledReleaseNotes } from "./releaseNotes";
import { APP_VERSION } from "../version";

const KEY = "life-tracker-demo-data-v1";
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000130";
export const DEMO_USER = { id: DEMO_USER_ID, email: "demo@lifetracker.local", user_metadata: { display_name: "演示用户" }, app_metadata: {}, aud: "authenticated", created_at: new Date(0).toISOString() } as User;

function day(offset: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function timestamp(date: string, time: string) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function record(input: Partial<LifeRecord> & Pick<LifeRecord, "id" | "record_type" | "content" | "event_at">): LifeRecord {
  const created = new Date().toISOString();
  return {
    user_id: DEMO_USER_ID, notes: null, amount: null, currency: null, expense_category: null, location: null,
    trip_id: null, plan_status: null, sort_order: null, parent_plan_id: null, transport_type: null, transport_details: null,
    actual_match_status: "never", actual_info: null, actual_info_matched: false, actual_matched_at: null, actual_match_provider: null, actual_match_request_id: null,
    image_path: null, created_at: created, updated_at: created, ...input
  };
}

export function createDemoData(): AppData {
  const now = new Date().toISOString();
  const trip: Trip = {
    id: "10000000-0000-4000-8000-000000000130", user_id: DEMO_USER_ID, name: "东京慢游示例", destination: "东京",
    start_date: day(-1), end_date: day(2), timezone: "Asia/Tokyo", archived_at: null, created_at: now, updated_at: now
  };
  const flight = record({
    id: "20000000-0000-4000-8000-000000000130", record_type: "trip", content: "NH105 · LAX→HND", trip_id: trip.id, plan_status: "planned", sort_order: 0,
    event_at: timestamp(day(-1), "16:30"), transport_type: "flight",
    transport_details: {
      airline: "全日空 ANA", flight_number: "NH105",
      departure: { date: day(-2), time: "00:50", airport: "洛杉矶国际机场 (LAX)", iata: "LAX", terminal: "B", timezone: "America/Los_Angeles" },
      arrival: { date: day(-1), time: "05:00", airport: "东京羽田国际机场 (HND)", iata: "HND", terminal: "3", timezone: "Asia/Tokyo" },
      seat: "22A", notes: "演示航班可使用模拟数据体验匹配流程"
    }
  });
  const records = [
    flight,
    record({ id: "20000000-0000-4000-8000-000000000131", record_type: "trip", content: "浅草寺与隅田川散步", trip_id: trip.id, plan_status: "planned", sort_order: 1, event_at: timestamp(day(0), "09:30"), location: "浅草" }),
    record({ id: "20000000-0000-4000-8000-000000000132", record_type: "expense", content: "羽田机场咖啡", notes: "冷萃咖啡", amount: 1100, currency: "JPY", expense_category: "food", location: "羽田机场", trip_id: trip.id, event_at: timestamp(day(-1), "07:20") }),
    record({ id: "20000000-0000-4000-8000-000000000133", record_type: "note", content: "落地后第一眼看到的东京，天空比想象中更亮。", trip_id: trip.id, event_at: timestamp(day(-1), "06:10") })
  ];
  return {
    records,
    trips: [trip],
    rates: [],
    settings: { user_id: DEMO_USER_ID, base_currency: "JPY", theme: "system", created_at: now, updated_at: now },
    profile: { user_id: DEMO_USER_ID, display_name: "演示用户", avatar_url: null, avatar_color: "#0A84FF", has_seen_onboarding: true, last_seen_version: APP_VERSION, created_at: now, updated_at: now },
    changelogs: mergeBundledReleaseNotes([])
  };
}

export function loadDemoData() {
  try {
    const stored = localStorage.getItem(KEY);
    return stored ? JSON.parse(stored) as AppData : createDemoData();
  } catch {
    return createDemoData();
  }
}

export function saveDemoData(data: AppData) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function resetDemoData() {
  const data = createDemoData();
  saveDemoData(data);
  return data;
}

````

## src/lib/designTokens.ts

<!-- source: src/lib/designTokens.ts sha256: 02ce3c212fbf4ceca7d0c7ab7de701cea6a6aded8a820143cb9d32f0899d7570 encoding: utf8 -->
````typescript
/** Persisted avatar choices must remain byte-for-byte compatible with 1.4.1. */
export const AVATAR_COLORS = ["#0A84FF", "#1C1C1E", "#3A3A3C", "#636366", "#8E8E93", "#D1D1D6"];

/** Styling only; category keys, chart data and currency math are unchanged. */
export const CHART_COLORS = Array.from({ length: 6 }, (_, index) => `var(--chart-${index + 1})`);
export const CHART_TOOLTIP_STYLE = { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13 };

````

## src/lib/flightDisplay.ts

<!-- source: src/lib/flightDisplay.ts sha256: f263df5ab86591036dd92e317fa253403e100d363e5367f003900cb00aa9f85c encoding: utf8 -->
````typescript
import type { ActualFlightStop, FlightDetails, FlightStop, LifeRecord } from "../types";
import { normalizeAircraftType } from "./aircraftTypes";
import { flightMatchIsCurrent } from "./flightMatchState";
import { flightTimeOptions, isoUtcOffsetMinutes } from "./flightDuration";

export type FlightClockSource = "actual" | "estimated" | "scheduled" | "planned";
export const FLIGHT_CLOCK_LABELS: Record<FlightClockSource, string> = {
  actual: "实际", estimated: "预计（接口）", scheduled: "排定（接口）", planned: "计划值（接口未提供）"
};

export function flightStatusLabel(status: string) {
  return ({ landed: "已抵达", active: "飞行中", scheduled: "计划中", cancelled: "已取消", incident: "异常", diverted: "已备降" } as Record<string, string>)[status] || status || "已匹配";
}

function displayStop(plan: FlightStop, actual?: ActualFlightStop) {
  let source: FlightClockSource = "planned";
  if (actual) {
    source = (["actual", "estimated", "scheduled"] as const).find((key) => actual[key]?.date && actual[key]?.time) || "planned";
  }
  const clock = source !== "planned" && actual ? actual[source] : plan;
  const timezone = source === "planned" ? plan.timezone : actual?.timezone || plan.timezone;
  // Some provider clocks carry +00:00 alongside an airport-local timezone.
  // Treat the offset as proof only if it is valid for the displayed local clock;
  // a unique clock remains usable, but an ambiguous clock stays unresolved.
  const offset = source === "planned" ? plan.utc_offset_minutes : (() => {
    const value = isoUtcOffsetMinutes("iso" in clock ? clock.iso : null);
    if (value == null) return undefined;
    try { return flightTimeOptions({ date: clock.date, time: clock.time, timezone }).some(option => option.utcOffsetMinutes === value) ? value : undefined; }
    catch { return undefined; }
  })();
  return {
    source,
    stop: { ...plan, date: clock.date, time: clock.time, airport: actual?.airport || plan.airport, iata: actual?.iata || plan.iata, terminal: actual?.terminal || plan.terminal, timezone, utc_offset_minutes: offset }
  };
}

/** A derived view only: never overwrite the user's original plan with provider data. */
export function flightDisplay(record: LifeRecord) {
  if (record.transport_type !== "flight" || !record.transport_details) return null;
  const plan = record.transport_details as FlightDetails;
  const actual = flightMatchIsCurrent(record) ? record.actual_info : null;
  const departure = displayStop(plan.departure, actual?.departure);
  const arrival = displayStop(plan.arrival, actual?.arrival);
  const details: FlightDetails = {
    ...plan,
    airline: actual?.airline || plan.airline,
    flight_number: actual?.flight_number || plan.flight_number,
    departure: departure.stop,
    arrival: arrival.stop,
    gate: actual?.departure.gate || plan.gate,
    aircraft_type: normalizeAircraftType(actual?.aircraft_type || plan.aircraft_type || "") || undefined,
    registration: actual?.registration || plan.registration
  };
  const bothActual = departure.source === "actual" && arrival.source === "actual";
  const hasPlanClock = departure.source === "planned" || arrival.source === "planned";
  return {
    details, plan, actual, matched: Boolean(actual),
    departureSource: departure.source, arrivalSource: arrival.source,
    durationLabel: !actual ? "计划飞行时长" : bothActual ? "实际起降用时" : hasPlanClock ? "参考起降用时（含计划值）" : "匹配起降用时",
    durationDescription: !actual ? undefined : "按下方两地时间及其时区换算；接口缺失项使用标注的计划值。起降用时不等于纯空中飞行时间。"
  };
}

````

## src/lib/flightDuration.ts

<!-- source: src/lib/flightDuration.ts sha256: ce5042a42fea060c8adf4661cc0e7ca16013d3a59622a63de46b8e0b80996bde encoding: utf8 -->
````typescript
import type { FlightStop } from "../types";
import { FlightTimeError, resolveFlightInstant } from "../../supabase/functions/_shared/flightTime";
export { flightTimeOptions, resolveFlightInstant, utcOffsetLabel, isoUtcOffsetMinutes } from "../../supabase/functions/_shared/flightTime";

type FlightTime = Pick<FlightStop, "date" | "time" | "timezone" | "utc_offset_minutes">;
export type FlightDuration =
  | { status: "ready"; minutes: number; label: string }
  | { status: "incomplete" | "invalid"; message: string };

// Derived display only: never persists a duration or calls an external service.
export function calculateFlightDuration(departure: FlightTime, arrival: FlightTime): FlightDuration {
  if (![departure, arrival].every(stop => stop.date && stop.time && stop.timezone)) return { status: "incomplete", message: "填写起降日期、时间及当地时区后自动计算。" };
  try {
    const minutes = Math.round((resolveFlightInstant(arrival) - resolveFlightInstant(departure)) / 60_000);
    if (minutes <= 0) return { status: "invalid", message: "降落时间须晚于起飞时间，请检查日期和两地时区。" };
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return { status: "ready", minutes, label: [hours > 0 ? `${hours} 小时` : "", remainder > 0 ? `${remainder} 分钟` : ""].filter(Boolean).join(" ") };
  } catch (error) {
    if (error instanceof FlightTimeError) return { status: "invalid", message: error.message };
    return { status: "invalid", message: "无法计算时长，请检查日期、当地时间和时区（包括夏令时切换）。" };
  }
}

````

## src/lib/flightLookup.ts

<!-- source: src/lib/flightLookup.ts sha256: 37e1d25cd605ef9aa5f416b11aaa582803c766939d5274a6cad412b344a3a9fd encoding: utf8 -->
````typescript
import { supabase } from "./supabase";
import type { ActualFlightInfo, FlightDetails, LifeRecord } from "../types";
import { edgeFunctionMessage } from "./functionError";
import { normalizeAircraftType } from "./aircraftTypes";
import { flightPlanKey } from "./flightMatchState";
import { calculateFlightDuration, flightTimeOptions, resolveFlightInstant, utcOffsetLabel } from "./flightDuration";

export interface FlightMatchPreview {
  preview: ActualFlightInfo;
  requestId: string;
  planVersion: number;
  planKey: string;
  recoveryToken?: string;
  expiresAt?: string;
  warning?: string;
  record?: LifeRecord;
  cached?: boolean;
}

export const FLIGHT_LOOKUP_ERROR = "暂时无法获取航班信息，原计划不会被修改。";

function normalizeActualInfo(info: ActualFlightInfo): ActualFlightInfo {
  return { ...info, aircraft_type: normalizeAircraftType(info.aircraft_type) };
}

export function flightMatchEligibility(record: LifeRecord, now = Date.now()) {
  if (record.transport_type !== "flight" || !record.transport_details) return { eligible: false, reason: "这不是航班计划。" };
  if (record.plan_status === "cancelled") return { eligible: false, reason: "这条航班计划已取消。恢复为计划中后才能匹配实际信息；手动记录不受影响。" };
  const flight = record.transport_details as FlightDetails;
  if (!/^[A-Z]{3}$/.test(flight.departure.iata || "") || !/^[A-Z]{3}$/.test(flight.arrival.iata || "")) return { eligible: false, reason: "这是手动机场记录。若要匹配实际航班，请先从补全列表选择正确的起降机场；基础计划不受影响。" };
  if (!flight.arrival.date || !flight.arrival.time || !flight.arrival.timezone) return { eligible: false, reason: "请先完整填写计划到达日期、时间和时区。" };
  const duration = calculateFlightDuration(flight.departure, flight.arrival);
  if (duration.status !== "ready") return { eligible: false, reason: duration.message };
  try {
    const arrival = resolveFlightInstant(flight.arrival);
    const starts = arrival + 60 * 60 * 1000;
    const ends = arrival + 48 * 60 * 60 * 1000;
    if (now < starts) return { eligible: false, reason: "该航班尚未进入实际信息匹配范围。请先保留计划信息；航班结束约一小时后，可回来匹配实际飞行数据。", eligibleAt: new Date(starts).toISOString() };
    if (now > ends) return { eligible: false, reason: "该航班已超过自动匹配时间范围，你仍可手动补充实际信息。" };
    return { eligible: true, reason: "可以匹配实际飞行信息。", eligibleAt: new Date(starts).toISOString() };
  } catch {
    return { eligible: false, reason: "到达时区无效，请重新选择。" };
  }
}

export async function matchFlightActual(record: LifeRecord, rematch = false) {
  const eligibility = flightMatchEligibility(record);
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (record.flight_plan_version == null) throw new Error("请先将这条航班计划同步到云端，再匹配实际信息。当前不会调用航班接口。");
  const planVersion = record.flight_plan_version;
  const planKey = flightPlanKey(record);
  const { data: session } = await supabase.auth.getSession();
  const storageKey = session.session?.user.id ? `life-tracker-flight-preview:${session.session.user.id}:${record.id}` : null;
  if (!rematch && storageKey) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as { expiresAt?: number; value?: FlightMatchPreview } | null;
      if (saved?.expiresAt && saved.expiresAt > Date.now() && saved.value?.planKey === planKey && saved.value.planVersion === planVersion) return saved.value;
    } catch { /* An unavailable local cache never blocks ordinary matching. */ }
  }
  const requestId = crypto.randomUUID();
  const { data, error } = await supabase.functions.invoke("lookup-flight", { body: { action: "match", recordId: record.id, requestId, planVersion, rematch } });
  if (error) throw new Error(await edgeFunctionMessage(error, FLIGHT_LOOKUP_ERROR));
  if (data?.error) throw new Error(data.error.message || FLIGHT_LOOKUP_ERROR);
  if (data?.data?.cached) return { preview: normalizeActualInfo(data.data.actualInfo as ActualFlightInfo), requestId: data.data.requestId || requestId, planVersion, planKey, record: data.data.record as LifeRecord, cached: true };
  if (!data?.data?.preview || !data?.data?.requestId) throw new Error(FLIGHT_LOOKUP_ERROR);
  const value: FlightMatchPreview = { preview: normalizeActualInfo(data.data.preview as ActualFlightInfo), requestId: data.data.requestId as string, planVersion, planKey, recoveryToken: data.data.recoveryToken, expiresAt: data.data.expiresAt, warning: data.data.warning, cached: false };
  if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify({ expiresAt: Math.min(Date.now() + 29 * 60_000, Date.parse(value.expiresAt || "") || 0), value })); } catch { /* The in-memory preview remains usable. */ } }
  return value;
}

export async function confirmFlightActual(recordId: string, requestId: string, planVersion: number, recoveryToken?: string) {
  const { data, error } = await supabase.functions.invoke("lookup-flight", { body: { action: "confirm", recordId, requestId, planVersion, recoveryToken } });
  if (error) throw new Error(await edgeFunctionMessage(error, "实际飞行信息保存失败，请重试。"));
  if (data?.error) throw new Error(data.error.message || "实际飞行信息保存失败，请重试。");
  const record = data.data.record as LifeRecord;
  return record.actual_info ? { ...record, actual_info: normalizeActualInfo(record.actual_info) } : record;
}

export function demoFlightPreview(record: LifeRecord): FlightMatchPreview {
  const flight = record.transport_details as FlightDetails;
  const departureScheduled = demoClock(flight.departure);
  const arrivalScheduled = demoClock(flight.arrival);
  const departureActual = demoClock(flight.departure, 8);
  const arrivalActual = demoClock(flight.arrival, 4);
  const preview: ActualFlightInfo = {
    status: "landed",
    airline: flight.airline || "示例航空",
    flight_number: flight.flight_number || "LT130",
    departure: {
      airport: flight.departure.airport, iata: flight.departure.iata || "HND", timezone: flight.departure.timezone || "Asia/Tokyo",
      scheduled: departureScheduled,
      estimated: departureScheduled,
      actual: departureActual, delay_minutes: 8, terminal: flight.departure.terminal || "2", gate: flight.gate || "62"
    },
    arrival: {
      airport: flight.arrival.airport, iata: flight.arrival.iata || "HND", timezone: flight.arrival.timezone || "Asia/Tokyo",
      scheduled: arrivalScheduled,
      estimated: arrivalActual,
      actual: arrivalActual, delay_minutes: 4, terminal: flight.arrival.terminal || "3", gate: "108"
    },
    aircraft_type: normalizeAircraftType(flight.aircraft_type || "B789"),
    registration: flight.registration || "JA-demo",
    source: "aviationstack",
    matched_at: new Date().toISOString()
  };
  return { preview, requestId: `demo-${crypto.randomUUID()}`, planVersion: record.flight_plan_version ?? 1, planKey: flightPlanKey(record) };
}

function demoClock(stop: FlightDetails["departure"], delay = 0) {
  const instant = resolveFlightInstant(stop) + delay * 60_000;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: stop.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`, time = `${get("hour")}:${get("minute")}`;
  const offset = flightTimeOptions({ date, time, timezone: stop.timezone }).find(option => option.instant === instant)!.utcOffsetMinutes;
  return { date, time, iso: `${date}T${time}:00${utcOffsetLabel(offset).slice(3)}` };
}

````

## src/lib/flightMatchState.ts

<!-- source: src/lib/flightMatchState.ts sha256: 074cac92c024e4b44dfa89d2ca13d33ab30342e9c99016184c5a57549aceebb9 encoding: utf8 -->
````typescript
import type { FlightDetails, LifeRecord } from "../types";

// A match belongs to a segment, not to its mutable record UUID alone.
export function flightPlanKey(record: Pick<LifeRecord, "transport_type" | "transport_details">) {
  if (record.transport_type !== "flight" || !record.transport_details) return "";
  const flight = record.transport_details as FlightDetails;
  return JSON.stringify([
    flight.flight_number.replace(/\s/g, "").toUpperCase(),
    ...[flight.departure, flight.arrival].flatMap(stop => [
      (stop.iata || "").trim().toUpperCase(), stop.date, stop.time, stop.timezone || "", stop.utc_offset_minutes ?? null
    ])
  ]);
}

export function invalidateChangedFlight(previous: LifeRecord, next: LifeRecord): LifeRecord {
  if (flightPlanKey(previous) === flightPlanKey(next)) return next;
  return { ...next, actual_match_status: "never", actual_info_matched: false,
    actual_matched_at: null, actual_match_provider: null, actual_match_request_id: null,
    actual_match_plan_version: null, actual_confirmed_request_id: null, flight_plan_version: (previous.flight_plan_version ?? (previous.transport_type === "flight" ? 1 : 0)) + 1 };
}

export function flightMatchIsCurrent(record: LifeRecord) {
  if (!record.actual_info_matched || !record.actual_info || record.transport_type !== "flight" || !record.transport_details) return false;
  if (record.flight_plan_version != null) return record.actual_match_plan_version === record.flight_plan_version;
  const plan = record.transport_details as FlightDetails;
  const actual = record.actual_info;
  return actual.flight_number.replace(/\s/g, "").toUpperCase() === plan.flight_number.replace(/\s/g, "").toUpperCase()
    && actual.departure.iata === plan.departure.iata && actual.arrival.iata === plan.arrival.iata
    && (!actual.departure.scheduled.date || actual.departure.scheduled.date === plan.departure.date);
}

````

## src/lib/flightTripPlacement.ts

<!-- source: src/lib/flightTripPlacement.ts sha256: 5ef207e43c3838c007e70994f76fcb88a74ca4ebb9a8193fc53a00acf72ab79c encoding: utf8 -->
````typescript
import type { FlightDetails, Trip } from "../types";
import { calculateFlightDuration, resolveFlightInstant } from "./flightDuration";
import { dateInZone } from "./tripDates";

type TripWindow = Pick<Trip, "start_date" | "end_date" | "timezone">;

// A flight belongs to any trip day its time interval overlaps, in the trip's
// timezone. Display it once, on departure day or the first overlapping trip day.
export function flightTripPlacement(flight: FlightDetails, trip: TripWindow) {
  const fallback = { day: flight.departure.date, departureDay: flight.departure.date, arrivalDay: flight.arrival.date, overlapsTrip: flight.departure.date >= trip.start_date && flight.departure.date <= trip.end_date, startsBeforeTrip: false };
  const departure = { ...flight.departure, timezone: flight.departure.timezone || trip.timezone };
  const arrival = { ...flight.arrival, timezone: flight.arrival.timezone || trip.timezone };
  if (calculateFlightDuration(departure, arrival).status !== "ready") return fallback;
  try {
    const departureDay = dateInZone(new Date(resolveFlightInstant(departure)).toISOString(), trip.timezone);
    const arrivalDay = dateInZone(new Date(resolveFlightInstant(arrival)).toISOString(), trip.timezone);
    const overlapsTrip = departureDay <= trip.end_date && arrivalDay >= trip.start_date;
    const startsBeforeTrip = overlapsTrip && departureDay < trip.start_date;
    return { day: startsBeforeTrip ? trip.start_date : departureDay, departureDay, arrivalDay, overlapsTrip, startsBeforeTrip };
  } catch {
    return fallback;
  }
}

// Reordering within the displayed day must never rewrite the actual departure
// date. Moving to another day aligns departure to that trip-timezone day.
export function flightMoveOffset(flight: FlightDetails, trip: TripWindow, targetDay: string) {
  const placement = flightTripPlacement(flight, trip);
  if (targetDay === placement.day) return 0;
  return Math.round((Date.parse(`${targetDay}T12:00:00Z`) - Date.parse(`${placement.departureDay}T12:00:00Z`)) / 86_400_000);
}

````

## src/lib/functionError.ts

<!-- source: src/lib/functionError.ts sha256: b03dd99fef23b402415d5d74c440578e6caa3590f8d45a51bd2c66b31d9340dc encoding: utf8 -->
````typescript
export async function edgeFunctionMessage(error: unknown, fallback: string) {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.clone === "function") {
    try {
      const body = await context.clone().json() as { error?: { message?: unknown } };
      if (typeof body?.error?.message === "string" && body.error.message.trim()) return body.error.message.trim();
    } catch {
      // Keep the user-facing fallback for non-JSON upstream failures.
    }
  }
  return fallback;
}


````

## src/lib/offline.ts

<!-- source: src/lib/offline.ts sha256: 1775820979e518d1a3ec1b7018cd568d677969e9bf8c77545cc105cb1b3600d9 encoding: utf8 -->
````typescript
import { openDB, type DBSchema } from "idb";
import type { Changelog, ExchangeRate, LifeRecord, Trip, UserProfile, UserSettings } from "../types";

export interface Snapshot {
  userId: string;
  records: LifeRecord[];
  trips: Trip[];
  rates: ExchangeRate[];
  settings: UserSettings;
  profile: UserProfile;
  changelogs: Changelog[];
  savedAt: string;
}

export interface PendingMutation {
  id: string;
  ownerId: string;
  entityId: string;
  table: "records" | "trips" | "user_settings" | "exchange_rates" | "profiles";
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
  expectedUpdatedAt: string | null;
  dependsOn: string | null;
  // Foreign-entity prerequisites never supply this entity's CAS version.
  relationDependencies?: string[];
  // Undefined in older queues is conservatively treated as possibly sent.
  attempted?: boolean;
  replacesFailed?: string[];
  supersededBy?: string;
  state: "pending" | "inflight" | "failed" | "conflict";
  legacy?: boolean;
  error?: string;
  lockedUntil?: number;
  createdAt: string;
}

interface LifeTrackerDB extends DBSchema {
  snapshots: {
    key: string;
    value: Snapshot;
  };
  outbox: {
    key: string;
    value: PendingMutation;
    indexes: { "by-created": string; "by-owner": string };
  };
  automaticSummaries: { key: string; value: { key: string; ownerId: string; attemptedAt: number; result?: string } };
}

export const OUTBOX_CHANGED = "life-tracker-outbox-changed";
const notify = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(OUTBOX_CHANGED)); };
const dbPromise = openDB<LifeTrackerDB>("life-tracker", 3, {
  upgrade(db, oldVersion, _newVersion, transaction) {
    if (oldVersion === 0) {
      db.createObjectStore("snapshots", { keyPath: "userId" });
      const outbox = db.createObjectStore("outbox", { keyPath: "id" });
      outbox.createIndex("by-created", "createdAt");
    }
    const outbox = transaction.objectStore("outbox");
    if (!outbox.indexNames.contains("by-owner")) outbox.createIndex("by-owner", "ownerId");
    if (!db.objectStoreNames.contains("automaticSummaries")) db.createObjectStore("automaticSummaries", { keyPath: "key" });
    if (oldVersion === 1) void (async () => {
      let cursor = await outbox.openCursor();
      while (cursor) {
        const value = cursor.value;
        await cursor.update({ ...value, ownerId: String(value.payload.user_id || ""), entityId: String(value.payload.id || value.payload.user_id || ""), expectedUpdatedAt: null, dependsOn: null, state: "failed", legacy: true, error: "旧版待同步副本已保留，请导出核对后手动恢复，避免覆盖云端新内容。" });
        cursor = await cursor.continue();
      }
    })();
  }
});

export async function loadSnapshot(userId: string) {
  return (await dbPromise).get("snapshots", userId);
}

export async function saveSnapshot(snapshot: Snapshot) {
  return (await dbPromise).put("snapshots", snapshot);
}

// Atomic across windows and durable across reload/foreground transitions.
// A failed/unknown automatic result is never regenerated by the clock timer.
export async function claimAutomaticSummary(ownerId: string, context: string) {
  if (!ownerId || !context) return false;
  const tx = (await dbPromise).transaction("automaticSummaries", "readwrite");
  const key = JSON.stringify([ownerId, context]);
  if (await tx.store.get(key)) { await tx.done; return false; }
  await tx.store.put({ key, ownerId, attemptedAt: Date.now() });
  for (const old of await tx.store.getAll()) if (old.key !== key && old.attemptedAt < Date.now() - 30 * 86_400_000) await tx.store.delete(old.key);
  await tx.done;
  return true;
}

export async function loadAutomaticSummary(ownerId: string, context: string) {
  return (await (await dbPromise).get("automaticSummaries", JSON.stringify([ownerId, context])))?.result;
}

export async function saveAutomaticSummary(ownerId: string, context: string, result: string) {
  if (!ownerId || !context || !result) return;
  const key = JSON.stringify([ownerId, context]);
  const tx = (await dbPromise).transaction("automaticSummaries", "readwrite");
  const previous = await tx.store.get(key);
  await tx.store.put({ key, ownerId, attemptedAt: previous?.attemptedAt || Date.now(), result });
  await tx.done;
}

function relationParents(item: Pick<PendingMutation, "table" | "payload" | "id">, items: PendingMutation[]) {
  if (item.table !== "records") return [];
  return items.filter((parent) => parent.id !== item.id && !parent.legacy && !parent.supersededBy && (
    (parent.table === "trips" && parent.entityId === item.payload.trip_id) ||
    (parent.table === "records" && parent.entityId === item.payload.parent_plan_id)
  )).map((parent) => parent.id);
}

function dependencies(item: PendingMutation, items: PendingMutation[]) {
  return [...new Set([item.dependsOn, ...(item.relationDependencies || []), ...relationParents(item, items)].filter((id): id is string => Boolean(id)))];
}

export async function queueMutation(mutation: Pick<PendingMutation, "ownerId" | "table" | "operation" | "payload" | "expectedUpdatedAt">) {
  if (mutation.payload.user_id !== mutation.ownerId) throw new Error("不能为其他账号保存数据");
  const db = await dbPromise;
  const tx = db.transaction("outbox", "readwrite");
  const entityId = String(mutation.payload.id || mutation.payload.user_id);
  const all = await tx.store.index("by-owner").getAll(mutation.ownerId);
  const existing = all.filter((item) => !item.legacy && !item.supersededBy && item.table === mutation.table && item.entityId === entityId);
  const parents = new Set(existing.map((item) => item.dependsOn).filter(Boolean));
  const leaves = existing.filter((item) => !parents.has(item.id) && (item.state === "pending" || item.state === "inflight")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // A referenced parent is durable until it confirms, even if edited again.
  const pending = leaves.find((item) => item.state === "pending" && item.attempted === false && !all.some((child) => !child.supersededBy && child.id !== item.id && dependencies(child, all).includes(item.id)));
  const predecessor = leaves[0];
  const conflict = existing.filter(item => item.state === "conflict").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const failed = !predecessor ? existing.filter(item => item.state === "failed").sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  // An unsent successor may have been queued while its ancestor was inflight.
  // Once that ancestor rejects, a correction must bypass the rejected chain,
  // while preserving any possibly-sent request for receipt recovery.
  const bypassed: PendingMutation[] = [];
  let ancestor = pending?.dependsOn;
  while (ancestor) {
    const prior = existing.find(item => item.id === ancestor);
    if (!prior || bypassed.some(item => item.id === prior.id) || !(prior.state === "failed" || (prior.state === "pending" && prior.attempted === false))) break;
    bypassed.push(prior); ancestor = prior.dependsOn;
  }
  const rejectedAncestor = bypassed.some(item => item.state === "failed") ? bypassed.at(-1) : undefined;
  const latestTime = all.map(item => Date.parse(item.createdAt)).filter(Number.isFinite).reduce((latest, time) => Math.max(latest, time), 0);
  const item: PendingMutation = {
    ...mutation,
    entityId,
    id: crypto.randomUUID(),
    createdAt: new Date(Math.max(Date.now(), latestTime + 1)).toISOString(),
    expectedUpdatedAt: rejectedAncestor ? rejectedAncestor.expectedUpdatedAt : pending ? pending.expectedUpdatedAt : failed[0] ? failed[0].expectedUpdatedAt : mutation.expectedUpdatedAt,
    dependsOn: rejectedAncestor ? rejectedAncestor.dependsOn : pending ? pending.dependsOn : predecessor?.id || conflict?.id || failed[0]?.dependsOn || null,
    replacesFailed: [...new Set([...(pending?.replacesFailed || failed.map(item => item.id)), ...(rejectedAncestor ? bypassed.flatMap(item => [item.id, ...(item.replacesFailed || [])]) : [])])],
    attempted: false,
    state: "pending"
  };
  item.relationDependencies = relationParents(item, all);
  if (pending) await tx.store.delete(pending.id);
  await tx.store.put(item);
  await tx.done;
  notify();
  return item;
}

export async function listMutations(ownerId: string) {
  const items = (await (await dbPromise).getAllFromIndex("outbox", "by-owner", ownerId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(items.map((item) => [item.id, item]));
  const visited = new Set<string>(), visiting = new Set<string>(), ordered: PendingMutation[] = [];
  const visit = (item: PendingMutation) => {
    if (visited.has(item.id) || visiting.has(item.id)) return;
    visiting.add(item.id);
    for (const id of dependencies(item, items)) { const parent = byId.get(id); if (parent) visit(parent); }
    visiting.delete(item.id); visited.add(item.id); ordered.push(item);
  };
  for (const item of items) visit(item);
  return ordered;
}

export async function claimMutation(id: string, ownerId: string) {
  const tx = (await dbPromise).transaction("outbox", "readwrite");
  const item = await tx.store.get(id);
  if (!item || item.ownerId !== ownerId || item.supersededBy || item.dependsOn || item.state === "failed" || item.state === "conflict" || (item.lockedUntil || 0) > Date.now()) return null;
  const items = await tx.store.index("by-owner").getAll(ownerId);
  // Re-derive relations for pre-fix persisted entries and later parent edits.
  if (dependencies(item, items).some((dependency) => items.some((parent) => parent.id === dependency))) return null;
  const claimed: PendingMutation = { ...item, attempted: true, state: "inflight", lockedUntil: Date.now() + 120_000 };
  await tx.store.put(claimed); await tx.done; notify(); return claimed;
}

export async function finishMutation(item: PendingMutation, row: Record<string, unknown>) {
  const tx = (await dbPromise).transaction("outbox", "readwrite");
  const children = await tx.store.index("by-owner").getAll(item.ownerId);
  const replaced = new Set((item.replacesFailed || []).filter(id => children.some(old => old.id === id && old.table === item.table && old.entityId === item.entityId && (old.state === "failed" || old.state === "conflict" || (old.state === "pending" && old.attempted === false)) && !old.legacy)));
  for (const child of children) {
    if (replaced.has(child.id)) { await tx.store.put({ ...child, supersededBy: item.id }); continue; }
    const released = child.dependsOn === item.id || replaced.has(child.dependsOn || "");
    const sameEntity = released && child.table === item.table && child.entityId === item.entityId;
    const relations = (child.relationDependencies || []).filter((id) => id !== item.id && !replaced.has(id));
    if (released || relations.length !== (child.relationDependencies || []).length) await tx.store.put({
      ...child, relationDependencies: relations,
      ...(sameEntity ? { dependsOn: null, expectedUpdatedAt: String(row.updated_at) } : released ? { dependsOn: null } : {})
    });
  }
  await tx.store.delete(item.id); await tx.done; notify();
}

export async function failMutation(item: PendingMutation, state: PendingMutation["state"], error: string) {
  const tx = (await dbPromise).transaction("outbox", "readwrite");
  const current = await tx.store.get(item.id);
  if (current && current.ownerId === item.ownerId && current.lockedUntil === item.lockedUntil) await tx.store.put({ ...current, state, error, lockedUntil: undefined });
  await tx.done;
  notify();
}

export async function retryFailedMutations(ownerId: string) {
  const tx = (await dbPromise).transaction("outbox", "readwrite");
  const items = await tx.store.index("by-owner").getAll(ownerId);
  for (const item of items) if (item.state === "failed" && !item.legacy && !item.supersededBy && !items.some(next => !next.supersededBy && next.replacesFailed?.includes(item.id))) await tx.store.put({ ...item, state: "pending", error: undefined, lockedUntil: undefined });
  await tx.done;
  notify();
}

// Explicit reconciliation only. The dialog passes the exact versions inspected;
// a concurrent edit or an unknown inflight outcome requires another review.
export async function reconcileMutations(inspected: PendingMutation[], cloud: Record<string, unknown> | null, choice: "cloud" | "local") {
  const first = inspected[0];
  if (!first) throw new Error("没有待处理的冲突");
  const tx = (await dbPromise).transaction("outbox", "readwrite");
  const all = await tx.store.index("by-owner").getAll(first.ownerId);
  const active = all.filter(item => !item.supersededBy && item.table === first.table && item.entityId === first.entityId);
  if (active.length !== inspected.length || active.some(item => !inspected.some(old => JSON.stringify(old) === JSON.stringify(item)))) throw new Error("本地副本已变化，请重新查看冲突");
  if (active.some(item => item.legacy || item.state === "inflight" || (item.state === "pending" && item.attempted !== false))) throw new Error("仍有未确认的保存，请先重试同步，再处理冲突");
  const latest = [...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
  const ids = new Set(active.map(item => item.id));
  const id = crypto.randomUUID();
  if (choice === "local") {
    const item: PendingMutation = { ...latest, id, payload: { ...latest.payload }, expectedUpdatedAt: typeof cloud?.updated_at === "string" ? cloud.updated_at : null, dependsOn: null, relationDependencies: relationParents(latest, all).filter(id => !ids.has(id)), replacesFailed: [...ids], attempted: false, state: "pending", error: undefined, lockedUntil: undefined, createdAt: new Date(Math.max(Date.now(), ...all.map(item => Date.parse(item.createdAt) + 1))).toISOString() };
    await tx.store.put(item); await tx.done; notify(); return item;
  }
  if (!cloud && all.some(item => !ids.has(item.id) && !item.supersededBy && dependencies(item, all).some(id => ids.has(id)))) throw new Error("云端记录已删除且本机仍有依赖记录，请先导出并处理依赖记录");
  for (const item of all) {
    if (ids.has(item.id)) await tx.store.put({ ...item, supersededBy: id });
    else if (dependencies(item, all).some(id => ids.has(id))) await tx.store.put({ ...item, dependsOn: ids.has(item.dependsOn || "") ? null : item.dependsOn, relationDependencies: (item.relationDependencies || []).filter(id => !ids.has(id)) });
  }
  await tx.done; notify(); return null;
}

````

## src/lib/releaseNotes.ts

<!-- source: src/lib/releaseNotes.ts sha256: 4f1f4f21752aa141c2598cd4db7c26a6a938cc5f570073e19f8c2ab58e703e9b encoding: utf8 -->
````typescript
import type { Changelog } from "../types";

const RELEASE_1_2_0_SUMMARY = [
  "行程规划新增飞机、铁路和市内交通三类结构化模板。飞机可记录航司、航班号、出发与到达日期时间、机场、航站楼、登机口、座位和机型；铁路可记录铁路系统、车次、车站与座席；市内交通可记录起终点、预计时间和路线说明。",
  "交通计划拥有更清晰的智能摘要：时间线会自动提炼航班号、车次、站点与时间；保存后仍可快速更新登机口，也可以在抵达后补记实际乘车路线。",
  "DeepSeek API 配置完成后，可在“行程规划 → 市内交通”中填写起点、终点和预计时间，再点击“AI 查询路线”。检查并编辑返回的线路、换乘、预计用时与票价参考后，点击“填入路线”并保存；AI 结果不会自动写入记录，查询不可用时仍可手动填写。",
  "设置页新增永久“使用说明”，并新增长期保留的致谢栏目。",
  "优化 iPhone 17 Pro 灵动岛安全区域、桌面 PWA 显示与部分移动端交互。"
];

const RELEASE_1_2_1_SUMMARY = [
  "飞机模板新增 Aviationstack 实时航班查询：输入 IATA 航班号并主动点击查询，可核对候选航班的日期、机场、航站楼、登机口、机型和状态，再确认填入；每次点击只消耗 1 次接口额度。",
  "航班的起飞与降落信息分别保存当地时区。例如从洛杉矶飞往东京时，可同时保留 America/Los_Angeles 和 Asia/Tokyo，卡片始终显示机场当地日期与时间。",
  "创建行程时会根据目的地自动匹配行程时区，并提供标准 IANA 时区列表供手动调整。",
  "所有非必填输入项现已明确标注“选填”，减少填写时的疑惑。"
];

const RELEASE_1_3_0_SUMMARY = [
  "新增 Standard、Friend、Owner 与本地演示四种模式。普通账号可在设置中兑换朋友邀请码；Owner 由服务端绑定 Auth UUID。设置页会显示智能服务权限、共享额度池和冷却状态，记录与手动规划始终不受额度影响。",
  "航班改为先手动填写计划信息，未来航班不会调用接口。计划到达约一小时后至 48 小时内，可主动匹配实际飞行信息；系统按到达机场 IANA 时区换算，严格核对航班号、日期和起降机场，并在计划/实际对比确认后保存。匹配结果会缓存，打开页面不会自动查询。",
  "新增常用机场离线补全，可用中文、英文、城市、IATA、拼音或常见别名搜索，并自动填写标准机场名、代码和当地时区。",
  "新增 AI 轻量助手：公共交通路线查询、自然语言记账解析和随记润色共用每日额度。所有结果都先预览、后确认，不会自动写入记录。",
  "新增旅行回顾与消费洞察、今日计划摘要。旅行回顾先在服务端聚合消费、地点和少量抽样随记，避免发送整段原始行程；生成内容与每日摘要都会缓存，重新生成会明确提示再次消耗额度。",
  "新增可重置演示模式：记录与规划只保存在当前设备；航班用模拟数据展示完整匹配流程，DeepSeek 每台设备每天可体验 2 次，不接触真实用户数据，也不支持图片上传。",
  "行程计划统一按时间先后排列，拖动跨日会更新日期；行程列表按进行中、未来、过去排序。已有行程和日程均可再次编辑，缩短日期时会列明并保留超出范围的计划。",
  "智能服务新增原子配额、共享额度池、频率冷却、邀请码防暴力尝试、请求幂等和航班并发锁；同时优化移动端安全区域、选填标识与使用说明。"
];

const RELEASE_1_4_0_SUMMARY = [
  "登录方式升级为 6 位邮箱验证码。输入邮箱后，将邮件中的数字验证码直接填回 Life Tracker 即可完成登录，不再需要点击 Magic Link，也不会从主屏幕 PWA 跳转到 Safari；App 从后台回到前台时还会主动复查登录状态。",
  "首页新增“AI 路线查询”快捷入口，无需先创建行程即可输入任意起点和终点，获取包含推荐交通方式、大致耗时、费用与关键换乘信息的路线建议。它与现有 AI 助手共用 DeepSeek 服务、账号权限和额度规则，不会绕过任何频率或总量限制。",
  "路线查询可以理解机场、学校、车站和常见地点的口语化名称。地点存在歧义时，AI 会先请你补充城市、校区或具体机场，不会猜测并生成错误路线；结果仅供查看时可直接关闭，也可选择日期和时间后保存到进行中或未来行程。",
  "航班机型栏新增离线自动补全与格式统一：例如 78X、B78X、B787-10、787-1000 都会识别为 787-10，77W 会识别为 777-300ER。手动填写、航班 API 返回和已有记录都会使用同一套机型归一化规则，未知型号则保留原文。",
  "优化首页快捷操作布局、验证码输入体验、移动端弹窗与机型候选交互；本次更新没有修改数据库表结构，已有记录、行程、权限与额度数据无需迁移。"
];

const RELEASE_1_4_1_SUMMARY = [
  "新增仅 Owner 可见的账号管理后台。可以按邮箱查找用户、查看注册与最近登录时间、本月航班及 AI 使用概况，并在 Standard 与 Friend 权限之间调整；Owner 身份不可修改，所有权限变更都会记录操作者、目标账号、修改前后等级和时间。后台不会读取用户的消费、行程、随记或图片内容。",
  "重构航班月度额度：服务商 100 次额度现在是所有账号的总池，非 Owner 账号仍共同使用最多 80 次。Owner 不再固定为 20 次，而是可以使用总池中尚未消耗的全部额度；其他用户没有使用的部分不会闲置，同时仍为 Owner 保留至少 20 次可用空间。",
  "修正 Owner 智能服务权限。轻量 AI 的 200 次参考值和旅行回顾的 50 次参考值不再被误当作硬限制，设置页改为直接显示 AI 不设账号额度，并展示航班总池剩余量、Owner 已用量与其他用户共享池用量。",
  "“隐私与数据”现可点击查看，说明账号级行级安全隔离、外部 API 密钥仅保存在服务端、Owner 后台的可见范围，以及邮箱验证码与登录会话由 Supabase Auth 管理。",
  "修复更换头像时可能出现的 row-level security policy 错误，并优化 Owner 后台、移动端弹窗与额度信息的展示。"
];

const BUNDLED_RELEASES: Changelog[] = [
  { id: "bundled-2.0.0", version: "2.0.0", summary: [
    "全站界面焕新，统一字体、间距与按钮样式，让记录和行程信息更清晰。",
    "深色模式采用纯黑背景，浅色模式保留简洁白色卡片，减少装饰与干扰。",
    "飞机模板新增自动计算飞行时长，按起降两地时区处理跨日与时差，不消耗 API 额度。前一天出发、首日抵达的航班会按与旅行日期的重叠归入计划，仍保留真实当地日期。实际匹配成功后优先展示匹配时间、机型、登机口与状态；缺失项明确标注计划值，原计划可展开查看。航班、铁路等交通记录完成后不再划掉标题，保留可读详情和完成标识。",
    "新增全天事项与跨日酒店住宿模板，可填写日期范围、酒店地址、入住/退房时间及预订号。每天的“全天与住宿”区会展示连住情况，换酒店当天分别展示旧酒店退房与新酒店入住；退房日不重复计算住宿夜晚，日期重叠会提醒核对。跨日只保存一条记录，编辑或撤回完成会同步到各天。优化手机表单、导航和消费图表，原有数据与账号权限保持不变。",
    "时间线新增“撤回完成”“恢复计划”和直接编辑入口，演示及日期范围外的计划也可编辑。航司补全扩充至 114 家，支持中文、英文、简称和 IATA 代码搜索；选定航司后自动补全代码，只需填写航班号数字部分，也可粘贴完整航班号。",
    "完善账号隔离、云端保存确认与冲突保护，支持查看和导出本机待处理副本；AI 或航班结果保存失败可只重试保存，不重复查询。优化跨时区摘要、多币种回顾、时间线排序及并发频率保护，既有额度规则不变。"
  ], created_at: "2026-09-30T12:00:00.000Z" },
  { id: "bundled-1.4.1", version: "1.4.1", summary: RELEASE_1_4_1_SUMMARY, created_at: "2026-07-15T04:00:00.000Z" },
  { id: "bundled-1.4.0", version: "1.4.0", summary: RELEASE_1_4_0_SUMMARY, created_at: "2026-07-14T12:00:00.000Z" },
  { id: "bundled-1.3.0", version: "1.3.0", summary: RELEASE_1_3_0_SUMMARY, created_at: "2026-07-14T11:00:00.000Z" },
  { id: "bundled-1.2.1", version: "1.2.1", summary: RELEASE_1_2_1_SUMMARY, created_at: "2026-07-14T09:30:00.000Z" },
  { id: "bundled-1.2.0", version: "1.2.0", summary: RELEASE_1_2_0_SUMMARY, created_at: "2026-07-14T08:00:00.000Z" }
];

export function mergeBundledReleaseNotes(changelogs: Changelog[]) {
  const bundledVersions = new Set(BUNDLED_RELEASES.map((release) => release.version));
  return [
    ...BUNDLED_RELEASES.map((bundled) => {
      const remote = changelogs.find((release) => release.version === bundled.version);
      return remote ? { ...remote, summary: bundled.summary } : bundled;
    }),
    ...changelogs.filter((release) => !bundledVersions.has(release.version))
  ];
}

````

## src/lib/schedules.ts

<!-- source: src/lib/schedules.ts sha256: 9f6e41543b4f7452f929fec0021f0780538049f994decc605b02c1c4aecf63d4 encoding: utf8 -->
````typescript
import type { LifeRecord, ScheduleDetails, Trip } from "../types";

export type SchedulePhase = "all_day" | "check_in" | "staying" | "check_out";
export interface ScheduleDayEntry { record: LifeRecord; details: ScheduleDetails; phase: SchedulePhase }

export function validScheduleDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function shiftScheduleDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function scheduleNights(details: ScheduleDetails) {
  return Math.round((Date.parse(`${details.end_date}T12:00:00Z`) - Date.parse(`${details.start_date}T12:00:00Z`)) / 86_400_000);
}

export function scheduleValidation(details: ScheduleDetails) {
  if (!validScheduleDate(details.start_date) || !validScheduleDate(details.end_date)) return "请填写有效的开始和结束日期";
  if (details.kind === "hotel" && details.end_date <= details.start_date) return "退房日期应晚于入住日期；当天的短时安排请使用全天事项";
  if (details.kind === "all_day" && details.end_date < details.start_date) return "结束日期不能早于开始日期";
  if ([details.check_in_time, details.check_out_time].some((value) => value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) return "请填写有效的入住或退房时间";
  return "";
}

export function normalizeScheduleDetails(value: unknown): ScheduleDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== "all_day" && input.kind !== "hotel") return null;
  const details: ScheduleDetails = {
    kind: input.kind,
    start_date: typeof input.start_date === "string" ? input.start_date : "",
    end_date: typeof input.end_date === "string" ? input.end_date : "",
    ...(input.kind === "hotel" ? {
      check_in_time: typeof input.check_in_time === "string" ? input.check_in_time : undefined,
      check_out_time: typeof input.check_out_time === "string" ? input.check_out_time : undefined,
      booking_reference: typeof input.booking_reference === "string" ? input.booking_reference.trim() || undefined : undefined
    } : {})
  };
  return scheduleValidation(details) ? null : details;
}

export function scheduleTripDate(details: ScheduleDetails, trip: Pick<Trip, "start_date" | "end_date">) {
  const overlaps = details.start_date <= trip.end_date && details.end_date >= trip.start_date;
  return overlaps && details.start_date < trip.start_date ? trip.start_date : details.start_date;
}

export function scheduleDayEntries(records: LifeRecord[], day: string): ScheduleDayEntry[] {
  return records.flatMap((record): ScheduleDayEntry[] => {
    const details = normalizeScheduleDetails(record.schedule_details);
    if (!details || day < details.start_date || day > details.end_date) return [];
    const phase: SchedulePhase = details.kind === "all_day" ? "all_day" : day === details.end_date ? "check_out" : day === details.start_date ? "check_in" : "staying";
    return [{ record, details, phase }];
  }).sort((a, b) => {
    const order: Record<SchedulePhase, number> = { check_out: 0, check_in: 1, staying: 2, all_day: 3 };
    return order[a.phase] - order[b.phase] || a.details.start_date.localeCompare(b.details.start_date) || a.record.created_at.localeCompare(b.record.created_at) || a.record.id.localeCompare(b.record.id);
  });
}

export function scheduleDayNotice(entries: ScheduleDayEntry[]) {
  const active = entries.filter((entry) => entry.record.plan_status !== "cancelled");
  const leaving = active.filter((entry) => entry.phase === "check_out");
  const arriving = active.filter((entry) => entry.phase === "check_in");
  const overnight = active.filter((entry) => entry.phase === "staying" || entry.phase === "check_in");
  return {
    change: leaving.length && arriving.length ? `今日换酒店：从${leaving.map((entry) => entry.record.content).join("、")}退房，入住${arriving.map((entry) => entry.record.content).join("、")}。` : "",
    conflict: overnight.length > 1 ? "本晚有多条住宿安排，请核对是否重复预订或日期重叠。" : ""
  };
}

export function schedulePresentation(record: LifeRecord) {
  const details = normalizeScheduleDetails(record.schedule_details);
  if (!details) return null;
  return {
    title: record.content,
    label: details.kind === "hotel" ? "酒店住宿" : "全天事项",
    subtitle: details.kind === "hotel"
      ? `${details.start_date} 入住 → ${details.end_date} 退房 · ${scheduleNights(details)} 晚`
      : details.start_date === details.end_date ? `${details.start_date} · 全天` : `${details.start_date} — ${details.end_date} · 跨日全天`
  };
}

````

## src/lib/supabase.ts

<!-- source: src/lib/supabase.ts sha256: 5c9bb04638bed9d5a5fb6b0951bf06a882740fe8fcacdc67301328f3f53ea578 encoding: utf8 -->
````typescript
import { createClient } from "@supabase/supabase-js";

const defaultUrl = "https://ihqkgtmikwdakhyglels.supabase.co";
const defaultKey = "sb_publishable_dSuoed9lLUOklE0Mgf7r7A_5Bd8IRrb";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || defaultUrl;
export const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || defaultKey;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce"
  }
});

````

## src/lib/syncEngine.ts

<!-- source: src/lib/syncEngine.ts sha256: cb7bec4d21b787cdbd30523049c923db422de96c261a26ce2450b0bde9add1c1 encoding: utf8 -->
````typescript
import type { PendingMutation } from "./offline";

export interface SaveResult { state: "confirmed" | "pending" | "failed" | "conflict"; row: Record<string, unknown>; error?: string }
export function retryableWriteError(error: unknown) {
  const value = error as { code?: string; status?: number; message?: string };
  return error instanceof TypeError || (value.status || 0) >= 500 || ["08000", "08003", "08006", "40001", "40P01", "55P03", "53300", "57014"].includes(value.code || "") || /network|failed to fetch|fetch failed|timeout|load failed|connection/i.test(value.message || "");
}
export function writeErrorMessage(error: unknown) {
  const value = error as { code?: string };
  if (value.code === "42501") return "云端拒绝了保存权限；草稿和本地副本已保留，请检查账号权限。";
  if (["PGRST202", "42703"].includes(value.code || "")) return "云端数据库尚未更新；本地副本已保留，请完成数据库迁移后重试。";
  return "云端保存失败；草稿和本地副本已保留，请检查数据后重试。";
}
interface Adapter {
  currentOwner: () => Promise<string | undefined>;
  claim: (id: string, ownerId: string) => Promise<PendingMutation | null>;
  write: (item: PendingMutation) => Promise<{ data: { ok?: boolean; code?: string; row?: Record<string, unknown> } | null; error: unknown }>;
  finish: (item: PendingMutation, row: Record<string, unknown>) => Promise<void>;
  fail: (item: PendingMutation, state: PendingMutation["state"], message: string) => Promise<void>;
}
export async function replayMutation(candidate: PendingMutation, adapter: Adapter): Promise<SaveResult | null> {
  if (await adapter.currentOwner() !== candidate.ownerId) return null;
  const item = await adapter.claim(candidate.id, candidate.ownerId);
  if (!item) return null;
  if (await adapter.currentOwner() !== item.ownerId) { await adapter.fail(item, "pending", "等待原账号登录后同步"); return null; }
  try {
    const { data, error } = await adapter.write(item);
    if (error) throw error;
    if (data?.code === "CONFLICT") {
      const message = "云端内容已在其他设备更新；本地副本已保留，请导出核对，未覆盖云端。";
      await adapter.fail(item, "conflict", message); return { state: "conflict", row: item.payload, error: message };
    }
    if (!data?.ok || !data.row) throw new Error("Invalid save response");
    await adapter.finish(item, data.row);
    return { state: "confirmed", row: data.row };
  } catch (error) {
    const pending = retryableWriteError(error);
    const message = pending ? "已保存在此设备，等待联网同步" : writeErrorMessage(error);
    await adapter.fail(item, pending ? "pending" : "failed", message);
    return { state: pending ? "pending" : "failed", row: item.payload, error: message };
  }
}

````

## src/lib/timezones.ts

<!-- source: src/lib/timezones.ts sha256: 8649737dcb0ba2cf57fa1f304406cd1d380b0ae8784dc304b54e9050a1b7fae9 encoding: utf8 -->
````typescript
const DESTINATION_TIMEZONES: Array<[string[], string]> = [
  [["东京", "tokyo", "日本", "japan", "大阪", "osaka", "京都", "kyoto", "札幌", "sapporo", "福冈", "fukuoka", "冲绳", "okinawa"], "Asia/Tokyo"],
  [["洛杉矶", "los angeles", "旧金山", "san francisco", "西雅图", "seattle", "温哥华", "vancouver"], "America/Los_Angeles"],
  [["纽约", "new york", "波士顿", "boston", "华盛顿", "washington", "迈阿密", "miami", "多伦多", "toronto"], "America/New_York"],
  [["芝加哥", "chicago", "达拉斯", "dallas", "休斯顿", "houston"], "America/Chicago"],
  [["丹佛", "denver", "盐湖城", "salt lake city"], "America/Denver"],
  [["夏威夷", "hawaii", "檀香山", "honolulu"], "Pacific/Honolulu"],
  [["上海", "shanghai", "北京", "beijing", "中国", "china", "广州", "guangzhou", "深圳", "shenzhen", "成都", "chengdu", "重庆", "chongqing", "西安", "xian", "杭州", "hangzhou", "南京", "nanjing"], "Asia/Shanghai"],
  [["香港", "hong kong", "hongkong"], "Asia/Hong_Kong"],
  [["台北", "taipei", "台湾", "taiwan", "高雄", "kaohsiung"], "Asia/Taipei"],
  [["首尔", "seoul", "韩国", "korea", "釜山", "busan"], "Asia/Seoul"],
  [["新加坡", "singapore"], "Asia/Singapore"],
  [["曼谷", "bangkok", "泰国", "thailand", "清迈", "chiang mai"], "Asia/Bangkok"],
  [["吉隆坡", "kuala lumpur", "马来西亚", "malaysia"], "Asia/Kuala_Lumpur"],
  [["雅加达", "jakarta", "印度尼西亚", "indonesia"], "Asia/Jakarta"],
  [["巴厘岛", "bali", "登巴萨", "denpasar"], "Asia/Makassar"],
  [["马尼拉", "manila", "菲律宾", "philippines"], "Asia/Manila"],
  [["河内", "hanoi", "胡志明", "ho chi minh", "越南", "vietnam"], "Asia/Ho_Chi_Minh"],
  [["迪拜", "dubai", "阿联酋", "uae", "阿布扎比", "abu dhabi"], "Asia/Dubai"],
  [["德里", "delhi", "孟买", "mumbai", "印度", "india"], "Asia/Kolkata"],
  [["伦敦", "london", "英国", "united kingdom", "爱丁堡", "edinburgh"], "Europe/London"],
  [["巴黎", "paris", "法国", "france"], "Europe/Paris"],
  [["柏林", "berlin", "德国", "germany", "慕尼黑", "munich", "法兰克福", "frankfurt"], "Europe/Berlin"],
  [["罗马", "rome", "米兰", "milan", "意大利", "italy"], "Europe/Rome"],
  [["马德里", "madrid", "巴塞罗那", "barcelona", "西班牙", "spain"], "Europe/Madrid"],
  [["阿姆斯特丹", "amsterdam", "荷兰", "netherlands"], "Europe/Amsterdam"],
  [["苏黎世", "zurich", "瑞士", "switzerland", "日内瓦", "geneva"], "Europe/Zurich"],
  [["维也纳", "vienna", "奥地利", "austria"], "Europe/Vienna"],
  [["布拉格", "prague", "捷克", "czech"], "Europe/Prague"],
  [["雅典", "athens", "希腊", "greece"], "Europe/Athens"],
  [["伊斯坦布尔", "istanbul", "土耳其", "turkey"], "Europe/Istanbul"],
  [["悉尼", "sydney", "堪培拉", "canberra"], "Australia/Sydney"],
  [["墨尔本", "melbourne"], "Australia/Melbourne"],
  [["布里斯班", "brisbane"], "Australia/Brisbane"],
  [["珀斯", "perth"], "Australia/Perth"],
  [["奥克兰", "auckland", "新西兰", "new zealand", "惠灵顿", "wellington"], "Pacific/Auckland"],
  [["墨西哥城", "mexico city"], "America/Mexico_City"],
  [["圣保罗", "sao paulo", "里约", "rio de janeiro", "巴西", "brazil"], "America/Sao_Paulo"],
  [["开普敦", "cape town", "约翰内斯堡", "johannesburg", "南非", "south africa"], "Africa/Johannesburg"],
  [["开罗", "cairo", "埃及", "egypt"], "Africa/Cairo"]
];

const FALLBACK_TIMEZONES = [
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore", "Asia/Bangkok", "Asia/Dubai", "Asia/Kolkata",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Madrid", "Europe/Amsterdam", "Europe/Zurich", "Europe/Istanbul",
  "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Toronto", "Pacific/Honolulu",
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "Pacific/Auckland"
];

type IntlWithTimeZones = typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };

export const TIMEZONE_OPTIONS = (() => {
  const supported = (Intl as IntlWithTimeZones).supportedValuesOf?.("timeZone") || FALLBACK_TIMEZONES;
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Array.from(new Set([device, ...supported, ...FALLBACK_TIMEZONES])).sort((left, right) => left.localeCompare(right));
})();

export function detectTimeZone(destination: string) {
  const normalized = destination.trim().toLocaleLowerCase();
  if (!normalized) return null;
  return DESTINATION_TIMEZONES.find(([aliases]) => aliases.some((alias) => normalized.includes(alias)))?.[1] || null;
}

export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function timeZoneLabel(value: string) {
  return value.replaceAll("_", " ");
}

````

## src/lib/transitAi.ts

<!-- source: src/lib/transitAi.ts sha256: a2fe11109987b33edcf7d0eb42ebae7f80399cc7ed26c055f911e89e0d034869 encoding: utf8 -->
````typescript
import { deepseekAssist } from "./ai";

export const TRANSIT_AI_ERROR = "AI查询暂时不可用，可以手动填写";

export async function queryTransitRoute(origin: string, destination: string, query: string, departureTime?: string, isDemo = false) {
  const data = await deepseekAssist<string>("route", { origin: origin.trim(), destination: destination.trim(), query: query.trim(), departureTime: departureTime || undefined }, isDemo);
  if (typeof data.result !== "string" || !data.result.trim()) throw new Error(TRANSIT_AI_ERROR);
  return data.result.trim();
}

````

## src/lib/transport.ts

<!-- source: src/lib/transport.ts sha256: 10c396953e06a6a35181746387152c2e0deda33cf6bbbff7337e153bf42340b9 encoding: utf8 -->
````typescript
import type { FlightDetails, LifeRecord, MetroDetails, RailDetails, RailSystemType, TransportDetails, TransportType } from "../types";
import { normalizeAircraftType } from "./aircraftTypes";
import { flightDisplay } from "./flightDisplay";
import { schedulePresentation } from "./schedules";

export const RAIL_SYSTEM_LABELS: Record<RailSystemType, string> = {
  china_hsr: "中国高铁",
  japan_shinkansen: "日本新干线",
  germany_db: "德国 DB",
  taiwan_hsr: "台湾高铁",
  other: "其他"
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stringValue = (value: unknown) => typeof value === "string" ? value : "";
const utcOffset = (value: unknown) => typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 840 ? value : undefined;

export function isTransportType(value: unknown): value is TransportType {
  return value === "flight" || value === "rail" || value === "metro";
}

export function normalizeTransportDetails(type: TransportType, value: unknown): TransportDetails | null {
  if (!isObject(value)) return null;
  if (type === "flight") {
    const departure = isObject(value.departure) ? value.departure : {};
    const arrival = isObject(value.arrival) ? value.arrival : {};
    return {
      airline: stringValue(value.airline),
      flight_number: stringValue(value.flight_number),
      departure: { date: stringValue(departure.date), time: stringValue(departure.time), airport: stringValue(departure.airport), iata: stringValue(departure.iata) || undefined, terminal: stringValue(departure.terminal), timezone: stringValue(departure.timezone) || undefined, utc_offset_minutes: utcOffset(departure.utc_offset_minutes) },
      arrival: { date: stringValue(arrival.date), time: stringValue(arrival.time), airport: stringValue(arrival.airport), iata: stringValue(arrival.iata) || undefined, terminal: stringValue(arrival.terminal), timezone: stringValue(arrival.timezone) || undefined, utc_offset_minutes: utcOffset(arrival.utc_offset_minutes) },
      gate: stringValue(value.gate) || undefined,
      registration: stringValue(value.registration) || undefined,
      seat: stringValue(value.seat) || undefined,
      aircraft_type: normalizeAircraftType(stringValue(value.aircraft_type)) || undefined,
      notes: stringValue(value.notes) || undefined
    } satisfies FlightDetails;
  }
  if (type === "rail") {
    const departure = isObject(value.departure) ? value.departure : {};
    const arrival = isObject(value.arrival) ? value.arrival : {};
    const systemType = value.system_type;
    return {
      system_type: systemType === "china_hsr" || systemType === "japan_shinkansen" || systemType === "germany_db" || systemType === "taiwan_hsr" || systemType === "other" ? systemType : "other",
      custom_system: stringValue(value.custom_system) || undefined,
      train_number: stringValue(value.train_number),
      departure: { date: stringValue(departure.date), time: stringValue(departure.time), station: stringValue(departure.station) },
      arrival: { date: stringValue(arrival.date), time: stringValue(arrival.time), station: stringValue(arrival.station) },
      seat_carriage: stringValue(value.seat_carriage) || undefined,
      notes: stringValue(value.notes) || undefined
    } satisfies RailDetails;
  }
  return {
    origin: stringValue(value.origin),
    destination: stringValue(value.destination),
    estimated_departure_time: stringValue(value.estimated_departure_time) || undefined,
    estimated_arrival_time: stringValue(value.estimated_arrival_time) || undefined,
    route_description: stringValue(value.route_description) || undefined,
    notes: stringValue(value.notes) || undefined
  } satisfies MetroDetails;
}

export function normalizeTransport(valueType: unknown, valueDetails: unknown) {
  if (!isTransportType(valueType)) return { transport_type: null, transport_details: null } as const;
  const details = normalizeTransportDetails(valueType, valueDetails);
  return details ? { transport_type: valueType, transport_details: details } : { transport_type: null, transport_details: null } as const;
}

function compactAirport(value: string) {
  const match = value.trim().match(/(?:^|[\s(])([A-Z]{3,4})\)?$/);
  return match?.[1] || value.trim();
}

export function transportTitle(type: TransportType, details: TransportDetails) {
  if (type === "flight") {
    const flight = details as FlightDetails;
    return `${flight.flight_number || "航班"} · ${compactAirport(flight.departure.airport)}→${compactAirport(flight.arrival.airport)}`;
  }
  if (type === "rail") {
    const rail = details as RailDetails;
    return `${rail.train_number || "列车"} · ${rail.departure.station}→${rail.arrival.station}`;
  }
  const metro = details as MetroDetails;
  return `${metro.origin}→${metro.destination}`;
}

export function getTransportPresentation(record: LifeRecord) {
  const schedule = schedulePresentation(record);
  if (schedule) return schedule;
  if (!record.transport_type || !record.transport_details) {
    return { title: record.content, subtitle: record.notes || "", label: "通用事项" };
  }
  if (record.transport_type === "flight") {
    const details = flightDisplay(record)!.details;
    return {
      title: transportTitle("flight", details),
      subtitle: [details.airline, details.gate ? `登机口 ${details.gate}` : "", details.seat ? `座位 ${details.seat}` : ""].filter(Boolean).join(" · "),
      label: "飞机"
    };
  }
  if (record.transport_type === "rail") {
    const details = record.transport_details as RailDetails;
    const system = details.system_type === "other" ? details.custom_system || "铁路" : RAIL_SYSTEM_LABELS[details.system_type];
    return {
      title: transportTitle("rail", details),
      subtitle: [system, details.seat_carriage || ""].filter(Boolean).join(" · "),
      label: "铁路"
    };
  }
  const details = record.transport_details as MetroDetails;
  return {
    title: transportTitle("metro", details),
    subtitle: details.route_description || details.notes || "",
    label: "市内交通"
  };
}

````

## src/lib/tripDates.ts

<!-- source: src/lib/tripDates.ts sha256: 4c630b0f30383a11281426eb5dd2e7b3b22581d2cc5badca53270f085031dd31 encoding: utf8 -->
````typescript
import { flightTimeOptions, resolveFlightInstant } from "../../supabase/functions/_shared/flightTime";

export function dateInZone(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function zonedDateTimeToIso(date: string, time: string, timeZone: string, utcOffsetMinutes?: number, previousIso?: string) {
  const stop = { date, time: time || "09:00", timezone: timeZone };
  const options = flightTimeOptions(stop);
  const previous = previousIso ? Date.parse(previousIso) : NaN;
  const original = options.find(option => option.instant === Math.floor(previous / 60_000) * 60_000);
  const instant = resolveFlightInstant({ ...stop, utc_offset_minutes: utcOffsetMinutes ?? original?.utcOffsetMinutes });
  // A no-op edit keeps seconds and the occurrence of a repeated local clock.
  return original?.instant === instant ? new Date(previous).toISOString() : new Date(instant).toISOString();
}

````

## src/main.tsx

<!-- source: src/main.tsx sha256: 9d1294cb7414d7ffedabd3df806b342416e20df2a03b975178ac77d5f6bbfdfe encoding: utf8 -->
````tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";

registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

````

## src/types.ts

<!-- source: src/types.ts sha256: ec40f909e563374a32174a4eb31016246f89cc237ea27a56402e7185f9ae1ed6 encoding: utf8 -->
````typescript
export type RecordType = "expense" | "trip" | "note";
export type ExpenseCategory = "food" | "transport" | "shopping" | "stay" | "entertainment" | "other";
export type PlanStatus = "planned" | "completed" | "cancelled";
export type TransportType = "flight" | "rail" | "metro";
export type RailSystemType = "china_hsr" | "japan_shinkansen" | "germany_db" | "taiwan_hsr" | "other";
export type Currency = "USD" | "JPY" | "EUR" | "GBP" | "CNY" | "HKD" | "SGD" | "KRW" | "AUD" | "NZD" | "CHF" | "CAD" | "THB";
export type ThemeMode = "system" | "dark" | "light";
export type AccountTier = "demo" | "standard" | "friend" | "owner";
export type ActualMatchStatus = "never" | "eligible" | "matching" | "matched" | "not_found" | "failed";

export interface FlightStop {
  date: string;
  time: string;
  airport: string;
  iata?: string;
  terminal: string;
  timezone?: string;
  /** Explicit UTC offset for a repeated local clock (minutes east of UTC). */
  utc_offset_minutes?: number;
}

export interface FlightDetails {
  airline: string;
  flight_number: string;
  departure: FlightStop;
  arrival: FlightStop;
  gate?: string;
  registration?: string;
  seat?: string;
  aircraft_type?: string;
  notes?: string;
}

export interface ActualFlightStop {
  airport: string;
  iata: string;
  timezone: string;
  scheduled: { iso: string | null; date: string; time: string };
  estimated: { iso: string | null; date: string; time: string };
  actual: { iso: string | null; date: string; time: string };
  delay_minutes: number;
  terminal: string;
  gate: string;
}

export interface ActualFlightInfo {
  status: string;
  airline: string;
  flight_number: string;
  departure: ActualFlightStop;
  arrival: ActualFlightStop;
  aircraft_type: string;
  registration: string;
  source: "aviationstack";
  matched_at: string;
}

export interface RailDetails {
  system_type: RailSystemType;
  custom_system?: string;
  train_number: string;
  departure: { date: string; time: string; station: string };
  arrival: { date: string; time: string; station: string };
  seat_carriage?: string;
  notes?: string;
}

export interface MetroDetails {
  origin: string;
  destination: string;
  estimated_departure_time?: string;
  estimated_arrival_time?: string;
  route_description?: string;
  notes?: string;
}

export type TransportDetails = FlightDetails | RailDetails | MetroDetails;

export interface ScheduleDetails {
  kind: "all_day" | "hotel";
  start_date: string;
  end_date: string;
  check_in_time?: string;
  check_out_time?: string;
  booking_reference?: string;
}

export interface UserSettings {
  user_id: string;
  base_currency: Currency;
  theme: ThemeMode;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  avatar_color: string;
  has_seen_onboarding: boolean;
  last_seen_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface Changelog {
  id: string;
  version: string;
  summary: string[];
  created_at: string;
}

export interface Trip {
  id: string;
  user_id: string;
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  timezone: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LifeRecord {
  id: string;
  user_id: string;
  record_type: RecordType;
  content: string;
  notes: string | null;
  amount: number | null;
  currency: Currency | null;
  expense_category: ExpenseCategory | null;
  location: string | null;
  event_at: string;
  trip_id: string | null;
  plan_status: PlanStatus | null;
  sort_order: number | null;
  parent_plan_id: string | null;
  transport_type: TransportType | null;
  transport_details: TransportDetails | null;
  schedule_details?: ScheduleDetails | null;
  actual_match_status: ActualMatchStatus;
  actual_info: ActualFlightInfo | null;
  actual_info_matched: boolean;
  actual_matched_at: string | null;
  actual_match_provider: string | null;
  actual_match_request_id: string | null;
  actual_confirmed_request_id?: string | null;
  flight_plan_version?: number;
  actual_match_plan_version?: number | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiQuotaBucket {
  bucket_key: string;
  used_value: number;
  limit_value: number;
  period_end: string;
}

export interface ApiQuotaSnapshot {
  tier: Exclude<AccountTier, "demo">;
  timezone: "Asia/Shanghai";
  cooldownUntil: string | null;
  deepseekMonthTotal: number;
  aviation: {
    globalUsed: number;
    globalLimit: 100;
    globalRemaining: number;
    nonOwnerUsed: number;
    nonOwnerLimit: 80;
    ownerUsed: number;
  };
  buckets: ApiQuotaBucket[];
}

export interface OwnerManagedUser {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  tier: Exclude<AccountTier, "demo">;
  source: string;
  grantedAt: string | null;
  monthUsage: {
    aviation: number;
    deepseek: number;
  };
}

export interface ExchangeRate {
  id: string;
  user_id: string;
  base_currency: Currency;
  quote_currency: Currency;
  rate: number;
  rate_date: string;
  source: "api" | "manual";
  created_at: string;
  updated_at: string;
}

export interface RecordDraft {
  record_type: RecordType;
  content: string;
  notes?: string;
  amount?: number;
  currency?: Currency;
  expense_category?: ExpenseCategory;
  location?: string;
  event_at?: string;
  trip_id?: string;
  plan_status?: PlanStatus;
  sort_order?: number;
  parent_plan_id?: string;
  transport_type?: TransportType;
  transport_details?: TransportDetails;
  schedule_details?: ScheduleDetails;
}

export interface TripDraft {
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  timezone: string;
}

export const CURRENCIES: { code: Currency; label: string; symbol: string }[] = [
  { code: "USD", label: "美元", symbol: "$" },
  { code: "JPY", label: "日元", symbol: "¥" },
  { code: "EUR", label: "欧元", symbol: "€" },
  { code: "GBP", label: "英镑", symbol: "£" },
  { code: "CNY", label: "人民币", symbol: "¥" },
  { code: "HKD", label: "港币", symbol: "HK$" },
  { code: "SGD", label: "新加坡元", symbol: "S$" },
  { code: "KRW", label: "韩元", symbol: "₩" },
  { code: "AUD", label: "澳元", symbol: "A$" },
  { code: "NZD", label: "新西兰元", symbol: "NZ$" },
  { code: "CHF", label: "瑞士法郎", symbol: "CHF" },
  { code: "CAD", label: "加元", symbol: "C$" },
  { code: "THB", label: "泰铢", symbol: "฿" }
];

export const CATEGORY_META: Record<ExpenseCategory, { label: string; color: string }> = {
  food: { label: "餐饮", color: "#0A84FF" },
  transport: { label: "交通", color: "#8E8E93" },
  shopping: { label: "购物", color: "#636366" },
  stay: { label: "住宿", color: "#AEAEB2" },
  entertainment: { label: "娱乐", color: "#48484A" },
  other: { label: "其他", color: "#C7C7CC" }
};

export const nowLocalInput = () => {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
};

export const toIso = (value: string) => new Date(value).toISOString();

export const formatMoney = (amount: number, currency: Currency) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "JPY" || currency === "KRW" ? 0 : 2
  }).format(amount);

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  }).format(new Date(iso));

````

## src/version.ts

<!-- source: src/version.ts sha256: a03002fe8c242735ef2a02dc948357b41ba9e3d86adc8ebda46cb78c2082f701 encoding: utf8 -->
````typescript
export const APP_VERSION = "2.0.0";

````

## scripts/build-documentation-reference.mjs

<!-- source: scripts/build-documentation-reference.mjs sha256: 77971c7ef248f50a5e041025191607179d8ac19b93e31148188521797eb02115 encoding: utf8 -->
````javascript
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { readReference } from "./restore-documentation-reference.mjs";

// Mechanical, deterministic source archives only. Never read .env.local,
// node_modules, Git internals, uploads, credentials or runtime data.
const root = process.cwd();
const dateIndex = process.argv.indexOf("--date");
const snapshotDate = dateIndex >= 0 ? process.argv[dateIndex + 1] : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate || "") || new Date(`${snapshotDate}T12:00:00Z`).toISOString().slice(0, 10) !== snapshotDate) throw new Error("--date must be a valid YYYY-MM-DD date");
const sections = new Map(["SCHEMA", "EDGE", "DOMAIN", "FRONTEND", "ASSET"].map(name => [name, []]));
const directoryFiles = directory => {
  const result = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing source symlink: ${directory}/${entry.name}`);
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...directoryFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
};
for (const path of directoryFiles("src")) sections.get(path.startsWith("src/components/") || path === "src/App.tsx" || path.startsWith("src/styles") ? "FRONTEND" : "DOMAIN").push(path);
sections.get("SCHEMA").push(...directoryFiles("supabase/migrations"));
sections.get("EDGE").push(...directoryFiles("supabase/functions"), ...directoryFiles("supabase/templates"));
sections.get("DOMAIN").push(...directoryFiles("scripts"), ...directoryFiles(".github"),
  ".gitignore", ".env.example", "package.json", "package-lock.json", "index.html", "vite.config.ts", "eslint.config.mjs",
  "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "supabase/config.toml", "supabase/.env.example");
sections.get("ASSET").push(...directoryFiles("public"));

const titles = { SCHEMA: "完整有序数据库迁移", EDGE: "完整后端与验证码邮件模板", DOMAIN: "领域、字典、配置与测试", FRONTEND: "完整界面与样式", ASSET: "正式图标二进制" };
const language = path => ({ ".ts": "typescript", ".tsx": "tsx", ".mjs": "javascript", ".js": "javascript", ".sql": "sql", ".json": "json", ".toml": "toml", ".html": "html", ".css": "css", ".yml": "yaml" })[extname(path)] || "text";
const generated = new Map();
const seen = new Set();
for (const [name, paths] of sections) {
  let text = `# ${titles[name]}精确参考\n\n快照：${snapshotDate}，V2.0.0本地修复候选工作树，未部署。由build-documentation-reference.mjs机械生成；每块保存原始字节和SHA256。\n\n先读[最新验收](../ACCEPTANCE-2026-10-01.md)、[重建规范](../REBUILD-SPEC.md)和[恢复流程](../DEPLOYMENT-ROLLBACK.md)。这是代码快照，不保证所有发布门禁已完成。SQL含历史身份种子，新项目先安全替换。包中无云端历史数据、用户上传图片或服务私钥。\n`;
  for (const path of paths) {
    if (seen.has(path) || path.includes(".env.local") || /(?:^|\/)node_modules(?:\/|$)/.test(path)) throw new Error(`Duplicate or unsafe path: ${path}`);
    seen.add(path);
    const bytes = readFileSync(resolve(root, path));
    const binary = name === "ASSET";
    const body = bytes.toString(binary ? "base64" : "utf8");
    if (!binary && (!Buffer.from(body).equals(bytes) || /^`{4}/m.test(body))) throw new Error(`Unsafe source encoding/fence: ${path}`);
    if (/(?:\bsk-[A-Za-z0-9]{20,}|\bre_[A-Za-z0-9]{20,})/.test(body)) throw new Error(`Possible private key in source: ${path}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    text += `\n## ${path}\n\n<!-- source: ${path} sha256: ${hash} encoding: ${binary ? "base64" : "utf8"} -->\n\x60\x60\x60\x60${binary ? "base64" : language(path)}\n${body}\n\x60\x60\x60\x60\n`;
  }
  generated.set(`${name}-REFERENCE.md`, text);
}
if (!process.argv.includes("--write")) {
  console.log(`Dry run: ${seen.size} source/asset files selected. Use --write to refresh five reference Markdown files.`);
} else {
  const destination = resolve(root, "docs/reference");
  mkdirSync(destination, { recursive: true });
  for (const [name, text] of generated) writeFileSync(resolve(destination, name), text);
  if (readReference(destination).size !== seen.size) throw new Error("Generated reference is incomplete");
  console.log(`Refreshed and verified ${seen.size} exact source/asset snapshots.`);
}

````

## scripts/restore-documentation-reference.mjs

<!-- source: scripts/restore-documentation-reference.mjs sha256: 7217096301554c9e88f1afd03d2c0635ae283d98ff94f427f0a3e7a69cae5f25 encoding: utf8 -->
````javascript
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Documentation contains source snapshots, never cloud data or secrets.
export const referenceNames = ["SCHEMA", "EDGE", "DOMAIN", "FRONTEND", "ASSET"].map(name => `${name}-REFERENCE.md`);

export function readReference(directory) {
  const result = new Map();
  for (const name of referenceNames) {
    const text = readFileSync(resolve(directory, name), "utf8");
    const pattern = /^<!-- source: (.+) sha256: ([a-f0-9]{64}) encoding: (utf8|base64) -->\n\x60{4}[^\n]*\n([\s\S]*?)\n\x60{4}$/gm;
    for (const match of text.matchAll(pattern)) {
      const [, path, expected, encoding, body] = match;
      if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === ".." || part === ".") || path.startsWith(".git/") || path.includes(".env.local")) throw new Error(`Unsafe snapshot path: ${path}`);
      if (result.has(path)) throw new Error(`Duplicate snapshot path: ${path}`);
      const bytes = Buffer.from(body, encoding === "base64" ? "base64" : "utf8");
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) throw new Error(`Corrupt reference: ${path}`);
      result.set(path, { bytes, sha256: actual });
    }
  }
  if (result.size < 70 || !result.has("src/App.tsx") || !result.has("package-lock.json") || !result.has("supabase/config.toml")) throw new Error("Incomplete reference bundle");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const docs = resolve(value("--reference") || "docs/reference");
  const entries = readReference(docs);
  if (!args.includes("--write")) {
    console.log(`Verified ${entries.size} files. Dry run only; use --out NEW_DIRECTORY --write to restore.`);
  } else {
    const requested = value("--out");
    if (!requested || requested.startsWith("--")) throw new Error("--out NEW_DIRECTORY is required");
    const destination = resolve(requested);
    if (existsSync(destination)) throw new Error("Refusing to overwrite an existing directory");
    mkdirSync(destination, { recursive: true });
    for (const [path, { bytes }] of entries) {
      const output = resolve(destination, path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes, { flag: "wx" });
    }
    console.log(`Restored ${entries.size} files into ${destination}. No cloud operations performed.`);
  }
}

````

## scripts/test-ai-reliability.mjs

<!-- source: scripts/test-ai-reliability.mjs sha256: bb6315764b87a9515439aaf50c256c527d2c200f4c3527644ebaf2382c244818 encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";

const root = process.cwd();
const secret = "local-test-only-signing-secret";
const ownId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
let currentUser = ownId;
let failStore = false;
let failCacheRead = false;
let failUsage = false;
let failUpstream = false;
let quotaCalls = 0;
let upstreamCalls = 0;
let storeCalls = 0;
let stored = null;
let upstreamMode = "normal";
let upstreamJson = null;
let lastUpstreamSignal;
const completedUsage = [];
const errorLogs = [];
const fakeSecret = "FAKE_SECRET_MUST_NOT_APPEAR";
const liveTimers = new Set();
const timedSetTimeout = (callback, ms) => {
  const timer = setTimeout(() => { liveTimers.delete(timer); callback(); }, upstreamMode === "headers" || upstreamMode === "body" ? 5 : ms);
  liveTimers.add(timer); return timer;
};
const timedClearTimeout = (timer) => { liveTimers.delete(timer); clearTimeout(timer); };
const dailyCache = new Map();
let frozenNow;
class Clock extends Date { constructor(...args){super(...(args.length?args:frozenNow==null?[]:[frozenNow]));} static now(){return frozenNow??Date.now();} }
const trip = { id: "20000000-0000-4000-8000-000000000001", name: "Tokyo", destination: "Tokyo", timezone: "Asia/Tokyo", start_date: "2020-01-01", end_date: "2030-12-31" };
const hotel = { id: "hotel", trip_id: trip.id, content: "Hotel", event_at: "2020-01-01T00:00:00Z", plan_status: "planned", transport_type: null, transport_details: null,
  schedule_details: { kind: "hotel", start_date: "2020-01-01", end_date: "2030-12-31" } };
let recordRows=[hotel], tripRows=[trip], pageCap=500, failRecordPage=false, lastRequestBody;

function query(table) {
  const filters = new Map();
  let afterId = null, pageLimit = 500;
  const chain = {
    select() { return chain; }, eq(key, value) { filters.set(key, value); return chain; },
    is() { return chain; }, in() { return chain; }, neq() { return chain; }, order() { return chain; },
    limit(value) { pageLimit = value; return chain; }, gt(key, value) { if (key === "id") afterId = value; return chain; },
    maybeSingle() { return answer(true); }, then(yes, no) { return answer(false).then(yes, no); }
  };
  async function answer(single=false) {
    if (table === "trips") return { data: single?trip:tripRows.filter(row => !afterId || row.id > afterId).slice(0,Math.min(pageCap,pageLimit)), error: null };
    if (table === "records") return { data: recordRows.filter(row => !afterId || row.id > afterId).slice(0,Math.min(pageCap,pageLimit)), error: failRecordPage&&afterId?{message:"page unavailable"}:null };
    if (table === "trip_recaps") return {data:null,error:null};
    if (table === "daily_summaries") {
      const cached=dailyCache.get(`${filters.get("user_id")}:${filters.get("context_key")}`);
      const dateMatches=!filters.has("summary_date")||cached?.summary_date===filters.get("summary_date");
      return { data: dateMatches?cached||null:null, error: failCacheRead ? { message: "cache refused" } : null };
    }
    throw new Error(`Unexpected mock query ${table}`);
  }
  return chain;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: currentUser } }, error: null }) },
  from: query,
  async rpc(name, args) {
    if (name === "consume_api_quota") { quotaCalls += 1; return { data: { allowed: true }, error: null }; }
    if (name === "complete_api_usage") { completedUsage.push(args); return { data: null, error: failUsage ? { message: "usage refused" } : null }; }
    if (name === "store_ai_result") {
      storeCalls += 1;
      if (failStore || failUsage) return { data: null, error: { message: "store or completion refused" } };
      stored = args;
      if (args.p_feature === "daily_summary") dailyCache.set(`${args.p_user_id}:${args.p_context_key}`, { content: args.p_content, generated_at: args.p_generated_at, summary_date:args.p_summary_date });
      return { data: { saved: true, generatedAt: args.p_generated_at }, error: null };
    }
    throw new Error(`Unexpected mock RPC ${name}`);
  }
};

const sandbox = {
  crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, Intl, Date:Clock, Request, Response, AbortController, DOMException, setTimeout: timedSetTimeout, clearTimeout: timedClearTimeout,
  console: { error(...args) { errorLogs.push(args); } }, Deno: { env: { get: (name) => name === "SUPABASE_SERVICE_ROLE_KEY" ? secret : name === "DEEPSEEK_API_KEY" ? "mock-not-a-real-key" : "http://localhost" } },
  fetch: async (_input, init) => {
    upstreamCalls += 1; lastUpstreamSignal = init.signal; lastRequestBody=JSON.parse(init.body);
    // Deliberately ignore AbortSignal, so the explicit deadline must settle.
    if (upstreamMode === "headers") return new Promise(() => {});
    if (upstreamMode === "body") return { ok: true, status: 200, json: () => new Promise(() => {}) };
    if (upstreamMode === "network") throw new TypeError(`Fetch failed URL=https://example.test?access_key=${fakeSecret} Authorization=Bearer ${fakeSecret}`);
    if (upstreamMode === "malformed") return new Response("{invalid");
    if (upstreamMode === "json") return new Response(JSON.stringify(upstreamJson));
    return new Response(JSON.stringify({ choices: [{ message: { content: "今日酒店续住，慢慢开始新的一天。" } }], usage: { total_tokens: 50 } }), { status: failUpstream ? 502 : 200 });
  }
};
const modules = new Map();
function load(path) {
  path = resolve(root, path);
  if (modules.has(path)) return modules.get(path);
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  modules.set(path, exports);
  runInNewContext(code, { ...sandbox, exports, require: (name) => name.startsWith("jsr:") ? { createClient: () => client } : load(resolve(dirname(path), name)) }, { filename: path });
  return exports;
}
const ai = load("supabase/functions/_shared/aiData.ts");
const recovery = load("supabase/functions/_shared/recovery.ts");
const edge = load("supabase/functions/deepseek-assist/index.ts").default;
const plain = (value) => JSON.parse(JSON.stringify(value));

const money = ai.aggregateExpenseCurrencies([
  { record_type: "expense", amount: 1, currency: "USD", expense_category: "food" },
  { record_type: "expense", amount: 100, currency: "JPY", expense_category: "food" },
  { record_type: "expense", amount: "2.5", currency: "USD", expense_category: "transport" },
  { record_type: "expense", amount: null, currency: "USD" },
  { record_type: "expense", amount: "invalid", currency: "JPY" },
  { record_type: "expense", amount: -1, currency: "USD" },
  { record_type: "note", amount: 1000, currency: "USD" },
  { record_type: "expense", amount: 3, currency: "CNY", expense_category: "__proto__" }
]);
assert.deepEqual(plain(money), { expenseTotals: { USD: 3.5, JPY: 100, CNY: 3 }, categoryTotalsByCurrency: { USD: { food: 1, transport: 2.5 }, JPY: { food: 100 }, CNY: { other: 3 } } });
assert.equal(money.categoryTotalsByCurrency.food, undefined, "No cross-currency category total");

const instant = "2026-09-29T23:30:00Z";
assert.equal(ai.dateInZone(instant, "Asia/Tokyo"), "2026-09-30");
assert.equal(ai.dateInZone(instant, "America/Los_Angeles"), "2026-09-29");
const laTrip = { ...trip, id: "la", start_date: "2026-09-29", end_date: "2026-09-29", timezone: "America/Los_Angeles" };
const tokyoTrip = { ...trip, id: "tokyo", start_date: "2026-09-30", end_date: "2026-10-02" };
const active = ai.activeSummaryTrips([tokyoTrip, laTrip], instant);
assert.deepEqual(plain(active.map(({ id, day }) => ({ id, day }))), [{ id: "la", day: "2026-09-29" }, { id: "tokyo", day: "2026-09-30" }]);
assert.equal(ai.dailySummaryContext(active), ai.dailySummaryContext([...active].reverse()));
assert.notEqual(ai.dailySummaryContext(active), ai.dailySummaryContext(ai.activeSummaryTrips([tokyoTrip, laTrip], "2026-09-30T15:30:00Z")), "Context rotates at trip-local midnight independently of quota day");

const summaryRecord = (id, details) => ({ ...hotel, id, trip_id: "tokyo", content: id, schedule_details: details });
const plans = ai.projectDailyPlans([
  summaryRecord("old", { kind: "hotel", start_date: "2026-09-28", end_date: "2026-09-30", check_out_time: "10:00" }),
  summaryRecord("new", { kind: "hotel", start_date: "2026-09-30", end_date: "2026-10-02", check_in_time: "15:00" }),
  summaryRecord("all", { kind: "all_day", start_date: "2026-09-29", end_date: "2026-10-01" }),
  { ...summaryRecord("cancel", { kind: "all_day", start_date: "2026-09-29", end_date: "2026-10-01" }), plan_status: "cancelled" },
  { ...summaryRecord("timed", null), event_at: "2026-09-30T01:00:00Z" }
], active);
assert.deepEqual(plain(plans.map(({ id, phase, time }) => ({ id, phase, time }))), [{ id: "old", phase: "check_out", time: "10:00" }, { id: "new", phase: "check_in", time: "15:00" }, { id: "all", phase: "all_day", time: "全天" }, { id: "timed", phase: "timed", time: "10:00" }]);
const firstDayTrip = { ...tokyoTrip, start_date: "2026-09-29", day: "2026-09-29" };
const flight = { ...summaryRecord("flight", null), transport_type: "flight", transport_details: { departure: { date: "2026-09-28", time: "00:50", timezone: "America/Los_Angeles" }, arrival: { date: "2026-09-29", time: "05:00", timezone: "Asia/Tokyo" } } };
assert.equal(ai.projectDailyPlans([flight], [firstDayTrip])[0].date, "2026-09-29", "Inbound flight is visible on first overlapping trip day");
assert.equal(ai.projectDailyPlans([summaryRecord("stay", { kind: "hotel", start_date: "2026-09-28", end_date: "2026-10-02" })], active)[0].phase, "staying");
const malformedHotel = { ...summaryRecord("legacy-invalid", { kind: "hotel", start_date: "2026-09-28", end_date: "2026-10-02", check_in_time: "25:00" }), event_at: "2026-09-30T01:00:00Z" };
assert.equal(ai.projectDailyPlans([malformedHotel], active)[0].phase, "timed", "Malformed legacy schedule follows the same generic-event fallback as frontend normalization");
const dstTrip = { ...laTrip, start_date: "2026-11-01", end_date: "2026-11-01", day: "2026-11-01" };
const dstPlans = ai.projectDailyPlans([
  { ...hotel, id: "second", trip_id: "la", schedule_details: null, event_at: "2026-11-01T09:30:00Z" },
  { ...hotel, id: "first", trip_id: "la", schedule_details: null, event_at: "2026-11-01T08:30:00Z" }
], [dstTrip]);
assert.deepEqual(plain(dstPlans.map(({ id, time }) => ({ id, time }))), [{ id: "first", time: "01:30" }, { id: "second", time: "01:30" }], "Fall-back repeated wall-clock hour stays on the same local day and sorts by actual instant");

// The two occurrences of LA 01:30 land on different calendar days in Gambier.
// Both departure and arrival must use the selected UTC offset, never a guess.
const gambierTrip = { ...laTrip, id: "gambier", timezone: "Pacific/Gambier", start_date: "2026-10-31", end_date: "2026-11-02" };
const gambierFlight = (id, offset) => ({ ...hotel, id, trip_id: "gambier", schedule_details: null, transport_type: "flight", transport_details: {
  departure: { date: "2026-11-01", time: "01:30", timezone: "America/Los_Angeles", ...(offset == null ? {} : { utc_offset_minutes: offset }) },
  arrival: { date: "2026-11-01", time: "03:30", timezone: "America/Los_Angeles", utc_offset_minutes: -480 }
} });
const occurrenceRecords = [gambierFlight("first", -420), gambierFlight("second", -480), gambierFlight("ambiguous", undefined)];
for (const [day, expected] of [["2026-10-31", ["first"]], ["2026-11-01", ["second"]]]) {
  assert.deepEqual(plain(ai.projectDailyPlans(occurrenceRecords, [{ ...gambierTrip, day }]).map(plan => plan.id)), expected, "Selected LA departure occurrence crosses Gambier midnight correctly; unselected ambiguity is omitted");
}
const arrivalBoundaryTrip = { ...gambierTrip, start_date: "2026-11-01", day: "2026-11-01" };
const arrivalOccurrence = (id, offset) => ({ ...gambierFlight(id, -420), transport_details: {
  departure: { date: "2026-10-31", time: "22:30", timezone: "Pacific/Gambier", utc_offset_minutes: -540 },
  arrival: { date: "2026-11-01", time: "01:30", timezone: "America/Los_Angeles", ...(offset == null ? {} : { utc_offset_minutes: offset }) }
} });
assert.deepEqual(plain(ai.projectDailyPlans([arrivalOccurrence("first-arrival", -420), arrivalOccurrence("second-arrival", -480), arrivalOccurrence("ambiguous-arrival", undefined)], [arrivalBoundaryTrip]).map(plan => plan.id)), ["second-arrival"], "Only the second arrival occurrence overlaps the first Gambier trip day; missing choice is not guessed");

const token = await recovery.signRecoveryToken({ userId: ownId, result: "中文内容" }, "test", secret, 1000, 1000);
assert.deepEqual(plain(await recovery.verifyRecoveryToken(token, "test", secret, 1500)), { userId: ownId, result: "中文内容" });
await assert.rejects(recovery.verifyRecoveryToken(token, "other", secret, 1500));
await assert.rejects(recovery.verifyRecoveryToken(token, "test", "wrong", 1500));
await assert.rejects(recovery.verifyRecoveryToken(token, "test", secret, 2000));
await assert.rejects(recovery.verifyRecoveryToken(token.replace(/.$/, token.endsWith("A") ? "B" : "A"), "test", secret, 1500));
await assert.rejects(recovery.signRecoveryToken({}, "test", "", 1000));

async function request(body) {
  const response = await edge.fetch(new Request("http://localhost/deepseek-assist", { method: "POST", headers: { origin: "http://localhost:3000", authorization: "Bearer mock" }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
failStore = true;
const generated = await request({ action: "daily_summary" });
assert.equal(generated.status, 200);
assert.equal(generated.body.data.persisted, false);
assert.ok(generated.body.data.result.includes("酒店续住"));
assert.ok(generated.body.data.recoveryToken);
assert.equal(upstreamCalls, 1);
assert.equal(quotaCalls, 1);
currentUser = otherId;
const forbidden = await request({ action: "retry_save", recoveryToken: generated.body.data.recoveryToken });
assert.equal(forbidden.status, 403);
assert.equal(storeCalls, 1, "Other account cannot replay saved result");
currentUser = ownId;
failStore = false;
const retried = await request({ action: "retry_save", recoveryToken: generated.body.data.recoveryToken });
assert.equal(retried.status, 200);
assert.equal(retried.body.data.persisted, true);
assert.equal(stored.p_user_id, ownId);
assert.equal(stored.p_content, generated.body.data.result);
assert.equal(upstreamCalls, 1, "Retry save never calls model");
assert.equal(quotaCalls, 1, "Retry save never consumes quota");
const cached = await request({ action: "daily_summary" });
assert.equal(cached.body.data.cached, true);
assert.equal(cached.body.data.persisted, true);
assert.equal(upstreamCalls, 1);
trip.timezone="America/Los_Angeles";
frozenNow=Date.parse("2026-09-30T15:59:00Z");
const laBefore=await request({action:"daily_summary"});
assert.equal(laBefore.body.data.cached,false);
const midnightCounts={upstreamCalls,quotaCalls,storeCalls};
frozenNow=Date.parse("2026-09-30T16:01:00Z");
const laAfter=await request({action:"daily_summary"});
assert.equal(laAfter.body.data.contextKey,laBefore.body.data.contextKey);
assert.equal(laAfter.body.data.cached,true,"Shanghai midnight does not create a new LA business day cache");
assert.deepEqual({upstreamCalls,quotaCalls,storeCalls},midnightCounts,"Same trip-local context across Shanghai midnight consumes zero extra upstream/quota/store");
frozenNow=undefined; trip.timezone="Asia/Tokyo";
failCacheRead = true;
const unreadable = await request({ action: "daily_summary" });
assert.equal(unreadable.status, 503);
assert.equal(unreadable.body.error.code, "CACHE_UNAVAILABLE");
assert.equal(upstreamCalls, midnightCounts.upstreamCalls, "Unknown cache state must not trigger new generation");
failCacheRead = false;
failUsage = true;
const sharedApi = load("supabase/functions/_shared/api.ts");
await assert.rejects(sharedApi.completeUsage("30000000-0000-4000-8000-000000000001", "completed"), (error) => error.code === "USAGE_LOG_FAILED");
const usageFailed = await request({ action: "note_polish", text: "一个晴朗的日子" });
assert.equal(usageFailed.status, 200);
assert.equal(usageFailed.body.data.persisted, false);
assert.ok(usageFailed.body.data.recoveryToken, "Completion failure can retry without another generation");
const beforeInvalid = { upstreamCalls, quotaCalls, storeCalls };
const invalidRetry = await request({ action: "retry_save", recoveryToken: "invalid.token" });
assert.equal(invalidRetry.status, 400);
assert.deepEqual({ upstreamCalls, quotaCalls, storeCalls }, beforeInvalid);
failUpstream = true;
const upstreamFailed = await request({ action: "note_polish", text: "无法响应" });
assert.equal(upstreamFailed.status, 503);
assert.equal(upstreamFailed.body.error.code, "AI_UNAVAILABLE", "A usage log failure must not mask the original upstream error");
currentUser = otherId;
const callsBeforeOwnerRace = { upstreamCalls, quotaCalls, storeCalls };
const changedOwner = await request({ action: "note_polish", text: "原账号草稿", expectedOwner: ownId });
assert.equal(changedOwner.status, 409);
assert.equal(changedOwner.body.error.code, "ACCOUNT_CHANGED");
assert.deepEqual({ upstreamCalls, quotaCalls, storeCalls }, callsBeforeOwnerRace, "Changed JWT owner is rejected before quota, cache or upstream use");
currentUser = ownId;

failUsage = false; failStore = false; failUpstream = false;
for (const mode of ["headers", "body"]) {
  upstreamMode = mode;
  const before = { upstreamCalls, quotaCalls, storeCalls, completions: completedUsage.length };
  const deadlineResponse = await request({ action: "note_polish", text: "完整响应必须限时" });
  assert.equal(deadlineResponse.status, 504);
  assert.equal(deadlineResponse.body.error.code, "AI_TIMEOUT");
  assert.equal(upstreamCalls - before.upstreamCalls, 1);
  assert.equal(quotaCalls - before.quotaCalls, 1, "Timeout consumes its one reserved attempt, without re-reserving or refunding");
  assert.equal(storeCalls, before.storeCalls, "A timeout never writes AI content or cache");
  assert.equal(completedUsage.length - before.completions, 1);
  assert.equal(completedUsage.at(-1).p_status, "upstream_error");
  assert.equal(lastUpstreamSignal.aborted, true);
  assert.equal(liveTimers.size, 0, "Deadline timer is cleared even when the transport ignores abort");
}
for (const value of [null, 7, "wrong envelope", [], true]) {
  upstreamMode = "json"; upstreamJson = value;
  const invalidEnvelope = await request({ action: "note_polish", text: "上游格式异常" });
  assert.equal(invalidEnvelope.status, 503);
  assert.equal(invalidEnvelope.body.error.code, "AI_UNAVAILABLE");
  assert.equal(liveTimers.size, 0);
}
upstreamMode = "malformed";
assert.equal((await request({ action: "note_polish", text: "非 JSON 响应" })).body.error.code, "AI_UNAVAILABLE");
assert.equal(liveTimers.size, 0);
upstreamMode = "network";
const logsBeforeNetwork = errorLogs.length;
const networkFailure = await request({ action: "note_polish", text: "网络故障不暴露密钥" });
assert.equal(networkFailure.status, 503);
assert.equal(JSON.stringify(networkFailure).includes(fakeSecret), false);
assert.equal(JSON.stringify(errorLogs.slice(logsBeforeNetwork)).includes(fakeSecret), false, "Provider transport messages are sanitized before shared API logging");
assert.equal(liveTimers.size, 0);
upstreamMode = "normal";

// Independent audit F04: validate the model's inner JSON, not just its envelope.
for(const value of [null,[],true,42,"text"]) {
  upstreamMode="json";upstreamJson={choices:[{message:{content:JSON.stringify(value)}}]};
  const before={upstreamCalls,quotaCalls,storeCalls,completions:completedUsage.length};
  const invalid=await request({action:"expense_parse",text:"午饭十美元"});
  assert.equal(invalid.status,502);assert.equal(invalid.body.error.code,"AI_INVALID_OUTPUT");
  assert.equal(storeCalls,before.storeCalls);assert.equal(upstreamCalls-before.upstreamCalls,1);assert.equal(quotaCalls-before.quotaCalls,1);
  assert.equal(completedUsage.length-before.completions,1);assert.equal(completedUsage.at(-1).p_status,"failed");
}
upstreamMode="json";upstreamJson={choices:[{message:{content:JSON.stringify({amount:10,currency:"USD",category:"food"})}}]};
assert.equal((await request({action:"expense_parse",text:"午饭十美元"})).body.data.result.amount,10);
upstreamMode="normal";
// F07: both documented route inputs work; malformed partial inputs cost nothing.
for(const body of [{query:"从UCSB去LAX怎么走"},{origin:"UCSB",destination:"LAX"},{origin:"UCSB",destination:"LAX",query:"公共交通路线"}]) assert.equal((await request({action:"route",...body})).status,200);
for(const body of [{},{origin:"UCSB"},{destination:"LAX",query:"怎么走"},{query:"x".repeat(501)},{origin:"x".repeat(121),destination:"LAX"},{query:"怎么走",departureTime:"x".repeat(81)}]) {
  const before={upstreamCalls,quotaCalls};assert.equal((await request({action:"route",...body})).status,400);assert.deepEqual({upstreamCalls,quotaCalls},before);
}
// F01: incomplete plan after a server cap cannot accidentally authorize recap.
pageCap=137;
recordRows=Array.from({length:1001},(_,index)=>({id:String(index).padStart(6,"0"),trip_id:trip.id,record_type:"trip",plan_status:index===1000?"planned":"completed",event_at:"2026-10-01T00:00:00Z"}));
const beforeRecap={upstreamCalls,quotaCalls};
assert.equal((await request({action:"trip_recap",tripId:trip.id})).body.error.code,"TRIP_NOT_FINISHED");assert.deepEqual({upstreamCalls,quotaCalls},beforeRecap);
recordRows=recordRows.map(row=>({...row,plan_status:"completed",record_type:"expense",amount:1,currency:"USD",expense_category:"food"}));
trip.end_date="2020-01-02"; // A finished trip may legitimately contain only expenses.
const completeRecap=await request({action:"trip_recap",tripId:trip.id});assert.equal(completeRecap.status,200);
const aggregate=JSON.parse(lastRequestBody.messages[1].content);assert.equal(aggregate.recordCount,1001);assert.equal(aggregate.expenseTotals.USD,1001);
trip.end_date="2030-12-31";
recordRows=recordRows.map(row=>({...row,record_type:"trip",content:row.id,plan_status:"planned",transport_type:null,transport_details:null,schedule_details:null,event_at:new Date().toISOString()}));
dailyCache.clear();failRecordPage=true;
const beforePageFailure={upstreamCalls,quotaCalls,storeCalls};
assert.equal((await request({action:"daily_summary"})).body.error.code,"DATA_UNAVAILABLE");assert.deepEqual({upstreamCalls,quotaCalls,storeCalls},beforePageFailure);
recordRows=[hotel];pageCap=500;failRecordPage=false;

// Browser helper tests use an isolated storage map and function stub. They do
// not read a real session, local browser cache, or invoke a cloud function.
const browserStorage = new Map();
let browserOwner = ownId;
let browserCalls = 0;
let browserRetryFails = false;
let storageFails = false;
let switchBeforeJwt = false;
let switchWhileInflight = false;
let switchAfterSessionRead = false;
const browserClient = {
  auth: { getSession: async () => {
    const id = browserOwner;
    if (switchAfterSessionRead) { switchAfterSessionRead = false; browserOwner = otherId; }
    return { data: { session: { user: { id } } } };
  } },
  functions: { invoke: async (_name, { body }) => {
    browserCalls += 1;
    if (body.action === "retry_save") return browserRetryFails ? { data: { error: { message: "save refused" } }, error: null } : { data: { data: { persisted: true } }, error: null };
    if (switchBeforeJwt) { switchBeforeJwt = false; browserOwner = otherId; }
    if (body.expectedOwner !== browserOwner) return { data: { error: { message: "账号已切换" } }, error: null };
    if (switchWhileInflight) { switchWhileInflight = false; browserOwner = otherId; }
    return { data: { data: { action: body.action, result: "保留的内容", persisted: false, warning: "待保存", recoveryToken: "mock.token", generatedAt: new Date().toISOString() } }, error: null };
  } }
};
const browserExports = {};
const browserCode = ts.transpileModule(readFileSync("src/lib/ai.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
runInNewContext(browserCode, { ...sandbox, exports: browserExports,
  localStorage: { getItem: (key) => browserStorage.get(key) || null, setItem: (key, value) => { if (storageFails) throw new Error("quota full"); browserStorage.set(key, value); } },
  window: { dispatchEvent() {} }, CustomEvent: class { constructor(type) { this.type = type; } },
  require: (name) => name === "./supabase" ? { supabase: browserClient } : { edgeFunctionMessage: async (_error, fallback) => fallback }
});
const firstLocal = await browserExports.generateTripRecap("trip-a");
assert.equal(firstLocal.result, "保留的内容");
assert.equal(browserExports.pendingAiRecoveries(ownId).length, 1);
assert.equal(browserExports.pendingAiRecoveries(otherId).length, 0);
await browserExports.generateTripRecap("trip-a");
assert.equal(browserCalls, 1, "Viewing a pending recap does not generate/charge again");
browserOwner = otherId;
await assert.rejects(browserExports.retryAiPersistence(ownId));
assert.equal(browserCalls, 1);
browserOwner = ownId;
browserRetryFails = true;
const failedRetry = await browserExports.retryAiPersistence(ownId);
assert.equal(failedRetry.remaining, 1);
assert.equal(browserExports.pendingAiRecoveries(ownId)[0].result, "保留的内容");
browserRetryFails = false;
const localSaved = await browserExports.retryAiPersistence(ownId);
assert.equal(localSaved.saved, 1);
assert.equal(localSaved.remaining, 0);
frozenNow=Date.parse("2026-09-30T15:59:00Z");
await browserExports.generateDailySummary("la:2026-09-30");
const callsAfterOneDay = browserCalls;
frozenNow=Date.parse("2026-09-30T16:01:00Z");
await browserExports.generateDailySummary("la:2026-09-30");
assert.equal(browserCalls, callsAfterOneDay);
await browserExports.generateDailySummary("la:2026-10-01");
assert.equal(browserCalls, callsAfterOneDay + 1, "A new trip-local day does not reuse the earlier local copy");
frozenNow=undefined;
storageFails = true;
const unsavedLocal = await browserExports.polishNote("原文");
assert.equal(unsavedLocal.result, "保留的内容");
assert.ok(unsavedLocal.warning.includes("立即复制"));
storageFails = false;
browserOwner = ownId;
switchAfterSessionRead = true;
const callsBeforeSessionRace = browserCalls;
await assert.rejects(browserExports.polishNote("切换前"), /账号已切换/);
assert.equal(browserCalls, callsBeforeSessionRace, "A switch noticed before invoke does not send the request");
browserOwner = ownId;
switchBeforeJwt = true;
const ownerCopiesBefore = browserExports.pendingAiRecoveries(ownId).length;
await assert.rejects(browserExports.polishNote("JWT切换"), /账号已切换/);
assert.equal(browserExports.pendingAiRecoveries(ownId).length, ownerCopiesBefore, "A newer JWT response is never backed up under the previous user");
browserOwner = ownId;
switchWhileInflight = true;
await assert.rejects(browserExports.polishNote("请求期间切换"), /账号已切换/);
assert.equal(browserExports.pendingAiRecoveries(ownId).length, ownerCopiesBefore + 1, "A previously validated owner's failed cloud save remains isolated under that owner");
assert.equal(browserExports.pendingAiRecoveries(otherId).length, 0, "Old-account content is neither returned nor stored under the new account");
console.log("PASS: mixed-currency statistics; trip-local midnight/DST/calendar context; hotel checkout/checkin/staying/all-day and inbound flight projection; Gambier midnight respects both LA DST occurrence choices and omits unselected ambiguity; slow headers/body settle as AI_TIMEOUT with one charged attempt and cleared timers; malformed/non-object JSON stays AI_UNAVAILABLE; scoped signed recovery validation; Edge cache failure preserves content; authenticated save-only retry consumes zero additional quota/upstream; cache-read failure avoids duplicate generation; usage completion failures are checked; owner switches before JWT/in-flight never consume or expose a different account's result.");

````

## scripts/test-airlines.mjs

<!-- source: scripts/test-airlines.mjs sha256: 67d8a88954f752b4458ec09cb7c7175b9709cfb5d5b963ad92e791167b4fce2b encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(readFileSync("src/lib/airlines.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const api = {};
runInNewContext(code, { exports: api });
assert.ok(api.AIRLINES.length >= 100);
assert.equal(new Set(api.AIRLINES.map(a => a.iata)).size, api.AIRLINES.length);
for (const airline of api.AIRLINES) {
  assert.match(airline.iata, /^[A-Z0-9]{2}$/);
  assert.equal(api.resolveAirline(airline.name).iata, airline.iata);
  assert.equal(api.resolveAirline(airline.iata).iata, airline.iata);
  assert.equal(api.resolveAirline(airline.nameEn).iata, airline.iata);
  assert.equal(api.completeFlightNumber("001", airline.name), `${airline.iata}001`);
  assert.equal(api.flightNumberInput(`${airline.iata}001`, airline.name), "001");
}
for (const [query, iata] of [["ANA", "NH"], ["全日空", "NH"], ["国泰", "CX"], ["美联航", "UA"], ["長榮航空", "BR"], ["春秋", "9C"], ["靛蓝", "6E"], ["Air France", "AF"], ["starLux", "JX"]]) assert.equal(api.resolveAirline(query).iata, iata);
assert.ok(api.searchAirlines("亚洲航空").length >= 3);
assert.ok(api.searchAirlines("delta").some(a => a.iata === "DL"));
assert.ok(api.searchAirlines("").length <= 12);
for (const [input, airline, output] of [["105", "ANA", "NH105"], ["００１", "国泰", "CX001"], ["123A", "春秋", "9C123A"], ["nh 105", "ANA", "NH105"], ["UA105", "ANA", "UA105"], ["9C001", "ANA", "9C001"], ["6E001", "靛蓝", "6E001"], ["", "ANA", ""], ["105", "未收录航空", "105"], ["ZZ105", "未收录航空", "ZZ105"]]) assert.equal(api.completeFlightNumber(input, airline), output);
assert.equal(api.flightNumberInput("NH105", "United Airlines"), "NH105");
assert.equal(api.isCompleteFlightNumber("105"), false);
assert.equal(api.isCompleteFlightNumber("NH"), false);
assert.equal(api.isCompleteFlightNumber("12345"), false);
assert.equal(api.isCompleteFlightNumber("6E001"), true);
assert.equal(api.isCompleteFlightNumber("9C123A"), true);
console.log(`PASS: ${api.AIRLINES.length} airline mappings, alias search, numeric/alphanumeric codes, leading zeros, full-number preservation and input validation.`);

````

## scripts/test-audit-regressions.mjs

<!-- source: scripts/test-audit-regressions.mjs sha256: a56f63b6d3fded638c99483c5748c88e2dcde97de56b07c02afc24f7f655ebbe encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Actual source, isolated cloud and cache substitutes. Never use real projects.
const sourceRoot=process.env.LIFE_TRACKER_AUDIT_SOURCE||process.cwd();
function loader(stubs={},globals={}) {
  const modules=new Map();
  function load(file) {
    file=resolve(sourceRoot,file);if(!/\.[cm]?[jt]sx?$/.test(file))file+=".ts";
    if(stubs[file])return stubs[file];if(modules.has(file))return modules.get(file);
    const exports={};modules.set(file,exports);
    const code=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    runInNewContext(code,{exports,Date,Intl,Error,console,crypto,Request,Response,...globals,require:dependency=>dependency.startsWith("jsr:")?{}:load(resolve(dirname(file),dependency))},{filename:file});return exports;
  }
  return load;
}
const id=index=>String(index).padStart(6,"0"),owner="test-owner";
let cap=137,failTable="",pageCalls=[],snapshot={marker:"complete previous cache"},cacheWrites=0,mutatePage=false,drafts=[];
const rows=Array.from({length:1001},(_,index)=>({id:id(index),user_id:owner,record_type:"expense",content:id(index),amount:1,currency:"USD",expense_category:"food",event_at:"2026-10-02T01:00:00Z",transport_type:null,transport_details:null}));
const datasets={records:rows,trips:rows.map(row=>({id:row.id,user_id:owner,name:row.id,start_date:"2026-10-02",end_date:"2026-10-03",timezone:"UTC",archived_at:null})),exchange_rates:rows.map(row=>({id:row.id,user_id:owner,rate:1,rate_date:"2026-10-02",base_currency:"JPY",quote_currency:"USD"})),changelogs:[]};
datasets.changelogs=rows.map((row,index)=>({id:row.id,version:`0.${index}.0`,summary:[],created_at:"2026-10-02T00:00:00Z"}));
function query(table) {
  let after=null,limit=Infinity,order="id",ascending=true;
  const filters=new Map();
  const chain={select(){return chain;},eq(key,value){filters.set(key,value);return chain;},is(){return chain;},order(key,options){order=key;ascending=options?.ascending!==false;return chain;},limit(value){limit=value;return chain;},gt(key,value){assert.equal(key,"id");after=value;return chain;},maybeSingle:async()=>({data:table==="profiles"?{user_id:owner}:table==="user_settings"?{user_id:owner,theme:"dark",base_currency:"USD"}:null,error:null}),then(yes,no){return answer().then(yes,no);}};
  async function answer(){
    pageCalls.push({table,after});if(table!=="changelogs")assert.equal(filters.get("user_id"),owner,"Every page remains owner-scoped");
    if(failTable===table&&after)return {data:null,error:{code:"08006",message:"second page failed"}};
    if(mutatePage&&table==="records"&&after){datasets.records=datasets.records.filter(row=>row.id!==id(0));datasets.records.find(row=>row.id===id(800)).event_at="2020-01-01T00:00:00Z";mutatePage=false;}
    const result=datasets[table].filter(row=>!after||row.id>after).sort((a,b)=>String(a[order]).localeCompare(String(b[order]))*(ascending?1:-1)).slice(0,Math.min(cap,limit));
    return {data:result,error:null};
  }
  return chain;
}
const browserClient={from:query,auth:{getSession:async()=>({data:{session:{user:{id:owner},access_token:"synthetic-token"}}})}};
const dataModule=loader({[resolve(sourceRoot,"src/lib/supabase.ts")]:{supabase:browserClient},[resolve(sourceRoot,"src/lib/offline.ts")]:{listMutations:async()=>drafts,saveSnapshot:async value=>{snapshot=value;cacheWrites++;},loadSnapshot:async()=>snapshot}})("src/lib/data.ts");
const loaded=await dataModule.fetchAppData({id:owner,email:"test@example.invalid",user_metadata:{}});
assert.equal(loaded.records.length,1001);assert.equal(loaded.trips.length,1001);assert.equal(loaded.rates.length,1001);
assert.equal(loaded.changelogs.filter(row=>row.version.startsWith("0.")).length,1001);
assert.equal(loaded.records.reduce((sum,row)=>sum+row.amount,0),1001);assert.equal(snapshot.records.length,1001);assert.equal(cacheWrites,1);
assert.ok(pageCalls.filter(page=>page.table==="records").length>2,"A cap lower than requested limit does not imply end of collection");
const retainedSnapshot=snapshot;failTable="records";
await assert.rejects(dataModule.fetchAppData({id:owner,user_metadata:{}}));assert.equal(snapshot,retainedSnapshot);assert.equal(cacheWrites,1,"Partial successful pages never replace full local cache");
failTable="";mutatePage=true;
const duringUpdate=await dataModule.fetchAppData({id:owner,user_metadata:{}});assert.equal(duringUpdate.records.length,1001,"Deleting a previously read ID / moving a display date does not shift offset pages");
assert.ok(duringUpdate.records.some(row=>row.id===id(800)));
drafts=[{table:"records",entityId:"failed-draft",state:"failed",payload:{...rows[0],id:"failed-draft",content:"unsaved"}},{table:"records",entityId:"legacy-draft",legacy:true,state:"failed",payload:{...rows[0],id:"legacy-draft"}}];
const withFailure=await dataModule.fetchAppData({id:owner,user_metadata:{}});assert.ok(withFailure.records.some(row=>row.id==="failed-draft"));assert.ok(!withFailure.records.some(row=>row.id==="legacy-draft"));
console.log("PASS F01/F02: 1001-row records/trips/rates below configurable cap, owner filters, incomplete read retains full cache, immutable cursors survive display-date/deletion updates, failed drafts remain visible while legacy copies stay quarantined.");

class ApiError extends Error {constructor(code,message,status=400){super(message);this.code=code;this.status=status;}}
let quotaFailure="",quotaTier="owner",quotaCalls=[];
const fixedNow=Date.parse("2026-10-02T03:00:00Z");
class Clock extends Date {constructor(...args){super(...(args.length?args:[fixedNow]));}static now(){return fixedNow;}}
function quotaQuery(table){
  let after=null,keys=[];
  const chain={select(){return chain;},eq(){return chain;},is(){return chain;},gte(){return chain;},in(_key,value){keys=value;return chain;},gt(key,value){if(key==="bucket_key")after=value;return chain;},order(){return chain;},limit(){return chain;},maybeSingle(){return answer(true);},then(yes,no){return answer(false).then(yes,no);}};
  async function answer(single){
    quotaCalls.push(table);const error=quotaFailure===table?{message:"database unavailable"}:null;
    if(error)return {data:null,count:null,error};
    if(table==="api_entitlements")return {data:quotaTier?{tier:quotaTier}:null,error:null};
    if(table==="api_cooldowns")return {data:null,error:null};
    if(table==="api_usage_events")return {data:null,count:18,error:null};
    assert.equal(table,"api_quota_buckets");assert.equal(single,false);
    return {data:keys.sort().filter(key=>!after||key>after).slice(0,2).map(key=>({id:key,bucket_key:key,used_value:key.includes("aviation:global:")?18:0,limit_value:100,period_end:"2026-10-31T16:00:00Z"})),error:null};
  }
  return chain;
}
const mockApi={admin:()=>({from:quotaQuery}),ApiError,authenticatedUser:async()=>({id:owner}),requestOrigin:()=>"http://localhost",preflight:()=>null,json:(_origin,_id,body)=>new Response(JSON.stringify(body)),errorResponse:(_origin,_id,error)=>new Response(JSON.stringify({error:{code:error.code||"INTERNAL_ERROR"}}),{status:error.status||503})};
const quotaLoad=loader({[resolve(sourceRoot,"supabase/functions/_shared/api.ts")]:mockApi},{Date:Clock});
const quota=quotaLoad("supabase/functions/get-api-quota/index.ts").default;
const quotaRequest=async()=>{const response=await quota.fetch(new Request("http://localhost/quota"));return {status:response.status,body:await response.json()};};
const goodQuota=await quotaRequest();assert.equal(goodQuota.status,200);assert.equal(goodQuota.body.data.tier,"owner");assert.equal(goodQuota.body.data.aviation.globalRemaining,82);
for(const table of ["api_entitlements","api_quota_buckets","api_cooldowns","api_usage_events"]){quotaFailure=table;const result=await quotaRequest();assert.equal(result.status,503);assert.equal(result.body.error.code,"DATA_UNAVAILABLE");assert.equal(result.body.data,undefined);}
quotaFailure="";quotaTier=null;assert.equal((await quotaRequest()).body.data.tier,"standard","Successful no entitlement defaults to standard, unlike a failed query");
const period=quotaLoad("supabase/functions/_shared/quotaPeriod.ts").shanghaiPeriod;
for(const [instant,end] of [["2026-10-02T00:00:00Z","2026-10-31T16:00:00.000Z"],["2026-02-15T00:00:00Z","2026-02-28T16:00:00.000Z"],["2024-02-15T00:00:00Z","2024-02-29T16:00:00.000Z"],["2026-04-01T00:00:00Z","2026-04-30T16:00:00.000Z"],["2026-12-31T00:00:00Z","2026-12-31T16:00:00.000Z"]])assert.equal(period(new Date(instant)).monthEnd,end);
assert.equal(period(new Date("2026-09-30T15:59:59Z")).month,"2026-09");assert.equal(period(new Date("2026-09-30T16:00:00Z")).month,"2026-10");
console.log("PASS F05/F06: independent entitlement/bucket/cooldown/count failures return DATA_UNAVAILABLE without fabricated balance; successful no-row default; Shanghai long/short/leap/December month boundaries.");

````

## scripts/test-calendar-and-sync.mjs

<!-- source: scripts/test-calendar-and-sync.mjs sha256: 586829d9a0319d1a2b1100aac9ef7d9b0498a4db37eeed6a379bc6804aed551f encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import path from "node:path";
import * as idb from "idb";
import ts from "typescript";

// Only disposable IndexedDB data and pure/mock writes; no Supabase or upstream API.
const toolsPath = process.env.LIFE_TRACKER_TEST_TOOLS || "/private/tmp/life-tracker-audit-tools-20261001/node_modules";
const fake = await import("fake-indexeddb").catch(error => {
  if(error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return import(pathToFileURL(path.join(toolsPath, "fake-indexeddb/build/esm/index.js")));
});
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const modules = new Map();
let frozenNow;
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : frozenNow == null ? [] : [frozenNow])); }
  static now() { return frozenNow ?? Date.now(); }
}
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const exports = {};
  const code = ts.transpileModule(readFileSync(name === "flightTime" ? "supabase/functions/_shared/flightTime.ts" : `src/lib/${name}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date: TestDate, Intl, crypto, TypeError, Error, console, ...fake, require: dependency => dependency === "idb" ? idb : load(dependency.endsWith("_shared/flightTime") ? "flightTime" : dependency.slice(2)) });
  modules.set(name, exports);
  return exports;
}

const calendar = load("calendar"), match = load("flightMatchState"), engine = load("syncEngine");
const trip = { id: "trip", timezone: "America/Los_Angeles", start_date: "2026-10-01", end_date: "2026-11-05" };
assert.equal(calendar.tripToday(trip, new Date("2026-10-01T02:00:00Z")), "2026-09-30");
assert.equal(calendar.tripToday({ timezone: "Asia/Tokyo" }, new Date("2026-10-01T02:00:00Z")), "2026-10-01");
assert.equal(calendar.validTimeZone("Invalid/Zone"),false);
assert.equal(calendar.tripToday({timezone:"Invalid/Zone"},new Date("2026-10-01T02:00:00Z")),"2026-10-01","Legacy invalid timezone uses explicit UTC fallback instead of crashing");
assert.equal(calendar.activeTrip([trip], new Date("2026-10-01T02:00:00Z")), undefined);
assert.equal(calendar.tripDayNumber({ ...trip, start_date: "2026-11-01" }, new Date("2026-11-02T08:01:00Z")), 2, "DST fallback is one calendar day, not 25-hour rounding");
assert.equal(calendar.tripDayNumber({ ...trip, start_date: "2026-03-08" }, new Date("2026-03-09T07:01:00Z")), 2, "DST forward is one calendar day");
const record = (id, event_at, extra = {}) => ({ id, user_id: "A", record_type: "trip", content: id, event_at, trip_id: trip.id, plan_status: "planned", ...extra });
const stop = (date, time, timezone, iata) => ({ date, time, timezone, iata, airport: iata, terminal: "" });
const flight = { airline: "ANA", flight_number: "NH105", departure: stop("2026-09-28", "00:50", "America/Los_Angeles", "LAX"), arrival: stop("2026-09-29", "05:00", "Asia/Tokyo", "HND"), seat: "22A" };
const groups = calendar.groupTimeline([
  record("30", "2026-09-30T10:00:00Z", { record_type: "note", trip_id: null }),
  record("28", "2026-09-29T08:00:00Z", { transport_type: "flight", transport_details: flight }),
  record("29", "2026-09-29T00:00:00Z", { record_type: "note", trip_id: null }),
], "UTC");
assert.equal(groups.map(([date]) => date).join(","), "2026-09-30,2026-09-29,2026-09-28");
const hotel = record("hotel", "2026-09-30T15:00:00Z", { schedule_details: { kind: "hotel", start_date: "2026-10-01", end_date: "2026-10-03", timezone: "Asia/Tokyo", title: "Stay", location: "Tokyo" } });
assert.equal(calendar.plansForDay([hotel], { ...trip, timezone: "Asia/Tokyo" }, "2026-10-02").length, 1, "Hotel continuation is present");
const inboundTrip = { ...trip, timezone: "Asia/Tokyo", start_date: "2026-09-29" };
assert.equal(calendar.plansForDay([record("inbound", "2026-09-28T07:50:00Z", { transport_type: "flight", transport_details: flight })], inboundTrip, "2026-09-29").length, 1);
assert.equal(calendar.plansForDay([record("cancelled", "2026-10-01T12:00:00Z", { plan_status: "cancelled" })], trip, "2026-10-01").length, 0);

const matched = record("flight", "2026-09-28T07:50:00Z", { transport_type: "flight", transport_details: flight, flight_plan_version: 4, actual_match_plan_version: 4, actual_info_matched: true, actual_info: { flight_number: "NH105", departure: { iata: "LAX", scheduled: { date: "2026-09-28" } }, arrival: { iata: "HND" } } });
assert.equal(match.flightMatchIsCurrent(matched), true);
assert.equal(match.flightMatchIsCurrent({ ...matched, flight_plan_version: 5 }), false);
assert.equal(match.invalidateChangedFlight(matched, { ...matched, transport_details: { ...flight, seat: "18K" } }).actual_info_matched, true);
for (const changed of [{ ...flight, flight_number: "NH999" }, { ...flight, departure: { ...flight.departure, time: "01:50" } }, { ...flight, arrival: { ...flight.arrival, iata: "NRT" } }]) assert.equal(match.invalidateChangedFlight(matched, { ...matched, transport_details: changed }).actual_info_matched, false);

// Legacy entries are quarantined, including entries without an attributable owner.
const old = await idb.openDB("life-tracker", 1, { upgrade(db) { db.createObjectStore("snapshots", { keyPath: "userId" }); const box = db.createObjectStore("outbox", { keyPath: "id" }); box.createIndex("by-created", "createdAt"); } });
await old.put("outbox", { id: "legacy-A", table: "records", operation: "upsert", payload: { id: "old", user_id: "A", content: "old offline" }, createdAt: "2020-01-01" });
await old.put("outbox", { id: "legacy-unknown", table: "records", operation: "upsert", payload: { id: "unknown" }, createdAt: "2020-01-01" });
old.close();
const box = load("offline");
await box.saveSnapshot({userId:"A",records:[{content:"A private cache"}],savedAt:"2026-10-01"});
await box.saveSnapshot({userId:"B",records:[{content:"B private cache"}],savedAt:"2026-10-01"});
assert.equal((await box.loadSnapshot("A")).records[0].content,"A private cache");
assert.equal((await box.loadSnapshot("B")).records[0].content,"B private cache");
assert.equal((await box.listMutations("A"))[0].legacy, true);
assert.equal((await box.listMutations(""))[0].state, "failed");
await box.retryFailedMutations("A");
assert.equal((await box.listMutations("A"))[0].state, "failed");
await assert.rejects(box.queueMutation({ ownerId: "B", table: "records", operation: "upsert", payload: { id: "cross", user_id: "A" }, expectedUpdatedAt: null }), /其他账号/);

const queue = (ownerId, id, content, expectedUpdatedAt = null) => box.queueMutation({ ownerId, table: "records", operation: "upsert", payload: { user_id: ownerId, id, content }, expectedUpdatedAt });
const a = await queue("A", "a", "A draft"), b = await queue("B", "b", "B draft");
assert.equal((await box.listMutations("B")).length, 1);
assert.equal((await box.listMutations("B"))[0].id, b.id);
let owner = "B", writes = 0;
const adapter = { currentOwner: async () => owner, claim: box.claimMutation, finish: box.finishMutation, fail: box.failMutation, write: async item => { writes++; return { data: { ok: true, row: { ...item.payload, updated_at: "2026-10-01T00:00:01.000Z" } }, error: null }; } };
assert.equal(await engine.replayMutation(a, adapter), null);
assert.equal(writes, 0, "Wrong account is not sent to the server");
assert.equal((await engine.replayMutation(b, adapter)).state, "confirmed");
assert.equal((await box.listMutations("B")).length, 0);
owner = "A";
const rls = await engine.replayMutation(a, { ...adapter, write: async () => ({ data: null, error: { code: "42501", message: "RLS denied" } }) });
assert.equal(rls.state, "failed"); assert.match(rls.error, /权限/);
const good = await queue("A", "good", "good");
assert.equal((await engine.replayMutation(good, adapter)).state, "confirmed", "A permanent failure does not block a different record");
const network = await queue("A", "network", "offline");
assert.equal((await engine.replayMutation(network, { ...adapter, write: async () => { throw new TypeError("Failed to fetch"); } })).state, "pending");
const conflict = await queue("A", "conflict", "local v1", "v1");
assert.equal((await engine.replayMutation(conflict, { ...adapter, write: async () => ({ data: { ok: false, code: "CONFLICT" }, error: null }) })).state, "conflict");
assert.equal((await box.listMutations("A")).find(item => item.id === conflict.id).payload.content, "local v1");

const first = await queue("A", "chain", "first", "old-version");
const coalesced = await queue("A", "chain", "second", "bogus-version");
assert.notEqual(coalesced.id, first.id); assert.equal(coalesced.expectedUpdatedAt, "old-version");
const claimed = await box.claimMutation(coalesced.id, "A");
assert.ok(claimed); assert.equal(await box.claimMutation(coalesced.id, "A"), null, "Only one tab can claim a mutation");
const child = await queue("A", "chain", "third", "old-version");
assert.equal(child.dependsOn, coalesced.id); assert.equal(await box.claimMutation(child.id, "A"), null);
await box.finishMutation(claimed, { updated_at: "new-version" });
const next = (await box.listMutations("A")).find(item => item.id === child.id);
assert.equal(next.dependsOn, null); assert.equal(next.expectedUpdatedAt, "new-version");

// Timestamp ties must not reorder dependencies, nor may coalescing erase a parent.
frozenNow=Date.parse("2026-10-01T10:00:00Z");
const tieParent=await queue("A","tied-chain","parent","v0");
const tieClaimed=await box.claimMutation(tieParent.id,"A");
const tieChild=await queue("A","tied-chain","child","v0");
const tieLast=await queue("A","tied-chain","last","v0");
assert.equal(tieLast.dependsOn,tieParent.id,"Coalescing the pending leaf preserves its inflight parent");
assert.equal((await box.listMutations("A")).some(item=>item.id===tieChild.id),false,"Unsent leaf is replaced by latest draft without an extra cloud write");
assert.ok(tieLast.createdAt>tieParent.createdAt,"Queue timestamps remain monotonic under a frozen/same-millisecond clock");
await box.failMutation(tieClaimed,"pending","offline after send");
const tieNewest=await queue("A","tied-chain","newest","v0");
const tieItems=(await box.listMutations("A")).filter(item=>item.entityId==="tied-chain");
for(const item of tieItems) if(item.dependsOn) assert.ok(tieItems.some(parent=>parent.id===item.dependsOn),"Coalescing must not orphan a dependent edit");
assert.equal(tieNewest.dependsOn,tieParent.id);
assert.ok(tieItems.some(item=>item.id===tieParent.id),"A pending parent with a child must not be coalesced away");
frozenNow=undefined;

// F02: foreign-entity prerequisites survive edits, reload and same-clock queues.
frozenNow=Date.parse("2026-10-02T10:00:00Z");
const relationalQueue = (table,id,payload,expectedUpdatedAt=null) => box.queueMutation({ownerId:"relations",table,operation:"upsert",payload:{id,user_id:"relations",...payload},expectedUpdatedAt});
const parentTrip=await relationalQueue("trips","new-trip",{name:"before"});
const parentPlan=await relationalQueue("records","new-plan",{trip_id:"new-trip",content:"plan"});
await relationalQueue("trips","new-trip",{name:"after"},"local-clock");
const actual=await relationalQueue("records","new-note",{trip_id:"new-trip",parent_plan_id:"new-plan",content:"actual"});
await relationalQueue("records","new-plan",{trip_id:"new-trip",content:"updated plan"},"local-clock");
assert.ok(parentPlan.relationDependencies.includes(parentTrip.id));
assert.ok(actual.relationDependencies.includes(parentPlan.id));
modules.delete("offline"); // New module/DB connection reads the durable dependencies.
const reloadedBox=load("offline"), cloud=new Map(), relationalWrites=[];
const relationalAdapter={currentOwner:async()=>"relations",claim:reloadedBox.claimMutation,finish:reloadedBox.finishMutation,fail:reloadedBox.failMutation,write:async item=>{
  relationalWrites.push(item);
  if(item.table==="records" && (!cloud.has(`trips:${item.payload.trip_id}`)||(item.payload.parent_plan_id&&!cloud.has(`records:${item.payload.parent_plan_id}`)))) return {data:null,error:{code:"P0001",message:"missing relation"}};
  const key=`${item.table}:${item.entityId}`,previous=cloud.get(key);
  assert.equal(item.expectedUpdatedAt,previous?.updated_at||null,"Only the same entity supplies CAS, never a foreign parent timestamp");
  const row={...item.payload,updated_at:`cloud-version-${relationalWrites.length}`};cloud.set(key,row);return {data:{ok:true,row},error:null};
}};
for(const item of await reloadedBox.listMutations("relations")) await engine.replayMutation(item,relationalAdapter);
assert.equal((await reloadedBox.listMutations("relations")).length,0);
assert.equal(cloud.get("trips:new-trip").name,"after");assert.equal(cloud.get("records:new-plan").content,"updated plan");
assert.ok(cloud.has("records:new-note"));
const blockedTrip=await relationalQueue("trips","blocked-trip",{name:"blocked"});
const blockedClaim=await reloadedBox.claimMutation(blockedTrip.id,"relations");
const blockedPlan=await relationalQueue("records","blocked-plan",{trip_id:"blocked-trip"});
assert.equal(await reloadedBox.claimMutation(blockedPlan.id,"relations"),null,"Inflight/leased parent blocks the child instead of causing FK failure");
await reloadedBox.failMutation(blockedClaim,"failed","RLS");
assert.equal(await reloadedBox.claimMutation(blockedPlan.id,"relations"),null,"Failed parent waits for explicit recovery");
await reloadedBox.retryFailedMutations("relations");
for(const item of await reloadedBox.listMutations("relations")) await engine.replayMutation(item,relationalAdapter);
assert.equal((await reloadedBox.listMutations("relations")).length,0);
const leasedTrip=await relationalQueue("trips","leased-trip",{name:"lease"});
await reloadedBox.claimMutation(leasedTrip.id,"relations");
const leaseChild=await relationalQueue("records","leased-plan",{trip_id:"leased-trip"});
assert.equal(await reloadedBox.claimMutation(leaseChild.id,"relations"),null);
frozenNow+=120_001;
for(const item of await reloadedBox.listMutations("relations")) await engine.replayMutation(item,relationalAdapter);
assert.equal((await reloadedBox.listMutations("relations")).length,0,"Expired parent lease can be reclaimed, then releases child without an FK failure");
frozenNow=undefined;

const switchItem = await queue("A", "switch", "pending"); let checks = 0, sent = false;
assert.equal(await engine.replayMutation(switchItem, { ...adapter, currentOwner: async () => ++checks === 1 ? "A" : "B", write: async () => { sent = true; return { data: null, error: null }; } }), null);
assert.equal(sent, false); assert.equal((await box.listMutations("A")).find(item => item.id === switchItem.id).state, "pending");
for (const error of [{ code: "42501" }, { code: "42703" }, { code: "23514" }, { code: "PGRST202" }]) assert.equal(engine.retryableWriteError(error), false);
for (const error of [{ status: 503 }, { code: "08006" }, new TypeError("Failed to fetch")]) assert.equal(engine.retryableWriteError(error), true);

// Execute the actual form handler, not a test reimplementation. A permanent
// cloud refusal must leave input intact, show its error and unlock the button.
const composerSource=readFileSync("src/components/QuickComposer.tsx","utf8");
const composerAst=ts.createSourceFile("composer.tsx",composerSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let submitHandler;
function findSubmit(node) { if(ts.isFunctionDeclaration(node)&&node.name?.text==="submit") submitHandler=node; ts.forEachChild(node,findSubmit); }
findSubmit(composerAst);
assert.ok(submitHandler);
const submitCode=ts.transpileModule(`export ${submitHandler.getText(composerAst)}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let resetCalls=0,closeCalls=0,formSaving=false,formError="",refuse=true;
const formExports={};
runInNewContext(submitCode,{exports:formExports,Error,content:"keep draft",notes:"notes",type:"note",amount:"",currency:"USD",category:"other",location:"",eventAt:"2026-10-01T10:00",toIso:()=>"2026-10-01T02:00:00Z",forcedTripId:undefined,tripId:"",parentPlanId:undefined,compact:true,
  setSaving:value=>{formSaving=value;},setSaveError:value=>{formError=value;},reset:()=>{resetCalls++;},onClose:()=>{closeCalls++;},onSave:async()=>{if(refuse)throw new Error("RLS denied; draft kept");}});
await formExports.submit({preventDefault(){}});
assert.equal(formSaving,false); assert.match(formError,/RLS denied/); assert.equal(resetCalls,0); assert.equal(closeCalls,0);
refuse=false;
await formExports.submit({preventDefault(){}});
assert.equal(formSaving,false); assert.equal(formError,""); assert.equal(resetCalls,1); assert.equal(closeCalls,1);
console.log("PASS: timezone/DST calendar, explicit timeline groups, hotel and inbound projections, flight match invalidation, IndexedDB owner isolation/quarantine/coalescing/leases/dependencies, RLS/network/conflict and account-switch replay; actual quick-record handler retains rejected drafts and unlocks saving.");

````

## scripts/test-database-integrity.mjs

<!-- source: scripts/test-database-integrity.mjs sha256: c6677ce4ba511ea6da73147fdc431f5331eb415eff7544c33b5c0d2b9e46520b encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, lstat, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir, platform, arch } from "node:os";

// Disposable local PostgreSQL, never a DATABASE_URL or a Supabase connection.
// Install the pinned test-only tools outside this project and set this directory
// when it differs. No production identities, secrets, requests or quota are used.
const toolsPath = process.env.LIFE_TRACKER_TEST_TOOLS || "/private/tmp/life-tracker-audit-tools-20261001/node_modules";
const exit = process.exit.bind(process); // Preserve a failing exit code despite embedded-postgres's exit hook.
const { default: EmbeddedPostgres } = await import("embedded-postgres").catch(error => {
  if(error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return import(pathToFileURL(path.join(toolsPath, "embedded-postgres/dist/index.js")));
});
async function hydrateSafePackageLinks() {
  const spec=`@embedded-postgres/${platform()==="win32"?"windows":platform()}-${arch()}`;
  const binaries=await import(spec).catch(error=>{if(error.code!=="ERR_MODULE_NOT_FOUND")throw error;return import(pathToFileURL(path.join(toolsPath,spec,"dist/index.js")));});
  const native=await realpath(path.dirname(path.dirname(binaries.initdb)));
  let links=[];
  try { links=JSON.parse(await readFile(path.join(native,"pg-symlinks.json"),"utf8")); } catch(error) { if(error.code!=="ENOENT")throw error; }
  for(const {source,target} of links) {
    if(typeof source!=="string"||typeof target!=="string"||!source.startsWith("native/")||!target.startsWith("native/")||source.split(/[\\/]/).includes("..")||target.split(/[\\/]/).includes("..")) throw new Error("Unsafe native package symlink metadata");
    const from=path.resolve(native,source.slice(7)),to=path.resolve(native,target.slice(7));
    if(!from.startsWith(`${native}${path.sep}`)||!to.startsWith(`${native}${path.sep}`))throw new Error("Native link escaped package");
    const sourceReal=await realpath(from);
    if(!sourceReal.startsWith(`${native}${path.sep}`))throw new Error("Native source symlink escaped package");
    try { await lstat(to); } catch(error) { if(error.code!=="ENOENT")throw error; await symlink(path.relative(path.dirname(to),from),to); }
  }
}
const parent = await mkdtemp(path.join(tmpdir(), "life-tracker-db-acceptance-"));
const logs = [];
const cluster = new EmbeddedPostgres({ databaseDir: path.join(parent, "data"), port: 55432, user: "postgres", password: "local-disposable-test-only", persistent: false, createPostgresUser: false,
  initdbFlags: ["--set=shared_memory_type=mmap", "--set=dynamic_shared_memory_type=mmap"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", `unix_socket_directories=${parent}`, "-c", "shared_memory_type=mmap", "-c", "dynamic_shared_memory_type=mmap"], onLog: message => logs.push(String(message)), onError: message => logs.push(String(message)) });
const clients = [];
async function client(role = "postgres", userId = "") {
  const value = cluster.getPgClient("postgres", "127.0.0.1"); await value.connect(); clients.push(value);
  await value.query("set timezone='UTC'"); // Never inherit a developer machine's Shanghai timezone.
  if (role !== "postgres") await value.query(`SET ROLE ${role}`);
  await value.query("SELECT set_config('request.jwt.claim.role',$1,false), set_config('request.jwt.claim.sub',$2,false)", [role, userId]);
  return value;
}
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", F = "33333333-3333-4333-8333-333333333333", O = "44444444-4444-4444-8444-444444444444";
const json = value => JSON.stringify(value);
const scalar = async (connection, sql, args = []) => (await connection.query(sql, args)).rows[0].value;
const save = (connection, table, payload, expected = null, requestId = randomUUID()) => scalar(connection, "select public.save_user_mutation($1,$2::jsonb,$3::timestamptz,$4::uuid) as value", [table, json(payload), expected, requestId]);
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);
let migrationCount = 0;
let failed = false;
try {
  await hydrateSafePackageLinks();
  await cluster.initialise(); await cluster.start();
  const admin = await client();
  await admin.query(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(), raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
    grant usage on schema auth, storage, extensions, public to anon,authenticated,service_role;
    grant execute on all functions in schema auth, storage, extensions to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
    grant all on all tables in schema auth, storage to service_role;
    alter default privileges in schema public grant all on tables to service_role;
    alter default privileges in schema public grant all on sequences to service_role;
  `);
  const migrations = (await readdir("supabase/migrations")).filter(name => name.endsWith(".sql")).sort();
  // Historical identity repair requires its Auth user to exist. Parameterize
  // only that configuration digest for a synthetic account, as required for
  // any fresh project; never create or assume a production owner identity.
  const bootstrapEmail="bootstrap-owner@example.invalid",bootstrapId=randomUUID();
  await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",[bootstrapId,bootstrapEmail]);
  const historicalOwnerHash="65a64dff94079533ab3aeecd6c5068f193532cf6f9c6c853bc76a0cdfef9df0c";
  const bootstrapHash=createHash("sha256").update(bootstrapEmail).digest("hex");
  let identityConfigurations=0;
  const legacyTripId=randomUUID(),legacyFlightId=randomUUID(),legacyStaleId=randomUUID(),legacyConfirmedId=randomUUID();
  for (const name of migrations) {
    try {
      const source=await readFile(path.join("supabase/migrations",name),"utf8");
      if(name==="20261111172418_audit_relations_and_periods.sql") await admin.query("insert into public.api_quota_buckets(bucket_key,service,quota_group,period_start,period_end,limit_value,used_value) values('aviation:global:2026-02','aviation','flight','2026-01-31T16:00:00Z','2026-02-27T16:00:00Z',100,18)");
      if(source.includes(historicalOwnerHash))identityConfigurations++;
      await admin.query(source.replaceAll(historicalOwnerHash,bootstrapHash)); migrationCount++;
      if(name==="20260715000000_release_1_4_1_owner_admin_and_quota.sql") {
        await admin.query("insert into public.trips(id,user_id,name,start_date,end_date,timezone) values($1,$2,'legacy trip','2026-09-29','2026-10-02','Asia/Tokyo')",[legacyTripId,bootstrapId]);
        const stop=(date,time,timezone,iata)=>({date,time,timezone,iata,airport:iata,terminal:""});
        const plan={airline:"ANA",flight_number:"NH105",departure:stop("2026-09-28","00:50","America/Los_Angeles","LAX"),arrival:stop("2026-09-29","05:00","Asia/Tokyo","HND")};
        const actual={flight_number:plan.flight_number,status:"landed",departure:{iata:"LAX",timezone:plan.departure.timezone,scheduled:{date:plan.departure.date,time:plan.departure.time}},arrival:{iata:"HND",timezone:plan.arrival.timezone,scheduled:{date:plan.arrival.date,time:plan.arrival.time}}};
        for(const [id,requestId,info] of [[legacyFlightId,legacyConfirmedId,actual],[legacyStaleId,randomUUID(),{...actual,flight_number:"NH999"}]]) await admin.query("insert into public.records(id,user_id,record_type,content,event_at,trip_id,plan_status,transport_type,transport_details,actual_info,actual_info_matched,actual_match_status,actual_match_request_id,actual_matched_at) values($1,$2,'trip','legacy flight','2026-09-28T07:50:00Z',$3,'completed','flight',$4::jsonb,$5::jsonb,true,'matched',$6,now())",[id,bootstrapId,legacyTripId,json(plan),json(info),requestId]);
        await admin.query("insert into public.daily_summaries(user_id,summary_date,content) values($1,'2026-09-29','old day one'),($1,'2026-09-30','old day two')",[bootstrapId]);
      }
    }
    catch (error) { throw new Error(`Migration ${name} failed: ${error.message}`, { cause: error }); }
  }
  assert.equal(identityConfigurations,2);
  const repairedBucket=await scalar(admin,"select to_jsonb(b) as value from public.api_quota_buckets b where bucket_key='aviation:global:2026-02'");
  assert.equal(new Date(repairedBucket.period_end).toISOString(),"2026-02-28T16:00:00.000Z");assert.equal(repairedBucket.used_value,18);assert.equal(repairedBucket.limit_value,100);
  assert.equal(await scalar(admin,"select tier as value from public.api_entitlements where user_id=$1",[bootstrapId]),"owner");
  const migrated=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[legacyFlightId]);
  assert.equal(migrated.actual_info_matched,true);assert.equal(Number(migrated.flight_plan_version),1);assert.equal(Number(migrated.actual_match_plan_version),1);assert.equal(migrated.actual_confirmed_request_id,legacyConfirmedId);
  const staleMigrated=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[legacyStaleId]);
  assert.equal(staleMigrated.actual_info_matched,false);assert.equal(staleMigrated.actual_info.flight_number,"NH999");assert.equal(staleMigrated.actual_confirmed_request_id,null);
  assert.equal(Number(await scalar(admin,"select count(distinct context_key) as value from public.daily_summaries where user_id=$1",[bootstrapId])),2,"Legacy Shanghai caches are retained under separate historical contexts");
  console.log("PASS: V1.4.1 legacy data upgrades without loss; only fully proven matched segment retains valid metadata, stale payload kept historical, old daily summaries isolated.");
  console.log(`PASS: ${migrationCount} complete migrations on disposable PostgreSQL ${await scalar(admin, "select current_setting('server_version') as value")}; only historical Owner identity digest configured for synthetic test user.`);
  await admin.query("insert into auth.users(id,email,email_confirmed_at) select id::uuid, 'test-'||left(id,8)||'@example.invalid', now() from unnest($1::text[]) id", [[A,B,F,O]]);
  await admin.query("update public.api_entitlements set tier=case user_id when $1::uuid then 'friend' when $2::uuid then 'owner' else tier end where user_id in($1::uuid,$2::uuid)", [F,O]);
  const a = await client("authenticated", A), b = await client("authenticated", B), service = await client("service_role");

  const id = randomUUID(), request = randomUUID(), payload = { id, user_id: A, record_type: "note", content: "initial", event_at: "2026-10-01T00:00:00Z" };
  const initial = await save(a, "records", payload, null, request);
  assert.equal(initial.ok, true); assert.equal(initial.row.content, "initial");
  assert.deepEqual(await save(a, "records", payload, null, request), initial, "Lost-response retries are idempotent");
  assert.equal(Number(await scalar(admin, "select count(*) as value from public.client_mutation_receipts where request_id=$1", [request])), 1);
  await rejectCode(save(a, "records", { ...payload, content: "reused UUID changed" }, null, request), "22023");
  await rejectCode(save(b, "records", payload), "42501");
  await rejectCode(save(b, "records", { ...payload, user_id: B }), "42501");
  await rejectCode(save(a, "api_entitlements", { user_id: A, tier: "owner" }), "42501");
  await rejectCode(save(a, "records", { ...payload, actual_info_matched: true }, initial.row.updated_at), "42501");
  assert.equal((await save(a, "records", { ...payload, content: "no version" })).code, "CONFLICT");
  const first = await save(a, "records", { ...payload, content: "device one" }, initial.row.updated_at);
  assert.equal(first.ok, true); assert.notEqual(first.row.updated_at, initial.row.updated_at);
  assert.equal((await save(a, "records", { ...payload, content: "stale device two" }, initial.row.updated_at)).code, "CONFLICT");
  assert.equal(await scalar(admin, "select content as value from public.records where id=$1", [id]), "device one");
  const concurrentA = await client("authenticated", A), concurrentB = await client("authenticated", A);
  const collision = await Promise.all([save(concurrentA, "records", { ...payload, content: "collision one" }, first.row.updated_at), save(concurrentB, "records", { ...payload, content: "collision two" }, first.row.updated_at)]);
  assert.equal(collision.filter(result => result.ok).length, 1); assert.equal(collision.filter(result => result.code === "CONFLICT").length, 1);
  assert.equal(Number(await scalar(b, "select count(*) as value from public.records where id=$1", [id])), 0, "RLS hides another user's records");
  await rejectCode(b.query("insert into public.records(user_id,record_type,content) values($1,'note','cross owner')", [A]), "42501");
  await rejectCode(b.query("select public.consume_api_quota($1,null,'route',$2)", [B,randomUUID()]), "42501");
  await rejectCode(b.query("select * from public.client_mutation_receipts"), "42501");
  await rejectCode(b.query("select * from public.api_entitlements"), "42501");
  await a.query("insert into storage.objects(bucket_id,name) values('avatars',$1)", [`${A}/test.png`]);
  await rejectCode(b.query("insert into storage.objects(bucket_id,name) values('avatars',$1)", [`${A}/other.png`]), "42501");
  assert.equal(Number(await scalar(b, "select count(*) as value from storage.objects where name=$1", [`${A}/test.png`])), 0);
  console.log("PASS: CAS create/update/conflict/idempotence/reused UUID, concurrent device writes, strict table/field ownership, account RLS and avatar path RLS.");

  // F03: changes to a parent cannot invalidate children; lock waits recheck
  // both race directions using actual independent PostgreSQL transactions.
  const tripOne=randomUUID(),tripTwo=randomUUID();
  for(const tid of [tripOne,tripTwo]) await save(a,"trips",{id:tid,user_id:A,name:tid,start_date:"2026-10-01",end_date:"2026-10-02",timezone:"UTC"});
  const planPayload=(pid)=>({id:pid,user_id:A,record_type:"trip",content:"parent",trip_id:tripOne,plan_status:"planned",event_at:"2026-10-01T00:00:00Z"});
  const parentId=randomUUID(),parentPayload=planPayload(parentId),parentSaved=await save(a,"records",parentPayload);
  await save(a,"records",{id:randomUUID(),user_id:A,record_type:"note",content:"actual",trip_id:tripOne,parent_plan_id:parentId,event_at:"2026-10-01T01:00:00Z"});
  await rejectCode(save(a,"records",{...parentPayload,trip_id:tripTwo},parentSaved.row.updated_at),"P0001");
  await rejectCode(save(a,"records",{...parentPayload,record_type:"note",plan_status:null},parentSaved.row.updated_at),"P0001");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.records c join public.records p on p.id=c.parent_plan_id where c.trip_id is distinct from p.trip_id or p.record_type<>'trip'")),0);
  const raceChild=await client("authenticated",A),raceParent=await client("authenticated",A);
  const childFirst=randomUUID(),childFirstPayload=planPayload(childFirst),childFirstSaved=await save(a,"records",childFirstPayload);
  await raceChild.query("begin");
  await save(raceChild,"records",{id:randomUUID(),user_id:A,record_type:"note",content:"race child",trip_id:tripOne,parent_plan_id:childFirst,event_at:"2026-10-01T01:00:00Z"});
  await raceParent.query("set application_name='audit-race'");
  const moveBlocked=save(raceParent,"records",{...childFirstPayload,trip_id:tripTwo},childFirstSaved.row.updated_at).then(value=>({value}),error=>({error}));
  const waitForLock=async()=>{for(let attempt=0;attempt<200;attempt++){if(Number(await scalar(admin,"select count(*) as value from pg_stat_activity where application_name='audit-race' and wait_event_type='Lock'")))return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Expected relation lock wait did not occur");};
  await waitForLock();await raceChild.query("commit");assert.equal((await moveBlocked).error?.code,"P0001");
  const parentFirst=randomUUID(),parentFirstPayload=planPayload(parentFirst),parentFirstSaved=await save(a,"records",parentFirstPayload);
  await raceParent.query("begin");await save(raceParent,"records",{...parentFirstPayload,trip_id:tripTwo},parentFirstSaved.row.updated_at);
  await raceChild.query("set application_name='audit-race'");
  const insertBlocked=save(raceChild,"records",{id:randomUUID(),user_id:A,record_type:"note",content:"stale child",trip_id:tripOne,parent_plan_id:parentFirst,event_at:"2026-10-01T01:00:00Z"}).then(value=>({value}),error=>({error}));
  await waitForLock();await raceParent.query("commit");assert.equal((await insertBlocked).error?.code,"P0001");
  console.log("PASS F03: reverse parent trip/type constraints and both child-insert/parent-move lock-wait races preserve relations.");

  // F06: execute the exact expressions used by admission, not a duplicated
  // formula; cover UTC/Shanghai sessions and long/short/leap/year boundaries.
  const quotaSource=await readFile("supabase/migrations/20261111172411_atomic_quota_admission.sql","utf8");
  const endExpression=quotaSource.match(/v_month_end := (.+);/)[1].replaceAll("now()","$1::timestamptz");
  for(const zone of ["UTC","Asia/Shanghai"]) {
    await service.query("select set_config('TimeZone',$1,false)",[zone]);
    for(const [input,expected] of [["2026-10-02T00:00:00Z","2026-10-31T16:00:00.000Z"],["2026-02-15T00:00:00Z","2026-02-28T16:00:00.000Z"],["2024-02-15T00:00:00Z","2024-02-29T16:00:00.000Z"],["2026-04-01T00:00:00Z","2026-04-30T16:00:00.000Z"],["2026-12-15T00:00:00Z","2026-12-31T16:00:00.000Z"]])assert.equal(new Date(await scalar(service,`select ${endExpression} as value`,[input])).toISOString(),expected);
  }
  await service.query("set timezone='UTC'");
  console.log("PASS F06: Shanghai month arithmetic is invariant to UTC/Shanghai database sessions; existing reset metadata corrected without changing counters.");

  // Real concurrent transactions, not a mock of the admission check.
  const workers = await Promise.all(Array.from({ length: 20 }, () => client("service_role")));
  const quota = (connection, user, feature = "route", req = randomUUID()) => scalar(connection, "select public.consume_api_quota($1::uuid,null,$2,$3::uuid) as value", [user,feature,req]);
  const burst = await Promise.all(workers.map(connection => quota(connection, F)));
  assert.equal(burst.filter(value => value.allowed).length, 10, "20 simultaneous non-owner requests admit exactly ten");
  const denied = burst.filter(value => !value.allowed);
  assert.equal(denied.every(value => value.code === "COOLDOWN"), true);
  assert.equal(Number(await scalar(admin, "select count(*) as value from public.api_usage_events where user_id=$1", [F])), 10);
  const retryDates = denied.map(value => Date.parse(value.retry_at));
  assert.ok(Math.max(...retryDates)-Math.min(...retryDates) < 2000, "Concurrent denials share one cooldown window");
  assert.ok(retryDates[0] > Date.now()+290000 && retryDates[0] < Date.now()+310000);
  assert.equal((await quota(service, B)).allowed, true, "Another user does not inherit cooldown");
  const ownerBurst = await Promise.all(workers.map(connection => quota(connection, O)));
  assert.equal(ownerBurst.every(value => value.allowed), true, "Owner remains exempt from product AI limits and burst throttle");
  const duplicate = randomUUID(); assert.equal((await quota(service, O, "route", duplicate)).allowed, true);
  assert.equal((await quota(service, O, "route", duplicate)).code, "DUPLICATE_REQUEST");
  const nineUser = randomUUID(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'nine@example.invalid',now())", [nineUser]);
  await admin.query("update public.api_entitlements set tier='friend' where user_id=$1", [nineUser]);
  for (let index=0; index<9; index++) assert.equal((await quota(service,nineUser)).allowed,true);
  const last = await Promise.all(workers.map(connection=>quota(connection,nineUser)));
  assert.equal(last.filter(value=>value.allowed).length,1,"Nine prior calls leave only one admission under concurrency");
  console.log("PASS: real 20-transaction burst race, 9-plus-parallel boundary, common five-minute cooldown, user isolation, Owner exemption and duplicate request accounting.");

  const clearAirFixture=async()=>{ await admin.query("delete from public.api_usage_events where service='aviation'; delete from public.api_quota_buckets where service='aviation'"); };
  await clearAirFixture();
  for(let index=0;index<18;index++) assert.equal((await quota(service,F,"flight_actual_match")).allowed,true);
  for(let index=0;index<82;index++) assert.equal((await quota(service,O,"flight_actual_match")).allowed,true,"Owner may use every unused provider-wide request, not just a fixed twenty");
  assert.equal((await quota(service,O,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED");
  assert.equal((await quota(service,F,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED");
  await clearAirFixture();
  for(let index=0;index<80;index++) assert.equal((await quota(service,F,"flight_actual_match")).allowed,true);
  assert.equal((await quota(service,F,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED","Non-owner shared pool never consumes the reserved twenty");
  for(let index=0;index<20;index++) assert.equal((await quota(service,O,"flight_actual_match")).allowed,true);
  await clearAirFixture();
  assert.equal((await quota(service,B,"flight_actual_match")).allowed,true);
  assert.equal((await quota(service,B,"flight_actual_match")).allowed,true);
  assert.equal((await quota(service,B,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED","Standard remains limited to two flights per Shanghai day");
  await admin.query("update public.api_quota_buckets set used_value=9999 where bucket_key like 'deepseek:light:shared:%'");
  assert.equal((await quota(service,B)).allowed,true);
  assert.equal((await quota(service,B)).code,"AI_MONTHLY_QUOTA_EXCEEDED");
  assert.equal((await quota(service,O)).allowed,true);
  assert.equal(Number(await scalar(admin,"select used_value as value from public.api_quota_buckets where bucket_key like 'deepseek:light:shared:%'")),10000,"Owner AI does not consume non-owner shared pool");
  console.log("PASS: provider-wide 100, non-owner 80, Owner borrowing/guaranteed twenty, Standard daily two and light-AI 10000 shared monthly boundary.");

  // Flight version and preview integrity RPCs are intentionally service-only.
  const tripId = randomUUID(), flightId = randomUUID();
  await save(a,"trips",{id:tripId,user_id:A,name:"Flight test",start_date:"2026-09-29",end_date:"2026-10-05",timezone:"Asia/Tokyo"});
  const stop=(date,time,timezone,iata)=>({date,time,timezone,iata,airport:iata,terminal:""});
  const details={airline:"ANA",flight_number:"NH105",departure:stop("2026-09-28","00:50","America/Los_Angeles","LAX"),arrival:stop("2026-09-29","05:00","Asia/Tokyo","HND"),seat:"22A"};
  let flight=(await save(a,"records",{id:flightId,user_id:A,record_type:"trip",content:"Flight",trip_id:tripId,plan_status:"planned",transport_type:"flight",transport_details:details,event_at:"2026-09-28T07:50:00Z"})).row;
  assert.equal(Number(flight.flight_plan_version),1);
  await rejectCode(a.query("select public.claim_flight_match_v2($1,$2,$3,$4,false)",[A,flightId,randomUUID(),1]),"42501");
  const actual={flight_number:"NH105",airline:"ANA",status:"landed",departure:{iata:"LAX",scheduled:{date:"2026-09-28",time:"00:50"}},arrival:{iata:"HND",scheduled:{date:"2026-09-29",time:"05:00"}}};
  const matchRpc=(name,user,requestId,version,info,rematch=false)=>scalar(service,`select public.${name}($1::uuid,$2::uuid,$3::uuid,$4::bigint${name==="claim_flight_match_v2"?",$5::boolean":",$5::jsonb"}) as value`,name==="claim_flight_match_v2"?[user,flightId,requestId,version,rematch]:[user,flightId,requestId,version,info==null?null:json(info)]);
  const oldRequest=randomUUID(); assert.equal((await matchRpc("claim_flight_match_v2",A,oldRequest,1)).ok,true);
  assert.equal((await matchRpc("stage_flight_match_v2",A,oldRequest,1,actual)).ok,true);
  flight=(await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]));
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...details,flight_number:"NH999"}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),2); assert.equal(flight.actual_info_matched,false);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,oldRequest,1,null)).code,"PLAN_CHANGED");
  assert.equal((await matchRpc("stage_flight_match_v2",A,oldRequest,1,actual)).code,"PLAN_CHANGED");
  assert.equal((await matchRpc("claim_flight_match_v2",B,randomUUID(),2)).code,"RECORD_NOT_FOUND");
  const newRequest=randomUUID(); assert.equal((await matchRpc("claim_flight_match_v2",A,newRequest,2)).ok,true);
  const currentActual={...actual,flight_number:"NH999"};
  assert.equal((await matchRpc("stage_flight_match_v2",A,newRequest,2,currentActual)).ok,true);
  const confirmed=await matchRpc("confirm_flight_match_v2",A,newRequest,2,null);
  assert.equal(confirmed.ok,true); assert.equal(confirmed.record.actual_info_matched,true); assert.equal(Number(confirmed.record.actual_match_plan_version),2);
  assert.equal(confirmed.record.actual_confirmed_request_id,newRequest);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,newRequest,2,null)).ok,true,"Confirmation response retries are idempotent");
  const requestB=randomUUID(),actualB={...currentActual,registration:"REMATCH-B"};
  assert.equal((await matchRpc("claim_flight_match_v2",A,requestB,2,null,true)).cached,false);
  assert.equal((await matchRpc("stage_flight_match_v2",A,requestB,2,actualB)).ok,true);
  const confirmAWhileBPending=await matchRpc("confirm_flight_match_v2",A,newRequest,2,null);
  assert.equal(confirmAWhileBPending.record.actual_confirmed_request_id,newRequest);
  assert.equal(confirmAWhileBPending.record.actual_info.registration,undefined);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.flight_match_previews where request_id=$1",[requestB])),1,"Idempotent confirmation of A must not consume pending B");
  const confirmB=await matchRpc("confirm_flight_match_v2",A,requestB,2,null);
  assert.equal(confirmB.record.actual_confirmed_request_id,requestB);assert.equal(confirmB.record.actual_info.registration,"REMATCH-B");
  assert.equal((await matchRpc("confirm_flight_match_v2",A,requestB,2,null)).record.actual_info.registration,"REMATCH-B");
  flight=confirmB.record;
  flight=(await save(a,"records",{id:flightId,user_id:A,notes:"seat only",transport_details:{...flight.transport_details,seat:"18K"}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),2); assert.equal(flight.actual_info_matched,true);
  await a.query("update public.records set actual_info_matched=false, actual_info=$1::jsonb, flight_plan_version=999,actual_confirmed_request_id=$3 where id=$2",[json({forged:true}),flightId,randomUUID()]);
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  assert.equal(Number(flight.flight_plan_version),2); assert.equal(flight.actual_info_matched,true); assert.equal(flight.actual_info.flight_number,"NH999");
  assert.equal(flight.actual_confirmed_request_id,requestB,"Authenticated raw updates cannot forge confirmed result UUID");
  const cached=await matchRpc("claim_flight_match_v2",A,randomUUID(),2); assert.equal(cached.cached,true);
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,arrival:{...flight.transport_details.arrival,time:"06:00"}}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),3); assert.equal(flight.actual_info_matched,false); assert.equal(flight.actual_match_request_id,null);
  assert.equal(flight.actual_confirmed_request_id,null);
  assert.equal(flight.actual_info.flight_number,"NH999","Historical actual payload remains preserved but not current");
  console.log("PASS: flight semantic versions, stale in-flight preview and confirm rejection, service-only RPCs, ownership, idempotent confirm, metadata retention, forged actual protection and historical payload preservation.");

  const legacyClaim=requestId=>scalar(service,"select public.claim_flight_match($1,$2,$3,false) as value",[A,flightId,requestId]);
  const legacyFinish=(requestId,info)=>scalar(service,"select public.finish_flight_match($1,$2,$3,'matched',$4::jsonb) as value",[A,flightId,requestId,json(info)]);
  const legacyInsert=(requestId,info)=>service.query("insert into public.flight_match_previews(request_id,record_id,user_id,actual_info) values($1,$2,$3,$4::jsonb)",[requestId,flightId,A,json(info)]);
  const provedActual=plan=>({flight_number:plan.flight_number,status:"landed",airline:plan.airline,departure:{iata:plan.departure.iata,timezone:plan.departure.timezone,scheduled:{date:plan.departure.date,time:plan.departure.time}},arrival:{iata:plan.arrival.iata,timezone:plan.arrival.timezone,scheduled:{date:plan.arrival.date,time:plan.arrival.time}}});
  const legacyRequest=randomUUID(); assert.equal((await legacyClaim(legacyRequest)).ok,true);
  assert.equal((await legacyFinish(legacyRequest,{forged:true})).code,"PLAN_VERSION_REQUIRED","Legacy callers cannot confirm without a version-bound preview");
  const legacyInfo=provedActual(flight.transport_details); await legacyInsert(legacyRequest,legacyInfo);
  assert.equal(Number(await scalar(admin,"select plan_version as value from public.flight_match_previews where request_id=$1",[legacyRequest])),3);
  let legacyConfirmed=await legacyFinish(legacyRequest,{flight_number:"FORGED",forged:true});
  assert.equal(legacyConfirmed.ok,true); assert.equal(legacyConfirmed.record.actual_info.flight_number,"NH999"); assert.equal(legacyConfirmed.record.actual_info.forged,undefined,"Legacy supplied payload is ignored in favor of stored proof");
  assert.equal((await legacyFinish(legacyRequest,{forged:true})).ok,true,"Legacy successful network retry is idempotent");
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...legacyConfirmed.record.transport_details,arrival:{...legacyConfirmed.record.transport_details.arrival,time:"07:00"}}},legacyConfirmed.record.updated_at)).row;
  const newerLegacyRequest=randomUUID(); assert.equal((await legacyClaim(newerLegacyRequest)).ok,true);
  await rejectCode(legacyInsert(newerLegacyRequest,legacyInfo),"23514","Old read-before-claim snapshot cannot be assigned the new version");
  await legacyInsert(newerLegacyRequest,provedActual(flight.transport_details));
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,flight_number:"NH888"}},flight.updated_at)).row;
  assert.equal((await legacyFinish(newerLegacyRequest,provedActual(flight.transport_details))).code,"PLAN_CHANGED","Legacy preview also rejects edits after staging");
  console.log("PASS: safe SQL-first legacy bridge, omitted-version proof, no-preview refusal, untrusted payload ignored, old-read/new-claim mismatch and stale legacy confirmation.");

  // Explicit UTC occurrence is part of the immutable segment, not a display
  // preference. Legacy NULL/missing choices are accepted only for unique clocks.
  assert.deepEqual(await scalar(admin,"select public.flight_local_utc_offsets('2026-11-01','01:30','America/Los_Angeles') as value"),[-420,-480]);
  assert.deepEqual(await scalar(admin,"select public.flight_local_utc_offsets('2026-04-05','01:45','Australia/Lord_Howe') as value"),[660,630]);
  assert.deepEqual(await scalar(admin,"select public.flight_local_utc_offsets('2026-03-08','02:30','America/Los_Angeles') as value"),[]);
  const repeatedDetails={...flight.transport_details,departure:{...flight.transport_details.departure,date:"2026-11-01",time:"01:30",utc_offset_minutes:-420},arrival:{...flight.transport_details.arrival,date:"2026-11-02",time:"03:30"}};
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:repeatedDetails,event_at:"2026-11-01T08:30:00Z"},flight.updated_at)).row;
  const firstVersion=Number(flight.flight_plan_version),firstOccurrence=randomUUID();
  const firstActual=provedActual(flight.transport_details);
  firstActual.departure.scheduled.iso="2026-11-01T01:30:00-07:00";
  assert.equal((await matchRpc("claim_flight_match_v2",A,firstOccurrence,firstVersion)).ok,true);
  assert.equal((await matchRpc("stage_flight_match_v2",A,firstOccurrence,firstVersion,firstActual)).ok,true);
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  const secondDetails={...flight.transport_details,departure:{...flight.transport_details.departure,utc_offset_minutes:-480}};
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:secondDetails,event_at:"2026-11-01T09:30:00Z"},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),firstVersion+1,"Only changing the UTC occurrence must increment segment version");
  assert.equal(flight.actual_match_request_id,null); assert.equal(flight.actual_info_matched,false);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,firstOccurrence,firstVersion,null)).code,"PLAN_CHANGED");
  const selectedLegacy=randomUUID(); assert.equal((await legacyClaim(selectedLegacy)).ok,true);
  await rejectCode(legacyInsert(selectedLegacy,firstActual),"23514","A first-occurrence ISO cannot prove the selected second occurrence");
  await rejectCode(legacyInsert(selectedLegacy,provedActual(flight.transport_details)),"23514","Missing ISO cannot prove an explicit UTC choice");
  const secondActual=provedActual(flight.transport_details); secondActual.departure.scheduled.iso="2026-11-01T01:30:00-08:00";
  assert.equal(await scalar(admin,"select public.flight_stop_offset_proved($1::jsonb,$2::jsonb) as value",[json({...flight.transport_details.departure,utc_offset_minutes:"-480"}),json(secondActual.departure)]),false,"A string offset cannot bypass numeric proof");
  await legacyInsert(selectedLegacy,secondActual);
  const secondConfirmed=await legacyFinish(selectedLegacy,firstActual);
  assert.equal(secondConfirmed.record.actual_info.departure.scheduled.iso,"2026-11-01T01:30:00-08:00","Legacy finish ignores supplied first-occurrence payload");
  flight=secondConfirmed.record;
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,departure:{...flight.transport_details.departure,utc_offset_minutes:null}}},flight.updated_at)).row;
  const noChoiceVersion=Number(flight.flight_plan_version);
  const missingChoice={...flight.transport_details.departure}; delete missingChoice.utc_offset_minutes;
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,departure:missingChoice}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),noChoiceVersion,"NULL and omitted choices have the same signature");
  const unselectedLegacy=randomUUID(); assert.equal((await legacyClaim(unselectedLegacy)).code,"AMBIGUOUS_FLIGHT_TIME","Old Edge must be rejected before it can reserve quota or call upstream");
  await rejectCode(legacyInsert(unselectedLegacy,secondActual),"23514","A legacy ambiguous plan without choice cannot gain a proved version");
  assert.equal(await scalar(admin,"select public.flight_stop_offset_proved($1::jsonb,$2::jsonb) as value",[json({...missingChoice,date:"2026-11-01",time:"02:30"}),json(secondActual.departure)]),true,"Unique legacy clocks keep offset-free compatibility");
  console.log("PASS: DST occurrence semantic version, stale preview/confirm invalidation, 30-minute rollback, nonexistent clocks, numeric-only ISO proof and safe NULL/missing legacy compatibility.");

  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,departure:{...flight.transport_details.departure,utc_offset_minutes:-480}},plan_status:"planned"},flight.updated_at)).row;
  const cancelledVersion=Number(flight.flight_plan_version),cancelledRequest=randomUUID();
  assert.equal((await matchRpc("claim_flight_match_v2",A,cancelledRequest,cancelledVersion)).ok,true);
  assert.equal((await matchRpc("stage_flight_match_v2",A,cancelledRequest,cancelledVersion,secondActual)).ok,true);
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  flight=(await save(a,"records",{id:flightId,user_id:A,plan_status:"cancelled"},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),cancelledVersion,"Status alone is not a new semantic segment");
  assert.equal((await legacyClaim(randomUUID())).code,"FLIGHT_CANCELLED");
  assert.equal((await matchRpc("claim_flight_match_v2",A,randomUUID(),cancelledVersion)).code,"FLIGHT_CANCELLED");
  assert.equal((await matchRpc("stage_flight_match_v2",A,cancelledRequest,cancelledVersion,secondActual)).code,"FLIGHT_CANCELLED");
  assert.equal((await matchRpc("confirm_flight_match_v2",A,cancelledRequest,cancelledVersion,null)).code,"FLIGHT_CANCELLED");
  assert.equal((await legacyFinish(cancelledRequest,secondActual)).code,"FLIGHT_CANCELLED");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.flight_match_previews where request_id=$1",[cancelledRequest])),1,"Rejected cancelled confirms do not consume the retained preview");
  flight=(await save(a,"records",{id:flightId,user_id:A,plan_status:"planned"},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),cancelledVersion);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,cancelledRequest,cancelledVersion,null)).ok,true,"Restoring planned re-enables valid confirmation without another API request");
  console.log("PASS: cancelled old/new claims, preview staging and confirmation are rejected, status preserves semantic version and restoring planned reuses the valid preview.");

  // Persistence retries share one transaction with usage completion and cannot
  // replace a newer cached result or cross an identity/context boundary.
  const reserve=async(feature)=>{ const requestId=randomUUID(); await admin.query("insert into public.api_usage_events(request_id,user_id,service,feature,quota_group,tier) values($1,$2,'deepseek',$3,$4,'standard')",[requestId,A,feature,feature==="trip_recap"?"recap":feature==="daily_summary"?"summary":"light"]); return requestId; };
  const cacheRpc=(connection, requestId, feature, content, generatedAt, contextKey=null, ownedTrip=null,summaryDate="2026-10-01")=>scalar(connection,"select public.store_ai_result($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6::uuid,$7::date,$8,$9,$10::jsonb) as value",[A,requestId,feature,content,generatedAt,ownedTrip,feature==="daily_summary"?summaryDate:null,contextKey,feature==="trip_recap"?"c".repeat(64):null,json({test:true})]);
  const generatedOld=new Date(Date.now()-3_600_000).toISOString(), generatedNew=new Date(Date.now()-1_800_000).toISOString(), generatedFailure=new Date(Date.now()-900_000).toISOString();
  const cacheOne=await reserve("daily_summary"), cacheTwo=await reserve("daily_summary"), contextA="a".repeat(64), contextB="b".repeat(64);
  await rejectCode(cacheRpc(a,cacheOne,"daily_summary","denied",generatedOld,contextA),"42501");
  await rejectCode(scalar(service,"select public.store_ai_result($1,$2,'daily_summary','foreign',now(),null,'2026-10-01',$3,null,null) as value",[B,cacheOne,contextA]),"42501");
  assert.equal((await cacheRpc(service,cacheOne,"daily_summary","context A",generatedOld,contextA)).saved,true);
  assert.equal((await cacheRpc(service,cacheTwo,"daily_summary","context B",generatedOld,contextB)).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and summary_date='2026-10-01'",[A])),2,"Same anchor date keeps distinct trip-local-day contexts");
  assert.equal((await cacheRpc(service,cacheOne,"daily_summary","context A",generatedOld,contextA)).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextA])),1);
  const midnightRetry=await reserve("daily_summary");
  assert.equal((await cacheRpc(service,midnightRetry,"daily_summary","same trip day",generatedOld,contextA,null,"2026-10-02")).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextA])),1,"Shanghai report date does not create a second cache for one unchanged trip-local context");
  const newer=await reserve("daily_summary");
  assert.equal((await cacheRpc(service,newer,"daily_summary","newest content",generatedNew,contextA)).saved,true);
  assert.equal((await cacheRpc(service,cacheOne,"daily_summary","older recovery",generatedOld,contextA)).newerPreserved,true);
  assert.equal(await scalar(admin,"select content as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextA]),"newest content");
  assert.equal(await scalar(admin,"select status as value from public.api_usage_events where request_id=$1",[cacheOne]),"completed");
  const failingCache=await reserve("daily_summary"), contextC="d".repeat(64);
  await admin.query(`create function public.test_reject_usage_completion() returns trigger language plpgsql as $$ begin if new.request_id='${failingCache}'::uuid then raise exception 'injected cache completion failure' using errcode='23514'; end if; return new; end $$; create trigger test_reject_usage_completion before update on public.api_usage_events for each row execute function public.test_reject_usage_completion()`);
  await rejectCode(cacheRpc(service,failingCache,"daily_summary","recoverable result",generatedFailure,contextC),"23514");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextC])),0,"Cache and completion roll back together");
  assert.equal(await scalar(admin,"select status as value from public.api_usage_events where request_id=$1",[failingCache]),"reserved","Previously reserved upstream call is not refunded or recreated");
  await admin.query("drop trigger test_reject_usage_completion on public.api_usage_events; drop function public.test_reject_usage_completion()");
  assert.equal((await cacheRpc(service,failingCache,"daily_summary","recoverable result",generatedFailure,contextC)).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.api_usage_events where request_id=$1",[failingCache])),1,"Save-only recovery does not reserve another upstream request");
  const recapRequest=await reserve("trip_recap");
  assert.equal((await cacheRpc(service,recapRequest,"trip_recap","recap",generatedOld,null,tripId)).saved,true);
  const otherTrip=randomUUID(); await save(b,"trips",{id:otherTrip,user_id:B,name:"Foreign trip",start_date:"2026-09-01",end_date:"2026-09-02",timezone:"UTC"});
  await rejectCode(cacheRpc(service,recapRequest,"trip_recap","foreign recap",generatedOld,null,otherTrip),"42501");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.trip_recaps where user_id=$1 and trip_id=$2",[A,tripId])),1);
  console.log("PASS: service-only atomic AI cache/usage completion, principal binding, trip ownership, distinct daily contexts, repeated save idempotence and newer-cache preservation.");
  console.log("PASS: database acceptance completed without production network or upstream API calls.");
} catch(error) {
  failed = true; console.error(error); if(error.cause) console.error(error.cause); console.error(logs.slice(-5).join("\n"));
} finally {
  for(const connection of clients) await connection.end().catch(()=>{});
  await cluster.stop();
}
exit(failed ? 1 : 0);

````

## scripts/test-flight-duration.mjs

<!-- source: scripts/test-flight-duration.mjs sha256: c92dfb8e55f63cec11de0937151e459d35e9b9b8838eb43c278f7917f16c242a encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path, require = () => { throw new Error("Unexpected import"); }) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require });
  return exports;
}
const flightTime = load("supabase/functions/_shared/flightTime.ts");
const { calculateFlightDuration } = load("src/lib/flightDuration.ts", name => {
  assert.equal(name, "../../supabase/functions/_shared/flightTime");
  return flightTime;
});
const stop = (date, time, timezone) => ({ date, time, timezone });
const examples = [
  [stop("2026-09-27", "00:50", "America/Los_Angeles"), stop("2026-09-28", "05:00", "Asia/Tokyo"), 730, "12 小时 10 分钟"],
  [stop("2026-01-27", "00:50", "America/Los_Angeles"), stop("2026-01-28", "05:00", "Asia/Tokyo"), 670, "11 小时 10 分钟"],
  [stop("2026-09-28", "10:00", "Asia/Tokyo"), stop("2026-09-28", "04:00", "America/Los_Angeles"), 600, "10 小时"],
  [stop("2026-09-27", "23:00", "Asia/Shanghai"), stop("2026-09-28", "01:00", "Asia/Shanghai"), 120, "2 小时"],
  [stop("2026-03-08", "01:30", "America/Los_Angeles"), stop("2026-03-08", "03:30", "America/Los_Angeles"), 60, "1 小时"],
  [stop("2026-11-01", "00:30", "America/Los_Angeles"), stop("2026-11-01", "02:30", "America/Los_Angeles"), 180, "3 小时"],
  [stop("2026-09-27", "10:00", "Asia/Kathmandu"), stop("2026-09-27", "10:00", "Asia/Kolkata"), 15, "15 分钟"]
];
for (const [departure, arrival, minutes, label] of examples) {
  const result = calculateFlightDuration(departure, arrival);
  assert.equal(result.status, "ready");
  assert.equal(result.minutes, minutes);
  assert.equal(result.label, label);
}
const valid = stop("2026-09-28", "05:00", "Asia/Tokyo");
for (const invalid of [stop("2026-02-30", "05:00", "Asia/Tokyo"), stop("2026-09-27", "25:00", "Asia/Tokyo"), stop("2026-09-27", "05:00", "Invalid/Zone"), stop("2026-03-08", "02:30", "America/Los_Angeles")]) assert.equal(calculateFlightDuration(invalid, valid).status, "invalid");
assert.equal(calculateFlightDuration(valid, valid).status, "invalid");
assert.equal(calculateFlightDuration(valid, stop("2026-09-27", "05:00", "Asia/Tokyo")).status, "invalid");
assert.equal(calculateFlightDuration({ ...valid, timezone: "" }, valid).status, "incomplete");
assert.equal(calculateFlightDuration({ ...valid, time: "" }, valid).status, "incomplete");
const repeated = stop("2026-11-01", "01:30", "America/Los_Angeles");
assert.deepEqual(Array.from(flightTime.flightTimeOptions(repeated), option => [new Date(option.instant).toISOString(), option.utcOffsetMinutes]), [["2026-11-01T08:30:00.000Z", -420], ["2026-11-01T09:30:00.000Z", -480]]);
assert.equal(calculateFlightDuration(repeated, stop("2026-11-01", "02:30", "America/Los_Angeles")).status, "invalid", "Repeated clocks require an explicit choice");
for (const [offset, minutes] of [[-420,120],[-480,60]]) assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:offset},stop("2026-11-01","02:30","America/Los_Angeles")).minutes,minutes);
assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:-450},valid).status,"invalid");
assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:"-420"},valid).status,"invalid", "Offsets are numeric, not coercible strings");
assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:-420},{...repeated,utc_offset_minutes:-480}).minutes,60, "Both ends may be the same local clock with different occurrences");
const ny=stop("2026-11-01","01:30","America/New_York");
assert.deepEqual(Array.from(flightTime.flightTimeOptions(ny),option=>option.utcOffsetMinutes),[-240,-300]);
const lordHowe=stop("2026-04-05","01:45","Australia/Lord_Howe");
assert.deepEqual(Array.from(flightTime.flightTimeOptions(lordHowe),option=>option.utcOffsetMinutes),[660,630]);
assert.equal(calculateFlightDuration({...lordHowe,utc_offset_minutes:660},{...lordHowe,utc_offset_minutes:630}).minutes,30);
assert.equal(flightTime.utcOffsetLabel(-420),"UTC-07:00"); assert.equal(flightTime.utcOffsetLabel(630),"UTC+10:30");
assert.equal(flightTime.isoUtcOffsetMinutes("2026-11-01T01:30:00-08:00"),-480); assert.equal(flightTime.isoUtcOffsetMinutes("2026-11-01T01:30:00"),undefined);
const original = JSON.stringify(examples);
for (const [departure, arrival] of examples) calculateFlightDuration(departure, arrival);
assert.equal(JSON.stringify(examples), original, "Derived display must not mutate flight data");
console.log("PASS: cross-zone/date-line flights, summer/winter offsets, explicit first/second DST occurrences, both ambiguous ends, half-hour DST, fractional zones, incomplete/invalid/negative times and immutable data.");

````

## scripts/test-flight-integrity.mjs

<!-- source: scripts/test-flight-integrity.mjs sha256: 1ce80e1ca999b13b806e2514302c41058d17d522e7b63e111d837d94dd48c47d encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID, webcrypto } from "node:crypto";
import ts from "typescript";

const NOW = Date.parse("2026-10-01T12:00:00Z");
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const crypto = { randomUUID, subtle: webcrypto.subtle };
function load(path, require) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require, crypto, Date: Clock, Intl, TextEncoder, TextDecoder, btoa, atob, Response, Request, DOMException, AbortController, setTimeout, clearTimeout, console: { error() {} }, Deno: { env: { get: name => name === "AVIATIONSTACK_API_KEY" ? "local-mocked-key" : "local-test-only-secret" } } });
  return exports;
}
const recovery = load("supabase/functions/_shared/recovery.ts", () => { throw new Error("unexpected import"); });
const flightTime = load("supabase/functions/_shared/flightTime.ts", () => { throw new Error("unexpected import"); });
const state = load("src/lib/flightMatchState.ts", () => { throw new Error("unexpected import"); });
const user = randomUUID(), recordId = randomUUID();
const flight = { airline: "ANA", flight_number: "NH105", departure: { date: "2026-09-30", time: "15:00", airport: "Los Angeles", iata: "LAX", timezone: "America/Los_Angeles" }, arrival: { date: "2026-10-01", time: "19:00", airport: "Haneda", iata: "HND", timezone: "Asia/Tokyo" } };
const record = { id: recordId, user_id: user, transport_type: "flight", transport_details: flight, flight_plan_version: 7, actual_match_plan_version: 7, actual_confirmed_request_id: randomUUID(), actual_info_matched: true, actual_info: { flight_number: "NH105", departure: { iata: "LAX", scheduled: { date: flight.departure.date } }, arrival: { iata: "HND" } } };
assert.equal(state.flightMatchIsCurrent(record), true);
assert.equal(state.flightMatchIsCurrent({ ...record, actual_match_plan_version: 6 }), false);
for (const [side, field, value] of [["departure", "date", "2026-09-29"], ["arrival", "time", "20:00"], ["departure", "timezone", "America/New_York"], ["arrival", "iata", "NRT"], ["departure", "utc_offset_minutes", -420], ["arrival", "utc_offset_minutes", 540]]) {
  const next = { ...record, transport_details: { ...flight, [side]: { ...flight[side], [field]: value } } };
  const invalidated = state.invalidateChangedFlight(record, next);
  assert.equal(invalidated.flight_plan_version, 8);
  assert.equal(invalidated.actual_info_matched, false);
  assert.equal(invalidated.actual_match_plan_version, null);
  assert.equal(invalidated.actual_confirmed_request_id, null);
  assert.equal(invalidated.actual_info, record.actual_info, "historical payload retained");
}
assert.equal(state.invalidateChangedFlight(record, { ...record, transport_details: { ...flight, gate: "62", seat: "22A" } }).flight_plan_version, 7);
assert.equal(state.invalidateChangedFlight(record, { ...record, transport_details: { ...flight, flight_number: "NH106" } }).actual_info_matched, false);
assert.equal(state.invalidateChangedFlight(record, { ...record, transport_type: "rail" }).actual_info_matched, false);

class ApiError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const providerRow = { flight_status: "landed", airline: { name: "ANA" }, flight: { iata: "NH105" }, departure: { ...flight.departure, scheduled: "2026-09-30T15:00:00-07:00", actual: "2026-09-30T15:08:00-07:00" }, arrival: { ...flight.arrival, scheduled: "2026-10-01T19:00:00+09:00", actual: "2026-10-01T19:04:00+09:00" } };
function server(options = {}) {
  const counts = { upstream: 0, reserve: 0, stage: 0, confirm: 0, complete: 0, cleanup: 0 };
  let lastConfirm;
  let lastUsageStatus, lastCleanupStatus, lastUpstreamSignal;
  const errorLogs = [];
  const fakeSecret = "FAKE_SECRET_MUST_NOT_APPEAR";
  const liveTimers = new Set();
  const timedSetTimeout = (callback, ms) => {
    const timer = setTimeout(() => { liveTimers.delete(timer); callback(); }, options.hang ? 5 : ms);
    liveTimers.add(timer); return timer;
  };
  const timedClearTimeout = timer => { liveTimers.delete(timer); clearTimeout(timer); };
  const actualRecord = { ...record, actual_info_matched: options.cached === true, actual_match_request_id: options.staged?.request_id || null, ...(options.record || {}) };
  class ServerClock extends Date { constructor(...args) { super(...(args.length ? args : [options.now ?? NOW])); } static now() { return options.now ?? NOW; } }
  const admin = { from(table) {
    const filters = {};
    const query = { select() { return this; }, eq(key, value) { filters[key] = value; return this; }, gt() { return this; }, order() { return this; }, limit() { return this; }, async maybeSingle() {
      if (table === "records") return { data: actualRecord, error: options.readError ? {} : null };
      assert.equal(table, "flight_match_previews");
      if (filters.plan_version !== undefined) assert.equal(filters.plan_version, 7);
      return { data: options.staged || null, error: options.previewReadError ? {} : null };
    } }; return query;
  }, async rpc(name, args) {
    if (name === "claim_flight_match_v2") return { data: options.claimCancelled ? { ok: false, code: "FLIGHT_CANCELLED" } : options.claimChanged ? { ok: false, code: "PLAN_CHANGED" } : { ok: true, record: actualRecord, cached: false }, error: null };
    if (name === "stage_flight_match_v2") { counts.stage++; if (options.stageThrow) throw new TypeError("mock network loss"); return { data: options.stageCancelled ? { ok: false, code: "FLIGHT_CANCELLED" } : options.stageChanged ? { ok: false, code: "PLAN_CHANGED" } : { ok: true }, error: options.stageError ? {} : null }; }
    if (name === "confirm_flight_match_v2") { counts.confirm++; lastConfirm = args; return { data: options.confirmCancelled ? { ok: false, code: "FLIGHT_CANCELLED" } : options.confirmChanged ? { ok: false, code: "PLAN_CHANGED" } : { ok: true, record }, error: options.confirmError ? {} : null }; }
    assert.equal(name, "finish_flight_match"); counts.cleanup++; lastCleanupStatus = args.p_status; return { data: { ok: true }, error: null };
  } };
  const api = { admin: () => admin, ApiError, authenticatedUser: async () => ({ id: options.userId || user }), completeUsage: async (_requestId, status) => { counts.complete++; lastUsageStatus = status; if (options.usageError) throw new Error("usage persistence failed"); }, errorResponse: (_origin, _id, error) => { errorLogs.push(error.message); return new Response(JSON.stringify({ error: { code: error.code || "INTERNAL_ERROR", message: error.message } }), { status: error.status || 503 }); }, json: (_origin, _id, body) => new Response(JSON.stringify(body)), preflight: () => null, readJson: request => request.json(), requestOrigin: () => "http://localhost:3000", reserveQuota: async () => { counts.reserve++; }, stringField: value => value };
  const mockedFetch = async (_input, init) => {
    counts.upstream++; lastUpstreamSignal = init.signal;
    // Ignore abort on purpose: a deadline must settle both these transports.
    if (options.hang === "headers") return new Promise(() => {});
    if (options.hang === "body") return { ok: true, status: 200, json: () => new Promise(() => {}) };
    if (options.networkError) throw new TypeError(`Fetch failed URL=https://example.test?access_key=${fakeSecret} Authorization=Bearer ${fakeSecret}`);
    if (options.malformed) return new Response("{invalid");
    if ("json" in options) return new Response(JSON.stringify(options.json));
    return new Response(JSON.stringify({ data: options.noMatch ? [] : options.providerRows || [providerRow] }));
  };
  const upstream = {};
  const upstreamCode = ts.transpileModule(readFileSync("supabase/functions/_shared/upstream.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(upstreamCode, { exports: upstream, fetch: mockedFetch, AbortController, DOMException, setTimeout: timedSetTimeout, clearTimeout: timedClearTimeout });
  const code = ts.transpileModule(readFileSync("supabase/functions/lookup-flight/index.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: path => path.includes("_shared/api") ? api : path.includes("_shared/recovery") ? recovery : path.includes("_shared/flightTime") ? flightTime : path.includes("_shared/upstream") ? upstream : {}, crypto, Date: ServerClock, Intl, URL, Response, Request, DOMException, AbortController, setTimeout: timedSetTimeout, clearTimeout: timedClearTimeout, console: { error(...args) { errorLogs.push(args); } }, Deno: { env: { get: name => name === "AVIATIONSTACK_API_KEY" ? "local-mocked-key" : "local-test-only-secret" } } });
  return { counts, lastConfirm: () => lastConfirm, lastUsageStatus: () => lastUsageStatus, lastCleanupStatus: () => lastCleanupStatus, lastUpstreamSignal: () => lastUpstreamSignal, liveTimers, errorLogs, request: async (body) => {
    const response = await exports.default.fetch(new Request("http://localhost/lookup-flight", { method: "POST", body: JSON.stringify({ action: "match", recordId, requestId: randomUUID(), planVersion: 7, ...body }) }));
    return { status: response.status, body: await response.json() };
  } };
}
for (const failure of [{ readError: true }, { previewReadError: true }, { claimChanged: true }]) {
  const fixture = server(failure); const result = await fixture.request({});
  assert.ok(result.status >= 400); assert.equal(fixture.counts.upstream, 0); assert.equal(fixture.counts.reserve, 0);
}
// F04: skip malformed inner rows while preserving one valid exact match.
const mixedRows=server({providerRows:[null,[],true,{departure:null},{...providerRow,arrival:[]},providerRow]});
const mixedResult=await mixedRows.request({});assert.equal(mixedResult.status,200);assert.equal(mixedResult.body.data.preview.flight_number,"NH105");
assert.equal(mixedRows.counts.upstream,1);assert.equal(mixedRows.counts.reserve,1);assert.equal(mixedRows.counts.stage,1);
const invalidRows=server({providerRows:[null,[],true,{departure:null}]});
assert.equal((await invalidRows.request({})).body.error.code,"API_UNAVAILABLE");assert.equal(invalidRows.counts.complete,1);assert.equal(invalidRows.counts.cleanup,1);assert.equal(invalidRows.counts.stage,0);
const stale = server();
assert.equal((await stale.request({ planVersion: 6 })).body.error.code, "PLAN_CHANGED");
assert.equal(stale.counts.upstream, 0);
assert.equal((await stale.request({ planVersion: null })).body.error.code, "PLAN_VERSION_REQUIRED");
const legacyMatch=server();
const legacyResult=await legacyMatch.request({planVersion:undefined});
assert.equal(legacyResult.status,200); assert.equal(legacyResult.body.data.planVersion,7);
assert.equal(legacyMatch.counts.upstream,1); assert.equal(legacyMatch.counts.reserve,1);
const legacyPreviewId=randomUUID();
const legacyConfirm=server({staged:{request_id:legacyPreviewId,plan_version:7}});
assert.equal((await legacyConfirm.request({action:"confirm",requestId:legacyPreviewId,planVersion:undefined})).status,200);
assert.equal(legacyConfirm.lastConfirm().p_plan_version,7); assert.equal(legacyConfirm.counts.upstream,0); assert.equal(legacyConfirm.counts.reserve,0);
const staleLegacyConfirm=server({staged:{request_id:legacyPreviewId,plan_version:6},confirmChanged:true});
assert.equal((await staleLegacyConfirm.request({action:"confirm",requestId:legacyPreviewId,planVersion:undefined})).body.error.code,"PLAN_CHANGED");
assert.equal(staleLegacyConfirm.lastConfirm().p_plan_version,6,"Legacy preview retains its old version instead of acquiring the current version");
const legacyConfirmed=server({cached:true});
assert.equal((await legacyConfirmed.request({action:"confirm",requestId:record.actual_confirmed_request_id,planVersion:undefined})).status,200);
assert.equal(legacyConfirmed.lastConfirm().p_plan_version,7);
const unprovedLegacy=server({cached:true});
assert.equal((await unprovedLegacy.request({action:"confirm",requestId:randomUUID(),planVersion:undefined})).body.error.code,"PREVIEW_EXPIRED");
assert.equal(unprovedLegacy.counts.confirm,0); assert.equal(unprovedLegacy.counts.upstream,0);
const cache = server({ cached: true });
const cached = await cache.request({});
assert.equal(cached.body.data.cached, true);
assert.equal(cached.body.data.requestId, record.actual_confirmed_request_id);
assert.equal(cache.counts.upstream, 0);
for(const options of [{record:{plan_status:"cancelled"}},{record:{plan_status:"cancelled"},cached:true},{claimCancelled:true}]) {
  const fixture=server(options),result=await fixture.request({});
  assert.equal(result.body.error.code,"FLIGHT_CANCELLED"); assert.equal(result.status,409); assert.equal(fixture.counts.reserve,0); assert.equal(fixture.counts.upstream,0);
}
const cancelledConfirm=server({confirmCancelled:true});
assert.equal((await cancelledConfirm.request({action:"confirm"})).body.error.code,"FLIGHT_CANCELLED");assert.equal(cancelledConfirm.counts.upstream,0);assert.equal(cancelledConfirm.counts.reserve,0);
const cancelledDuringUpstream=server({stageCancelled:true});
assert.equal((await cancelledDuringUpstream.request({})).body.error.code,"FLIGHT_CANCELLED");assert.equal(cancelledDuringUpstream.counts.stage,1);assert.equal(cancelledDuringUpstream.counts.confirm,0);
for (const [arrival, expected] of [[{ date: "2026-10-02" }, "FLIGHT_NOT_COMPLETED"], [{ date: "2026-09-28" }, "MATCH_WINDOW_EXPIRED"], [{ time: "25:00" }, "INCOMPLETE_FLIGHT_PLAN"], [{ date: "2026-02-30" }, "INVALID_FLIGHT_TIME"], [{ timezone: "Invalid/Zone" }, "INVALID_TIMEZONE"]]) {
  const fixture = server({ record: { transport_details: { ...flight, departure: { ...flight.departure, date: "2026-02-01" }, arrival: { ...flight.arrival, ...arrival } } } });
  assert.equal((await fixture.request({})).body.error.code, expected);
  assert.equal(fixture.counts.upstream, 0); assert.equal(fixture.counts.reserve, 0);
}

for (const failure of [{ stageError: true }, { stageThrow: true }, { usageError: true }, { stageError: true, usageError: true }]) {
  const fixture = server(failure); const result = await fixture.request({});
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.ok(result.body.data.preview); assert.ok(result.body.data.warning); assert.ok(result.body.data.recoveryToken);
  const preview = result.body.data;
  const confirmed = await fixture.request({ action: "confirm", requestId: preview.requestId, recoveryToken: preview.recoveryToken });
  assert.equal(confirmed.status, 200); assert.equal(fixture.counts.upstream, 1); assert.equal(fixture.counts.reserve, 1);
  assert.equal(fixture.lastConfirm().p_actual_info.flight_number, "NH105");
  const anotherAccount = server({ userId: randomUUID() });
  assert.equal((await anotherAccount.request({ action: "confirm", requestId: preview.requestId, recoveryToken: preview.recoveryToken })).status, 403);
  assert.equal(anotherAccount.counts.confirm, 0);
  assert.equal(anotherAccount.counts.reserve, 0);
  const changed = server({ confirmChanged: true });
  assert.equal((await changed.request({ action: "confirm", requestId: preview.requestId, recoveryToken: preview.recoveryToken })).body.error.code, "PLAN_CHANGED");
  assert.equal(changed.counts.upstream, 0);
}
const editedDuringLookup = server({ stageChanged: true });
assert.equal((await editedDuringLookup.request({})).body.error.code, "PLAN_CHANGED");
assert.equal(editedDuringLookup.counts.upstream, 1);

for (const hang of ["headers", "body"]) {
  const fixture = server({ hang });
  const result = await fixture.request({});
  assert.equal(result.status, 504);
  assert.equal(result.body.error.code, "API_TIMEOUT");
  assert.equal(fixture.counts.reserve, 1, "The timed-out call retains one reserved attempt, without retry or refund");
  assert.equal(fixture.counts.upstream, 1);
  assert.equal(fixture.counts.complete, 1);
  assert.equal(fixture.lastUsageStatus(), "upstream_error");
  assert.equal(fixture.counts.cleanup, 1, "The pending flight claim is released after deadline");
  assert.equal(fixture.lastCleanupStatus(), "failed");
  assert.equal(fixture.counts.stage, 0);
  assert.equal(fixture.counts.confirm, 0);
  assert.equal(fixture.lastUpstreamSignal().aborted, true);
  assert.equal(fixture.liveTimers.size, 0, "Hard-deadline timers are cleared even when transport ignores abort");
}
for (const options of [{ malformed: true }, ...[null, 7, "wrong envelope", [], true].map(json => ({ json }))]) {
  const fixture = server(options);
  const result = await fixture.request({});
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "API_UNAVAILABLE", "Non-object or malformed provider JSON remains a provider error, not an internal TypeError or timeout");
  assert.equal(fixture.counts.reserve, 1);
  assert.equal(fixture.counts.upstream, 1);
  assert.equal(fixture.counts.stage, 0);
  assert.equal(fixture.counts.confirm, 0);
  assert.equal(fixture.liveTimers.size, 0);
}
const networkFailure = server({ networkError: true });
const networkResponse = await networkFailure.request({});
assert.equal(networkResponse.status, 503);
assert.equal(JSON.stringify(networkResponse).includes("FAKE_SECRET_MUST_NOT_APPEAR"), false);
assert.equal(JSON.stringify(networkFailure.errorLogs).includes("FAKE_SECRET_MUST_NOT_APPEAR"), false, "Transport URLs and Authorization diagnostics never reach response or console logs");
assert.equal(networkFailure.counts.stage, 0);
assert.equal(networkFailure.liveTimers.size, 0);

const repeatedPlan = { ...flight, departure: { ...flight.departure, date: "2026-11-01", time: "01:30" }, arrival: { ...flight.arrival, date: "2026-11-02", time: "03:30" } };
const repeatedNow = Date.parse("2026-11-02T00:00:00Z");
for(const [offset,expected] of [[undefined,"AMBIGUOUS_FLIGHT_TIME"],[-450,"INVALID_FLIGHT_OFFSET"],["-420","INVALID_FLIGHT_OFFSET"]]) {
  const fixture=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:offset}}}});
  assert.equal((await fixture.request({planVersion:undefined})).body.error.code,expected); assert.equal(fixture.counts.reserve,0); assert.equal(fixture.counts.upstream,0);
}
const repeatedRows=[-420,-480].map(offset=>({...providerRow,registration:`offset-${offset}`,departure:{...providerRow.departure,scheduled:`2026-11-01T01:30:00${offset===-420?"-07:00":"-08:00"}`},arrival:{...providerRow.arrival,scheduled:"2026-11-02T03:30:00+09:00"},aircraft:{registration:`offset-${offset}`}}));
for(const offset of [-420,-480]) {
  const fixture=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:offset}}},providerRows:repeatedRows});
  const result=await fixture.request({}); assert.equal(result.status,200,JSON.stringify(result.body)); assert.equal(result.body.data.preview.registration,`offset-${offset}`);
}
const wrongProvider=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:-480}}},providerRows:[repeatedRows[0]]});
assert.equal((await wrongProvider.request({})).body.error.code,"NO_EXACT_MATCH");
const noOffsetProvider=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:-480}}},providerRows:[{...repeatedRows[1],departure:{...repeatedRows[1].departure,scheduled:"2026-11-01T01:30:00"}}]});
assert.equal((await noOffsetProvider.request({})).body.error.code,"NO_EXACT_MATCH");
const arrivalPlan={...flight,departure:{...flight.departure,date:"2026-11-01",time:"00:30"},arrival:{...flight.arrival,date:"2026-11-01",time:"01:30",timezone:"America/Los_Angeles",iata:"SFO"}};
const arrivalNow=Date.parse("2026-11-01T09:45:00Z");
const arrivalRows=[-420,-480].map(offset=>({...providerRow,departure:{...providerRow.departure,scheduled:"2026-11-01T00:30:00-07:00"},arrival:{...providerRow.arrival,iata:"SFO",timezone:"America/Los_Angeles",scheduled:`2026-11-01T01:30:00${offset===-420?"-07:00":"-08:00"}`}}));
for(const [offset,status] of [[-420,200],[-480,400]]) {
  const fixture=server({now:arrivalNow,record:{transport_details:{...arrivalPlan,arrival:{...arrivalPlan.arrival,utc_offset_minutes:offset}}},providerRows:arrivalRows});
  const result=await fixture.request({}); assert.equal(result.status,status,JSON.stringify(result.body));
  assert.equal(fixture.counts.reserve,status===200?1:0);assert.equal(fixture.counts.upstream,status===200?1:0);
  if(status===400)assert.equal(result.body.error.code,"FLIGHT_NOT_COMPLETED");
}

// Client retry uses the per-account short-lived preview, not another lookup.
const storage = new Map(); let invokes = 0; let account = user;
const tripDates = load("src/lib/tripDates.ts", () => ({}));
const duration = load("src/lib/flightDuration.ts", () => flightTime);
const modules = { "./flightMatchState": state, "./tripDates": tripDates, "./flightDuration": duration, "./aircraftTypes": { normalizeAircraftType: value => value }, "./functionError": { edgeFunctionMessage: async () => "mock error" }, "./supabase": { supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: account } } } }) }, functions: { invoke: async () => { invokes++; return { data: { data: { preview: { ...record.actual_info, aircraft_type: "B789" }, requestId: randomUUID(), recoveryToken: "mock", expiresAt: new Clock(NOW + 20 * 60_000).toISOString() } }, error: null }; } } } } };
const lookupCode = ts.transpileModule(readFileSync("src/lib/flightLookup.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const lookup = {};
runInNewContext(lookupCode, { exports: lookup, require: name => modules[name], crypto, Date: Clock, Intl, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
await lookup.matchFlightActual(record); await lookup.matchFlightActual(record); assert.equal(invokes, 1);
account = randomUUID(); await lookup.matchFlightActual(record); assert.equal(invokes, 2);
await lookup.matchFlightActual({ ...record, flight_plan_version: 8 }); assert.equal(invokes, 3);
await assert.rejects(() => lookup.matchFlightActual({ ...record, flight_plan_version: undefined }), /同步到云端/);
await assert.rejects(() => lookup.matchFlightActual({ ...record, transport_details: { ...flight, departure: { ...flight.departure, iata: "" } } }), /手动机场/);
assert.equal(lookup.flightMatchEligibility({...record,plan_status:"cancelled"}).eligible,false);
await assert.rejects(() => lookup.matchFlightActual({...record,plan_status:"cancelled"}),/已取消/);
assert.equal(lookup.flightMatchEligibility({...record,plan_status:"planned"}).eligible,true);
assert.equal(invokes, 3);
const repeatedArrival = { ...record, transport_details: { ...flight, departure: { ...flight.departure, date:"2026-10-31",time:"22:00",timezone:"America/Los_Angeles" }, arrival: { ...flight.arrival, date:"2026-11-01",time:"01:30",timezone:"America/Los_Angeles" } } };
assert.equal(lookup.flightMatchEligibility(repeatedArrival,Date.parse("2026-11-01T09:00:00Z")).eligible,false);
assert.equal(lookup.flightMatchEligibility({...repeatedArrival,transport_details:{...repeatedArrival.transport_details,arrival:{...repeatedArrival.transport_details.arrival,utc_offset_minutes:-420}}},Date.parse("2026-11-01T09:45:00Z")).eligible,true);
assert.equal(lookup.flightMatchEligibility({...repeatedArrival,transport_details:{...repeatedArrival.transport_details,arrival:{...repeatedArrival.transport_details.arrival,utc_offset_minutes:-480}}},Date.parse("2026-11-01T09:45:00Z")).eligible,false);
const editor = readFileSync("src/components/TransportPlanEditor.tsx", "utf8");
assert.ok(editor.includes("confirmFlightActual(record.id, preview.requestId, preview.planVersion, preview.recoveryToken)"));
assert.ok(!editor.includes("onUpdate(preview.record"), "Even an existing matched cache must be revalidated on explicit confirmation, since another window may edit the plan while the dialog is open");
const migration = readFileSync("supabase/migrations/20261111172354_flight_integrity.sql", "utf8");
assert.ok(migration.includes("create trigger flight_previews_legacy_version before insert"));
assert.ok(migration.includes("r.actual_match_request_id is distinct from new.request_id"));
assert.ok(migration.includes("public.flight_plan_signature('flight', actual_plan) is distinct from public.flight_plan_signature(r.transport_type, r.transport_details)"));
assert.ok(migration.includes("return public.confirm_flight_match_v2(p_user_id, p_record_id, p_request_id, preview_version, null)"));
assert.ok(migration.includes("actual_confirmed_request_id = p_request_id"), "Rematch confirmations distinguish confirmed payload from the pending claim");
assert.ok(migration.includes("coalesce(p_details->'departure'->'utc_offset_minutes', 'null'::jsonb)"));
assert.ok(migration.includes("coalesce(p_details->'arrival'->'utc_offset_minutes', 'null'::jsonb)"));
assert.ok(migration.includes("public.flight_iso_offset_minutes(new.actual_info->'departure'->'scheduled'->>'iso')"),"Legacy proofs also bind explicit UTC occurrence");
assert.ok(migration.includes("when selected = 'null'::jsonb then cardinality(offsets) = 1"),"Legacy omitted choices are valid only for unique local clocks");
assert.equal((migration.match(/if r\.plan_status = 'cancelled' then/g)||[]).length,5,"New/legacy claim, stage, confirm and legacy finish must fail closed while cancelled");
console.log("PASS: flight semantic edits invalidate match; gate/seat preserve; stale/malformed plans and read failures cost no quota; version-bound confirmation; old PWA match and provable confirm compatibility; signed preview persistence retry with no new upstream; account-bound recovery and preview cache; usage-write failures retain results; slow headers/body settle as API_TIMEOUT with one charged attempt, released claim, no preview, and cleared timers; malformed/non-object JSON stays API_UNAVAILABLE.");

````

## scripts/test-flight-trip-placement.mjs

<!-- source: scripts/test-flight-trip-placement.mjs sha256: d29cd661681b5f5fa8bd0012ffbd3a12e04085d78d81207a2b8d90bcf3393a0a encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const loaded = new Map();
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const code = ts.transpileModule(readFileSync(name === "flightTime" ? "supabase/functions/_shared/flightTime.ts" : `src/lib/${name}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: path => { if(path.endsWith("_shared/flightTime")) return load("flightTime"); assert.match(path, /^\.\/(tripDates|flightDuration)$/); return load(path.slice(2)); } });
  loaded.set(name, exports);
  return exports;
}
const { flightTripPlacement: place, flightMoveOffset: offset } = load("flightTripPlacement");
const trip = { start_date: "2026-09-29", end_date: "2026-10-05", timezone: "Asia/Tokyo" };
const stop = (date, time, timezone) => ({ date, time, timezone, airport: "", terminal: "" });
const flight = (departure, arrival) => ({ departure, arrival, airline: "ANA", flight_number: "NH105" });
const incoming = flight(stop("2026-09-28", "00:50", "America/Los_Angeles"), stop("2026-09-29", "05:00", "Asia/Tokyo"));
const before = JSON.stringify(incoming);
assert.equal(place(incoming, trip).day, "2026-09-29");
assert.equal(place(incoming, trip).overlapsTrip, true);
assert.equal(place(incoming, trip).startsBeforeTrip, true);
assert.equal(place(incoming, { ...trip, start_date: "2026-09-28" }).day, "2026-09-28");
assert.equal(place(incoming, { ...trip, start_date: "2026-09-30" }).overlapsTrip, false);
// Landing date in Tokyo cannot be used blindly for a trip in Los Angeles.
assert.equal(place(incoming, { ...trip, timezone: "America/Los_Angeles" }).overlapsTrip, false);
const converted = flight(stop("2026-09-28", "17:00", "America/Los_Angeles"), stop("2026-09-29", "20:00", "Asia/Tokyo"));
assert.equal(place(converted, trip).day, "2026-09-29");
assert.equal(place(converted, trip).startsBeforeTrip, false);
const westbound = flight(stop("2026-09-30", "00:00", "Asia/Tokyo"), stop("2026-09-29", "18:00", "America/Los_Angeles"));
assert.equal(place(westbound, { ...trip, start_date: "2026-09-30" }).day, "2026-09-30");
assert.equal(place(westbound, { ...trip, start_date: "2026-09-30" }).overlapsTrip, true);
assert.equal(place(flight(stop("2026-09-27", "00:50", "America/Los_Angeles"), stop("2026-09-28", "05:00", "Asia/Tokyo")), trip).overlapsTrip, false);
assert.equal(place(flight(stop("2026-10-06", "00:50", "America/Los_Angeles"), stop("2026-10-07", "05:00", "Asia/Tokyo")), trip).overlapsTrip, false);
assert.equal(place(flight(incoming.departure, stop("2026-10-01", "05:00", "Asia/Tokyo")), { ...trip, end_date: trip.start_date }).day, trip.start_date);
const midnight = flight(stop("2026-09-28", "03:00", "America/Los_Angeles"), stop("2026-09-29", "00:00", "Asia/Tokyo"));
assert.equal(place(midnight, trip).overlapsTrip, true);
assert.equal(place({ ...incoming, arrival: { ...incoming.arrival, date: "" } }, trip).day, incoming.departure.date);
assert.equal(place(incoming, { ...trip, timezone: "Invalid/Zone" }).day, incoming.departure.date);
assert.equal(offset(incoming, trip, "2026-09-29"), 0, "Same-day reorder must not move airport-local dates");
assert.equal(offset(incoming, trip, "2026-09-30"), 2, "Moving a carry-in aligns its departure with the target trip day");
assert.equal(offset(converted, trip, "2026-09-30"), 1, "Use trip-zone departure day, not airport-local departure date");
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
for (const source of [incoming, converted]) {
  const days = offset(source, trip, "2026-09-30");
  const moved = { ...source, departure: { ...source.departure, date: shift(source.departure.date, days) }, arrival: { ...source.arrival, date: shift(source.arrival.date, days) } };
  assert.equal(place(moved, trip).day, "2026-09-30");
  const duration = load("flightDuration").calculateFlightDuration;
  assert.equal(duration(moved.departure, moved.arrival).minutes, duration(source.departure, source.arrival).minutes);
}
assert.equal(JSON.stringify(incoming), before, "Placement must not modify the saved flight");
// On the fallback day, the selected instant can land on different trip days.
const repeated=stop("2026-11-01","01:30","America/Los_Angeles");
const choiceTrip={start_date:"2026-10-31",end_date:"2026-11-02",timezone:"Pacific/Gambier"};
const choiceArrival=stop("2026-11-01","12:00","America/Los_Angeles");
assert.equal(place(flight({...repeated,utc_offset_minutes:-420},choiceArrival),choiceTrip).departureDay,"2026-10-31");
assert.equal(place(flight({...repeated,utc_offset_minutes:-480},choiceArrival),choiceTrip).departureDay,"2026-11-01");
console.log("PASS: cross-date/zone trip overlap, first-day carry-in, date-line reversal, boundaries, edited trip ranges, fallback and safe flight movement.");

````

## scripts/test-schedules-and-flight-display.mjs

<!-- source: scripts/test-schedules-and-flight-display.mjs sha256: 401245b97cf18005342469634a89f2a02942c7ebf09c228b19d645ebe1bff830 encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const modules = {};
function load(path) {
  if (modules[path]) return modules[path];
  const code = ts.transpileModule(readFileSync(path === "flightTime" ? "supabase/functions/_shared/flightTime.ts" : `src/lib/${path}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: name => load(name.endsWith("_shared/flightTime") ? "flightTime" : name.replace("./", "")) });
  modules[path] = exports;
  return exports;
}
const schedules = load("schedules");
const { flightDisplay } = load("flightDisplay");
const { getTransportPresentation } = load("transport");
const record = (id, content, start, end, kind = "hotel", status = "planned") => ({ id, content, created_at: "2026-09-30T00:00:00Z", plan_status: status, schedule_details: { kind, start_date: start, end_date: end } });
const oldHotel = record("old", "浅草酒店", "2026-09-28", "2026-09-30");
const newHotel = record("new", "新宿酒店", "2026-09-30", "2026-10-02");
const allDay = record("day", "全天游园", "2026-09-29", "2026-09-30", "all_day");
const records = [newHotel, allDay, oldHotel];
const unchanged = JSON.stringify(records);
assert.equal(schedules.scheduleNights(oldHotel.schedule_details), 2);
assert.equal(schedules.scheduleDayEntries(records, "2026-09-28")[0].phase, "check_in");
assert.equal(schedules.scheduleDayEntries(records, "2026-09-29")[0].phase, "staying");
const changeDay = schedules.scheduleDayEntries(records, "2026-09-30");
assert.equal(changeDay.length, 3);
assert.equal(changeDay[0].phase, "check_out");
assert.equal(changeDay[1].phase, "check_in");
assert.equal(changeDay[2].phase, "all_day");
assert.ok(schedules.scheduleDayNotice(changeDay).change.includes("浅草酒店退房"));
assert.equal(schedules.scheduleDayNotice(changeDay).conflict, "");
assert.equal(schedules.scheduleDayEntries(records, "2026-10-03").length, 0);
assert.equal(new Set(changeDay.map(entry => entry.record.id)).size, 3);
assert.equal(schedules.scheduleTripDate(oldHotel.schedule_details, { start_date: "2026-09-29", end_date: "2026-10-01" }), "2026-09-29");
assert.equal(schedules.scheduleTripDate(oldHotel.schedule_details, { start_date: "2026-10-01", end_date: "2026-10-03" }), "2026-09-28");
const overlap = record("overlap", "重叠酒店", "2026-09-29", "2026-10-01");
assert.ok(schedules.scheduleDayNotice(schedules.scheduleDayEntries([...records, overlap], "2026-09-30")).conflict);
overlap.plan_status = "cancelled";
assert.equal(schedules.scheduleDayNotice(schedules.scheduleDayEntries([...records, overlap], "2026-09-30")).conflict, "");
for (const details of [null, {}, { kind: "hotel", start_date: "2026-09-30", end_date: "2026-09-30" }, { kind: "all_day", start_date: "2026-02-30", end_date: "2026-03-02" }, { ...oldHotel.schedule_details, check_in_time: "25:00" }]) assert.equal(schedules.normalizeScheduleDetails(details), null);
assert.ok(schedules.normalizeScheduleDetails({ kind: "all_day", start_date: "2026-09-30", end_date: "2026-09-30" }));
assert.equal(getTransportPresentation(oldHotel).label, "酒店住宿");
assert.equal(JSON.stringify(records), unchanged, "Day projection must not duplicate or mutate stored records");

const stop = (date, time, airport, iata, timezone) => ({ date, time, airport, iata, timezone, terminal: "B" });
const plan = { flight_number: "NH105", airline: "ANA", departure: stop("2026-09-29", "00:50", "洛杉矶国际机场 (LAX)", "LAX", "America/Los_Angeles"), arrival: stop("2026-09-30", "05:00", "东京羽田国际机场 (HND)", "HND", "Asia/Tokyo"), seat: "22A", gate: "10", aircraft_type: "787-9" };
const actualStop = (planStop, actualTime) => ({ ...planStop, scheduled: { ...planStop, iso: null }, estimated: { date: "", time: "", iso: null }, actual: { date: planStop.date, time: actualTime, iso: null }, delay_minutes: 4, gate: "62" });
const flight = { transport_type: "flight", transport_details: plan, actual_info_matched: true, actual_info: { flight_number: "NH105", airline: "ANA", status: "landed", departure: actualStop(plan.departure, "00:58"), arrival: actualStop(plan.arrival, "05:04"), aircraft_type: "78X", registration: "JA123A" } };
const flightOriginal = JSON.stringify(flight);
const view = flightDisplay(flight);
assert.equal(view.departureSource, "actual");
assert.equal(view.details.departure.time, "00:58");
assert.equal(view.details.aircraft_type, "787-10");
assert.equal(view.details.gate, "62");
assert.equal(view.details.seat, "22A");
assert.equal(view.durationLabel, "实际起降用时");
assert.equal(getTransportPresentation(flight).subtitle, "ANA · 登机口 62 · 座位 22A");
assert.equal(JSON.stringify(flight), flightOriginal, "Matched view must preserve original plan");
const missing = JSON.parse(JSON.stringify(flight));
missing.actual_info.departure.actual = { date: "", time: "", iso: null };
missing.actual_info.departure.estimated = { date: plan.departure.date, time: "01:10", iso: null };
missing.actual_info.arrival.actual = { date: "", time: "", iso: null };
missing.actual_info.arrival.scheduled = { date: "", time: "", iso: null };
missing.actual_info.aircraft_type = "";
missing.actual_info.departure.gate = "";
const partial = flightDisplay(missing);
assert.equal(partial.departureSource, "estimated");
assert.equal(partial.arrivalSource, "planned");
assert.equal(partial.details.arrival.time, plan.arrival.time);
assert.equal(partial.details.aircraft_type, plan.aircraft_type);
assert.equal(partial.details.gate, plan.gate);
assert.equal(partial.durationLabel, "参考起降用时（含计划值）");
missing.actual_info_matched = false;
assert.equal(flightDisplay(missing).matched, false);
assert.equal(flightDisplay(missing).details.departure.time, plan.departure.time);
assert.equal(flightDisplay(oldHotel), null);
const repeatedPlan={...plan,departure:{...plan.departure,date:"2026-11-01",time:"01:30",utc_offset_minutes:-420},arrival:{...plan.arrival,date:"2026-11-02",time:"03:30"}};
const repeatedFlight={transport_type:"flight",transport_details:repeatedPlan,actual_info_matched:true,flight_plan_version:1,actual_match_plan_version:1,actual_info:{...flight.actual_info,departure:{...actualStop(repeatedPlan.departure,"01:30"),actual:{date:"2026-11-01",time:"01:30",iso:"2026-11-01T01:30:00-08:00"}},arrival:actualStop(repeatedPlan.arrival,"03:30")}};
assert.equal(flightDisplay(repeatedFlight).details.departure.utc_offset_minutes,-480,"Actual clock must use its own proven occurrence, not the plan's first occurrence");
repeatedFlight.actual_info.departure.actual.iso="2026-11-01T01:30:00+00:00";
assert.equal(flightDisplay(repeatedFlight).details.departure.utc_offset_minutes,undefined,"Unproven ambiguous provider offset must not inherit the plan choice");
assert.equal(load("flightDuration").calculateFlightDuration(flightDisplay(repeatedFlight).details.departure,flightDisplay(repeatedFlight).details.arrival).status,"invalid");
const providerZero=JSON.parse(JSON.stringify(flight));
providerZero.actual_info.departure.actual.iso="2026-09-29T00:58:00+00:00";
providerZero.actual_info.arrival.actual.iso="2026-09-30T05:04:00+00:00";
const zeroView=flightDisplay(providerZero);
assert.equal(zeroView.details.departure.utc_offset_minutes,undefined);assert.equal(zeroView.details.arrival.utc_offset_minutes,undefined);
assert.equal(load("flightDuration").calculateFlightDuration(zeroView.details.departure,zeroView.details.arrival).status,"ready","Unique airport-local clocks must not break on provider's conflicting +00 suffix");
const normalized=load("transport").normalizeTransportDetails("flight",{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:-480}});
assert.equal(normalized.departure.utc_offset_minutes,-480);
assert.equal(load("transport").normalizeTransportDetails("flight",{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:"-480"}}).departure.utc_offset_minutes,undefined);
console.log("PASS: all-day inclusive dates, hotel nights/checkout/switch/overlap/cancel, trip overlap, legacy data, matched/estimated/scheduled/planned priorities and immutable original records.");

````

## scripts/test-second-audit-route-admin.mjs

<!-- source: scripts/test-second-audit-route-admin.mjs sha256: 74b75a5e968e7259dde21d5f67c107dcd826b875310ebcc6e8de557b38b1c1f7 encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
const root=process.env.LIFE_TRACKER_AUDIT_SOURCE||process.cwd(), require=createRequire(resolve(root,"package.json")), ts=require("typescript");
const modules=new Map();
function load(file){file=resolve(root,file);if(!/\.tsx?$/.test(file))file+=".ts";if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);runInNewContext(ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Intl,Error,require:name=>load(resolve(dirname(file),name))});return exports;}
function extract(path,names,globals){const source=readFileSync(resolve(root,path),"utf8"),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,path.endsWith("tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS), nodes=new Map();function walk(node){if(ts.isFunctionDeclaration(node)&&node.name)nodes.set(node.name.text,node);ts.forEachChild(node,walk);}walk(ast);const exports={};runInNewContext(ts.transpileModule(names.map(name=>`export ${nodes.get(name).getText(ast)}`).join("\n"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Intl,Error,...globals});return {exports,source};}
const trip={id:"trip",start_date:"2026-11-01",end_date:"2026-11-02",timezone:"America/Los_Angeles"},dates=load("src/lib/tripDates.ts"),transport=load("src/lib/transport.ts");
async function saveRoute(planTime,localOffset){let saved,error="",closed=false;const {exports}=extract("src/components/HomeRouteSearch.tsx",["saveRoute"],{availableTrips:[trip],tripId:"trip",result:"synthetic AI route",planDate:"2026-11-01",planTime,localOffset,origin:"A",destination:"B",records:[],transportTitle:transport.transportTitle,dateInZone:dates.dateInZone,zonedDateTimeToIso:dates.zonedDateTimeToIso,onSave:async value=>{saved=value;},close:()=>{closed=true;},setSaving(){},setError:value=>{error=value;}});await exports.saveRoute();return {saved,error,closed};}
const normal=await saveRoute("00:30");assert.ok(normal.saved);assert.equal(normal.closed,true);
const repeated=await saveRoute("01:30");assert.equal(repeated.saved,undefined);assert.equal(repeated.closed,false);assert.match(repeated.error,/两次/);
const routeSource=readFileSync(resolve(root,"src/components/HomeRouteSearch.tsx"),"utf8");assert.match(routeSource,/aria-label="重复当地时间"/);assert.match(routeSource,/localChoice.key === localKey/);
const first=await saveRoute("01:30",-420),second=await saveRoute("01:30",-480);
assert.equal(first.saved.event_at,"2026-11-01T08:30:00.000Z");assert.equal(second.saved.event_at,"2026-11-01T09:30:00.000Z");

// R2-05: execute actual Owner list function with realistic capped reads.
const users=Array.from({length:1001},(_,index)=>({id:`user-${index}`,email:index===1000?"target@example.invalid":`user-${index}@example.invalid`,created_at:"2026-10-01T00:00:00Z"}));
const events=Array.from({length:1100},(_,i)=>({id:String(i).padStart(6,"0"),user_id:"user-0",service:"deepseek",feature:"note_polish"}));let requests=[],failPage=false,failUsage=false;
const api={auth:{admin:{listUsers:async args=>{requests.push(args);return {data:{users:users.slice((args.page-1)*args.perPage,args.page*args.perPage)},error:failPage&&args.page===2?new Error("page failed"):null};}}},from(table){let cursor=null,ids=[];const chain={select(){return chain;},in(_key,value){ids=value;return chain;},is(){return chain;},eq(){return chain;},gte(){return chain;},lt(){return chain;},order(){return chain;},limit(){return chain;},gt(_key,value){cursor=value;return chain;},then(yes,no){return Promise.resolve({data:table==="api_entitlements"?[]:events.filter(event=>(!cursor||event.id>cursor)&&ids.includes(event.user_id)).slice(0,73),error:failUsage&&cursor?new Error("usage page failed"):null}).then(yes,no);}};return chain;}};
class ApiError extends Error{}
const {exports:owner}=extract("supabase/functions/owner-admin/index.ts",["monthStart","listUsers"],{admin:()=>api,ApiError,readAllPages:load("supabase/functions/_shared/pagination.ts").readAllPages});
assert.equal((await owner.listUsers("user-0@"))[0].monthUsage.deepseek,1100);
assert.equal((await owner.listUsers("target@example.invalid")).length,1);
assert.equal(requests.some(args=>args.page===3),true);
failPage=true;await assert.rejects(owner.listUsers("user-0@"));failPage=false;
failUsage=true;await assert.rejects(owner.listUsers("user-0@"));
console.log("PASS R2-04/05: route saves either repeated local clock without re-querying AI; Owner finds account #1001 and counts 1100 events despite 73-row cap; any page failure refuses partial totals.");

````

## scripts/test-second-audit-summary.mjs

<!-- source: scripts/test-second-audit-summary.mjs sha256: 931d3ea30e79c8c482445778c6cdde0af44cdfa6271b94f3cba5c3dd43386b60 encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript"), idb = require("idb"), fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
function offline() { const exports = {}; runInNewContext(ts.transpileModule(readFileSync(resolve(root,"src/lib/offline.ts"),"utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, Date, crypto, ...fake, require: name => { assert.equal(name,"idb"); return idb; } }); return exports; }
let box = offline();
const source = readFileSync(resolve(root,"src/App.tsx"),"utf8"), ast = ts.createSourceFile("App.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect;
function walk(node) { if (ts.isCallExpression(node) && node.expression.getText(ast)==="useEffect" && node.arguments[0]?.getText(ast).includes("summaryRequests.current.get(requestKey)")) effect=node.arguments[0]; ts.forEachChild(node,walk); }
walk(ast); assert.ok(effect);
let summary="", calls=0;
const context={exports:{}, user:{id:"owner"}, data:{profile:{user_id:"owner"},records:[]}, currentTrip:{id:"trip",timezone:"Asia/Tokyo"}, validTimeZone:()=>true, demoMode:false, online:true, dailySummary:"", clockNow:new Date("2026-10-03T00:00:00Z"), summaryContext:"stable-context", summaryRequests:{current:new Map()}, activeOwner:{current:"owner"}, tripToday:()=>"2026-10-03", plansForDay:()=>[{plan_status:"planned"}],
  claimAutomaticSummary:(...args)=>box.claimAutomaticSummary(...args), loadAutomaticSummary:(...args)=>box.loadAutomaticSummary(...args), saveAutomaticSummary:(...args)=>box.saveAutomaticSummary(...args), generateDailySummary:async()=>{calls++;return {result:"already persisted summary",persisted:true};}, setDailySummary:value=>{summary=value;}, showToast(){} };
runInNewContext(ts.transpileModule(`export const run=${effect.getText(ast)}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
async function settle(){for(let i=0;i<25;i++)await new Promise(resolve=>setImmediate(resolve));}
context.exports.run(); await settle(); assert.equal(calls,1); assert.equal(summary,"already persisted summary");
// A fresh window has no React state/map but does retain IndexedDB attempt marker.
box=offline(); summary="";context.dailySummary="";context.summaryRequests={current:new Map()};
for(let i=0;i<3;i++){context.clockNow=new Date(Date.parse("2026-10-03T00:00:00Z")+i*30000);context.exports.run();await settle();}
assert.equal(calls,1);assert.equal(summary,"already persisted summary");
assert.equal(await box.loadAutomaticSummary("another-owner", "stable-context"), undefined);
assert.equal(await box.loadAutomaticSummary("owner", "another-day"), undefined);
// A full or unavailable IndexedDB must not discard an already generated result.
summary=""; context.dailySummary=""; context.summaryContext="cache-failure"; let notice="";
context.saveAutomaticSummary=async()=>{throw new Error("storage unavailable");};
context.showToast=value=>{notice=value;};
context.exports.run(); await settle();
assert.equal(calls,2); assert.equal(summary,"already persisted summary"); assert.match(notice,/无法缓存/);
console.log("PASS R2-03: actual App effect restores successful summary after reload, preserves results on cache failure, and isolates owner/day.");

````

## scripts/test-second-audit-sync.mjs

<!-- source: scripts/test-second-audit-sync.mjs sha256: 5937738571841d2885cfbf3645052886d8fceefa9e69c8f5ee54ca2f3ee5b22b encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript"), idb = require("idb"), fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const modules = new Map(), stubs = new Map();
function load(file) {
  file = resolve(root, file); if (!/\.tsx?$/.test(file)) file += ".ts";
  if (stubs.has(file)) return stubs.get(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date, Intl, Error, TypeError, console, crypto, ...fake, require: name => name === "idb" ? idb : load(resolve(dirname(file), name)) });
  return exports;
}
const box = load("src/lib/offline.ts"), engine = load("src/lib/syncEngine.ts");
const v0 = "2026-10-03T00:00:00.000Z", cloud = new Map(); let sends = 0;
const queue = (owner, content, expected = v0) => box.queueMutation({ ownerId: owner, table: "records", operation: "upsert", expectedUpdatedAt: expected,
  payload: { id: "record", user_id: owner, content, record_type: "note", event_at: v0, updated_at: v0, created_at: v0, trip_id: null, parent_plan_id: null, transport_type: null, transport_details: null } });
function adapter(owner) {
  return { currentOwner: async () => owner, claim: box.claimMutation, finish: box.finishMutation, fail: box.failMutation,
    write: async item => { sends++; if (item.payload.content.length > 4000) return { data: null, error: { code: "23514", message: "content too long" } };
      const old = cloud.get(owner); if ((old?.updated_at || null) !== item.expectedUpdatedAt) return { data: { ok: false, code: "CONFLICT" }, error: null };
      const row = { ...item.payload, updated_at: new Date(Date.parse(v0) + sends * 1000).toISOString() }; cloud.set(owner, row); return { data: { ok: true, row }, error: null }; } };
}
// Control: a rejected leaf corrected after failure can still confirm.
cloud.set("control", { updated_at: v0, content: "cloud" });
const rejected = await queue("control", "x".repeat(4001));
assert.equal((await engine.replayMutation(rejected, adapter("control"))).state, "failed");
const correction = await queue("control", "corrected");
assert.equal((await engine.replayMutation(correction, adapter("control"))).state, "confirmed");
assert.equal(cloud.get("control").content, "corrected");

// R2-01: a correction already queued behind an inflight ancestor cannot repair
// that ancestor once the ancestor receives a permanent rejection.
cloud.set("chain", { updated_at: v0, content: "cloud" });
const a = await queue("chain", "x".repeat(4001));
const claimed = await box.claimMutation(a.id, "chain");
const b = await queue("chain", "valid edit during slow save"); assert.equal(b.dependsOn, a.id);
await box.failMutation(claimed, "failed", "content constraint rejected");
const c = await queue("chain", "valid latest correction");
assert.equal(c.dependsOn, null);
assert.deepEqual(Array.from(c.replacesFailed || []), [a.id]);
const before = sends;
for (const item of await box.listMutations("chain")) await engine.replayMutation(item, adapter("chain"));
assert.equal(sends, before + 1); assert.equal(cloud.get("chain").content, "valid latest correction");
await box.retryFailedMutations("chain");
for (const item of await box.listMutations("chain")) await engine.replayMutation(item, adapter("chain"));
assert.equal(cloud.get("chain").content, "valid latest correction");
assert.equal((await box.listMutations("chain")).find(item => item.id === a.id).state, "failed");

// R2-02: even a new edit deliberately based on the current cloud version can
// confirm but the old conflict is left active and overlays it on actual fetch.
cloud.set("conflict", { updated_at: v0, content: "cloud", id: "record", user_id: "conflict", record_type: "note", event_at: v0 });
const conflict = await queue("conflict", "old conflicting draft", "2026-10-02T00:00:00Z");
assert.equal((await engine.replayMutation(conflict, adapter("conflict"))).state, "conflict");
const reconciled = await queue("conflict", "explicitly reconciled draft", v0);
assert.equal(await engine.replayMutation(reconciled, adapter("conflict")), null, "Ordinary edits cannot silently resolve a conflict");
const inspected = await box.listMutations("conflict");
const resolution = await box.reconcileMutations(inspected, cloud.get("conflict"), "local");
assert.equal((await engine.replayMutation(resolution, adapter("conflict"))).state, "confirmed");
assert.equal(cloud.get("conflict").content, "explicitly reconciled draft");
const client = {
  auth: { getSession: async () => ({ data: { session: { user: { id: "conflict" }, access_token: "synthetic" } } }) },
  from(table) { let cursor; const chain = { select() { return chain; }, order() { return chain; }, limit() { return chain; }, eq() { return chain; }, is() { return chain; }, gt(_key, value) { cursor = value; return chain; },
    maybeSingle: async () => ({ data: table === "profiles" ? { user_id: "conflict" } : { user_id: "conflict", theme: "dark", base_currency: "USD" }, error: null }),
    then(yes, no) { return Promise.resolve({ data: table === "records" && !cursor ? [cloud.get("conflict")] : [], error: null }).then(yes, no); } }; return chain; }
};
stubs.set(resolve(root, "src/lib/supabase.ts"), { supabase: client });
const fetched = await load("src/lib/data.ts").fetchAppData({ id: "conflict", email: "synthetic@example.invalid", user_metadata: {} });
assert.equal(fetched.records[0].content, "explicitly reconciled draft");
assert.equal((await box.loadSnapshot("conflict")).records[0].content, "explicitly reconciled draft");
assert.ok((await box.listMutations("conflict")).every(item => item.supersededBy));

// Stale local review, unknown send state and a new cloud writer all fail closed.
cloud.set("race", { updated_at: v0, content: "cloud" });
const race = await queue("race", "draft", "stale");
await engine.replayMutation(race, adapter("race"));
const reviewed = await box.listMutations("race");
await queue("race", "new edit");
await assert.rejects(box.reconcileMutations(reviewed, cloud.get("race"), "cloud"), /已变化/);
const current = await box.listMutations("race");
const queued = await box.reconcileMutations(current, cloud.get("race"), "local");
cloud.set("race", { updated_at: "2026-10-04T00:00:00Z", content: "another device" });
assert.equal((await engine.replayMutation(queued, adapter("race"))).state, "conflict");
assert.equal(cloud.get("race").content, "another device");
assert.ok((await box.listMutations("race")).every(item => !item.supersededBy));
await box.reconcileMutations(await box.listMutations("race"), cloud.get("race"), "cloud");
assert.ok((await box.listMutations("race")).every(item => item.supersededBy));
const unknown = await queue("unknown", "may have committed"); await box.claimMutation(unknown.id, "unknown");
await assert.rejects(box.reconcileMutations(await box.listMutations("unknown"), null, "cloud"), /未确认/);
console.log("PASS R2-01/02: failed ancestor bypass, retained histories, explicit conflict review, confirmed fetch/cache, stale review/unknown send blocked, concurrent cloud CAS preserved, cloud choice archives without a write. Synthetic services only.");

````

## scripts/test-self-audit-ai.mjs

<!-- source: scripts/test-self-audit-ai.mjs sha256: 9b30b26de0dae3551d5514b586a5f276915099f4946fd481c1ea33d229def546 encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Execute the actual App daily-summary effect, with a rejecting AI substitute.
// No real AI, Supabase, HTTP requests or billed tokens are used.
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript");
const idb = require("idb"), fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const offlineSource = resolve(root, "src/lib/offline.ts");
function loadOffline() {
  const exports = {};
  const code = ts.transpileModule(readFileSync(offlineSource, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, ...fake, crypto, Date, require: name => { assert.equal(name, "idb"); return idb; } });
  return exports;
}
let offline = loadOffline();
const file = resolve(root, "src/App.tsx"), source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectNode, dependencyNode;
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("summaryRequests.current.get(requestKey)")) {
    effectNode = node.arguments[0]; dependencyNode = node.arguments[1];
  }
  ts.forEachChild(node, walk);
}
walk(ast); assert.ok(effectNode);
assert.match(dependencyNode.getText(ast), /clockNow/);
assert.match(source, /setInterval\(\(\) => setClockNow\(new Date\(\)\), 30_000\)/);
const map = new Map(), summaryRequests = { current: map };
let calls = 0, dailySummary = "", shouldFail = true;
const globals = {
  exports: {}, user: { id: "synthetic-owner" }, data: { profile: { user_id: "synthetic-owner" }, records: [] },
  currentTrip: { id: "synthetic-trip", timezone: "Asia/Tokyo" }, validTimeZone: () => true, demoMode: false, online: true,
  plansForDay: () => [{ plan_status: "planned" }], tripToday: () => "2026-10-02", summaryContext: "unchanged-context",
  summaryRequests, generateDailySummary: async () => { calls++; if (shouldFail) throw new Error("synthetic upstream failure"); return { result: "synthetic successful summary" }; },
  claimAutomaticSummary: (...args) => offline.claimAutomaticSummary(...args), loadAutomaticSummary: (...args) => offline.loadAutomaticSummary(...args), saveAutomaticSummary: (...args) => offline.saveAutomaticSummary(...args), activeOwner: { current: "synthetic-owner" },
  setDailySummary: value => { dailySummary = value; }, showToast() {}
};
const code = ts.transpileModule(`export const run = ${effectNode.getText(ast)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { ...globals, clockNow: new Date("2026-10-02T00:00:00Z"), dailySummary };
runInNewContext(code, context, { filename: file });
const observations = [];
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
for (const second of [0, 30, 60]) {
  context.clockNow = new Date(Date.parse("2026-10-02T00:00:00Z") + second * 1000);
  context.dailySummary = dailySummary;
  const cleanup = context.exports.run();
  await settle();
  assert.equal(map.size, 0, "Failure removes single-flight entry");
  assert.equal(dailySummary, "");
  observations.push({ second, calls, summary: dailySummary });
  cleanup?.();
}
assert.equal(calls, 1, "Failure does not trigger automatic retries on 30-second ticks");
// Reloading the module/window preserves admission history, not just in-memory single flight.
offline = loadOffline(); context.summaryRequests = { current: new Map() };
context.exports.run(); await settle(); assert.equal(calls, 1);
// Positive control: a new day's context can generate a summary once.
shouldFail = false; context.dailySummary = dailySummary; context.summaryContext = "next-day-context";
context.exports.run(); await settle();
assert.equal(calls, 2); assert.equal(dailySummary, "synthetic successful summary");
context.dailySummary = dailySummary;
assert.equal(context.exports.run(), undefined); assert.equal(calls, 2);
// Another account is isolated; an account switch during asynchronous admission must not send AI.
context.dailySummary = ""; context.summaryContext = "switched-context";
context.activeOwner.current = "other-owner";
context.exports.run(); await settle(); assert.equal(calls, 2);
context.user = { id: "other-owner" }; context.data.profile.user_id = "other-owner";
context.exports.run(); await settle(); assert.equal(calls, 3);
// Manual retry remains an explicit Settings action, not a background timer.
assert.match(readFileSync(resolve(root, "src/components/SettingsPanel.tsx"), "utf8"), /await generateDailySummary\(summaryContext\)/);
console.log(JSON.stringify({ sourceRoot: root, case: "SA-05", mode: "actual AST-extracted App effect + rejecting AI mock; no billed API calls", observations,
  result: "PASS: one failed automatic attempt, no clock/reload retry, new context admitted, account switch blocked, other account isolated; explicit Settings retry available",
  limitation: "Disposable IndexedDB and synthetic upstream only; no real provider or iOS browser exercised" }, null, 2));

````

## scripts/test-self-audit-calendar.mjs

<!-- source: scripts/test-self-audit-calendar.mjs sha256: 4bf943ab8bbd1568ba488cd0bc0bc7a75d65aacc9372c93aba3dcba86096f81a encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Actual pure modules and actual editor handler extracted from its AST.
// Synthetic records only; no React browser, network, production DB or APIs.
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript");
const modules = new Map();
function load(file) {
  file = resolve(root, file); if (!/\.tsx?$/.test(file)) file += ".ts";
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Date, Intl, Error, console, require: dependency => load(resolve(dirname(file), dependency)) }, { filename: file });
  return exports;
}
const calendar = load("src/lib/calendar.ts"), dates = load("src/lib/tripDates.ts"), flightState = load("src/lib/flightMatchState.ts");
const transport = load("src/lib/transport.ts"), schedules = load("src/lib/schedules.ts");
const editorFile = resolve(root, "src/components/TransportPlanEditor.tsx");
const editorSource = readFileSync(editorFile, "utf8");
const ast = ts.createSourceFile(editorFile, editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function walk(node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node); ts.forEachChild(node, walk); }
walk(ast);
assert.ok(functions.has("submit") && functions.has("timeInZone"));
function extract(name, globals = {}) {
  const exports = {};
  const source = `export ${functions.get(name).getText(ast)}`;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date, Intl, Error, ...globals });
  return exports[name];
}
const timeInZone = extract("timeInZone");
async function submitGeneral({ day, trip, record, time, localOffset, kind = "general", rail, metro, schedule, storedSchedule }) {
  let output, error = "", closed = false, saving = false;
  const submit = extract("submit", { day, trip, record, time, localOffset, kind, rail, metro, schedule, storedSchedule, transportTitle: transport.transportTitle, scheduleValidation: schedules.scheduleValidation, normalizeScheduleDetails: schedules.normalizeScheduleDetails, content: record?.content || "synthetic plan", location: "", notes: "", count: 0,
    zonedDateTimeToIso: dates.zonedDateTimeToIso, invalidateChangedFlight: flightState.invalidateChangedFlight,
    setSaving: value => { saving = value; }, setError: value => { error = value; },
    onSave: async value => { output = value; }, onUpdate: async value => { output = value; }, onClose: () => { closed = true; } });
  await submit({ preventDefault() {} });
  return { output, error, closed, saving };
}
const results = [];
const trip = { id: "synthetic-trip", timezone: "Asia/Tokyo", start_date: "2026-09-29", end_date: "2026-09-30" };
const record = { id: "synthetic-record", user_id: "synthetic-owner", record_type: "trip", content: "00:30 Tokyo plan", event_at: "2026-09-28T15:30:00.000Z", trip_id: trip.id, transport_type: null, transport_details: null, schedule_details: null, plan_status: "planned", sort_order: 1000 };
// Positive control: editor date in the same business timezone preserves time.
const control = await submitGeneral({ day: calendar.timelineDate(record, trip.timezone), trip, record, time: timeInZone(record.event_at, trip.timezone) });
assert.equal(control.output.event_at, record.event_at);
results.push({ case: "control", observed: "same business timezone no-op edit preserves instant" });

// SA-03: grouping still uses device date, but editing uses business timezone.
assert.match(readFileSync(resolve(root, "src/components/Timeline.tsx"), "utf8"), /day=\{timelineDate\(editingRecord, editingTrip.timezone\)\}/);
const deviceZone = "America/Los_Angeles", deviceDay = calendar.timelineDate(record, deviceZone);
assert.equal(deviceDay, "2026-09-28");
const edited = await submitGeneral({ day: calendar.timelineDate(record, trip.timezone), trip, record, time: timeInZone(record.event_at, trip.timezone) });
assert.equal(edited.error, ""); assert.equal(edited.closed, true);
assert.equal(edited.output.event_at, record.event_at);

// SA-04: valid calendar date but nonexistent DST local clock must be rejected.
const gapTrip = { ...trip, timezone: "America/Los_Angeles", start_date: "2026-03-08", end_date: "2026-03-09" };
const gap = await submitGeneral({ day: "2026-03-08", trip: gapTrip, time: "02:30" });
assert.match(gap.error, /不存在/); assert.equal(gap.closed, false); assert.equal(gap.output, undefined); assert.equal(gap.saving, false);
const repeat = { ...gapTrip, start_date: "2026-11-01", end_date: "2026-11-02" };
const ambiguous = await submitGeneral({ day: "2026-11-01", trip: repeat, time: "01:30" });
assert.match(ambiguous.error, /两次/); assert.equal(ambiguous.output, undefined);
const first = await submitGeneral({ day: "2026-11-01", trip: repeat, time: "01:30", localOffset: -420 });
const second = await submitGeneral({ day: "2026-11-01", trip: repeat, time: "01:30", localOffset: -480 });
assert.equal(Date.parse(second.output.event_at) - Date.parse(first.output.event_at), 3_600_000);
const existingRepeat = { ...record, event_at: second.output.event_at.replace(":00.000Z", ":27.000Z") };
const unchanged = await submitGeneral({ day: "2026-11-01", trip: repeat, record: existingRepeat, time: "01:30" });
assert.equal(unchanged.output.event_at, existingRepeat.event_at, "No-op edit preserves original repeated occurrence and seconds");
assert.match(editorSource, /重复当地时间 · 必选/);
for (const zone of ["Asia/Tokyo", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kathmandu"]) {
  const instant = dates.zonedDateTimeToIso("2026-10-02", "09:30", zone);
  assert.equal(timeInZone(instant, zone), "09:30");
}
assert.throws(() => dates.zonedDateTimeToIso("2026-02-30", "09:30", "UTC"));
for (const kind of ["rail", "metro"]) {
  const rail = { system_type: "china_hsr", train_number: "G1", departure: { date: "2026-03-08", time: "02:30", station: "A" }, arrival: { date: "2026-03-08", time: "04:00", station: "B" } };
  const metro = { origin: "A", destination: "B", estimated_departure_time: "02:30" };
  const bad = await submitGeneral({ day: "2026-03-08", trip: gapTrip, kind, rail, metro });
  assert.match(bad.error, /不存在/); assert.equal(bad.closed, false); assert.equal(bad.output, undefined);
  rail.departure = { ...rail.departure, date: "2026-11-01", time: "01:30" }; metro.estimated_departure_time = "01:30";
  const good = await submitGeneral({ day: "2026-11-01", trip: repeat, kind, rail, metro, localOffset: -480 });
  assert.equal(good.error, ""); assert.equal(good.output.event_at, second.output.event_at);
}
const allDay = { kind: "all_day", start_date: "2026-03-08", end_date: "2026-03-08" };
const dateOnly = await submitGeneral({ day: "2026-03-08", trip: gapTrip, kind: "all_day", schedule: allDay });
assert.equal(dateOnly.error, ""); assert.equal(timeInZone(dateOnly.output.event_at, gapTrip.timezone), "12:00");
const oldDateOnly = await submitGeneral({ day: "2026-03-08", trip: gapTrip, kind: "all_day", schedule: allDay, storedSchedule: allDay, record });
assert.equal(oldDateOnly.output.event_at, record.event_at, "Existing date-only anchor is not rewritten");
// Execute the actual planner drop handler, not a duplicated date conversion.
const plannerFile = resolve(root, "src/components/Planner.tsx"), plannerSource = readFileSync(plannerFile, "utf8");
const plannerAst = ts.createSourceFile(plannerFile, plannerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const plannerFunctions = new Map();
function findDrag(node) { if (ts.isFunctionDeclaration(node) && node.name) plannerFunctions.set(node.name.text, node); ts.forEachChild(node, findDrag); }
findDrag(plannerAst); assert.ok(plannerFunctions.has("handleDragEnd"));
for (const [sourceDay, targetDay, clock] of [["2026-03-07", "2026-03-08", "02:30"], ["2026-10-31", "2026-11-01", "01:30"]]) {
  const original = { ...record, event_at: dates.zonedDateTimeToIso(sourceDay, clock, gapTrip.timezone) };
  let updated = false, pending;
  const exports = {};
  const dragCode = ["planDate", "chronological", "handleDragEnd"].map(name => `export ${plannerFunctions.get(name).getText(plannerAst)}`).join("\n");
  runInNewContext(ts.transpileModule(dragCode, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Date, Intl, plans: [original], trip: gapTrip, dateInZone: dates.dateInZone, normalizeScheduleDetails: schedules.normalizeScheduleDetails, zonedDateTimeToIso: dates.zonedDateTimeToIso, invalidateChangedFlight: flightState.invalidateChangedFlight,
      onUpdateRecord: async () => { updated = true; }, setPendingFlightMove: value => { pending = value; } });
  await exports.handleDragEnd({ active: { id: original.id }, over: { id: `day:${targetDay}` } });
  assert.equal(updated, false); assert.equal(pending.day, targetDay); assert.equal(pending.original.event_at, original.event_at);
}
console.log("PASS SA-03/04: business-date no-op editing, general/rail/metro DST gap and repeat choices, exact occurrence/seconds, date-only anchor preservation, and actual planner gap/repeat drag keeps original for confirmation.");

````

## scripts/test-self-audit-sync.mjs

<!-- source: scripts/test-self-audit-sync.mjs sha256: 681d4d70622ac23deeec06331b7ece699be6955b0915ab586a5e25dab03e0d76 encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Read actual candidate sources; use only disposable fake IndexedDB and a
// deterministic receipt/CAS server substitute. Never contact Supabase or APIs.
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json"));
const ts = require("typescript"), idb = require("idb");
const fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const stubs = new Map(), modules = new Map();
function load(file) {
  file = resolve(root, file); if (!/\.tsx?$/.test(file)) file += ".ts";
  if (stubs.has(file)) return stubs.get(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date, Intl, Error, TypeError, console, crypto, ...fake,
    require: dependency => dependency === "idb" ? idb : load(resolve(dirname(file), dependency)) }, { filename: file });
  return exports;
}
const oldDb = await idb.openDB("life-tracker", 2, { upgrade(db) { db.createObjectStore("snapshots", { keyPath: "userId" }); const store = db.createObjectStore("outbox", { keyPath: "id" }); store.createIndex("by-created", "createdAt"); store.createIndex("by-owner", "ownerId"); } });
const oldItem = { id: crypto.randomUUID(), ownerId: "old-v2", entityId: "old-record", table: "records", operation: "upsert", payload: { id: "old-record", user_id: "old-v2", content: "old" }, state: "pending", expectedUpdatedAt: null, dependsOn: null, createdAt: "2026-10-01T00:00:00Z" };
await oldDb.put("outbox", oldItem); oldDb.close();
const box = load("src/lib/offline.ts"), engine = load("src/lib/syncEngine.ts");
const upgraded = await box.queueMutation({ ownerId: "old-v2", table: "records", operation: "upsert", payload: { ...oldItem.payload, content: "edited" }, expectedUpdatedAt: null });
assert.equal(upgraded.dependsOn, oldItem.id, "Unknown v2 send history is preserved conservatively during v3 upgrade");
assert.equal((await box.listMutations("old-v2")).length, 2);
const cloud = new Map(), receipts = new Map(); let sequence = 0, loseResponse = false, rejectWrite = false;
const baseVersion = "2026-10-02T00:00:00.000Z";
function server(item) {
  const body = JSON.stringify([item.table, item.payload, item.expectedUpdatedAt]);
  const previousReceipt = receipts.get(item.id);
  if (previousReceipt) { assert.equal(previousReceipt.body, body); return previousReceipt.response; }
  const key = `${item.ownerId}:${item.entityId}`, previous = cloud.get(key);
  if ((previous?.updated_at || null) !== item.expectedUpdatedAt) return { data: { ok: false, code: "CONFLICT" }, error: null };
  const row = { ...item.payload, updated_at: new Date(Date.parse(baseVersion) + ++sequence * 1000).toISOString() };
  cloud.set(key, row);
  const response = { data: { ok: true, row }, error: null };
  receipts.set(item.id, { body, response });
  return response;
}
function adapter(ownerId) {
  return { currentOwner: async () => ownerId, claim: box.claimMutation, finish: box.finishMutation, fail: box.failMutation,
    write: async item => {
      if (rejectWrite) return { data: null, error: { code: "42501", message: "synthetic RLS rejection" } };
      const response = server(item);
      if (loseResponse) { loseResponse = false; throw new TypeError("Failed to fetch after server commit"); }
      return response;
    } };
}
const queue = (ownerId, id, content, expectedUpdatedAt = null) => box.queueMutation({ ownerId, table: "records", operation: "upsert", expectedUpdatedAt,
  payload: { id, user_id: ownerId, record_type: "note", content, event_at: baseVersion, updated_at: baseVersion, created_at: baseVersion, trip_id: null, parent_plan_id: null, transport_type: null, transport_details: null } });
const results = [];

// Positive control: receipt retry with the same UUID is correctly idempotent.
const control = await queue("control", "same-id", "v1"); loseResponse = true;
assert.equal((await engine.replayMutation(control, adapter("control"))).state, "pending");
assert.equal((await engine.replayMutation(control, adapter("control"))).state, "confirmed");
assert.equal((await box.listMutations("control")).length, 0);
results.push({ case: "control", observed: "same UUID retry confirms saved row" });

// SA-01: retain committed UUID, replay its receipt, then rebase the successor.
for (const existing of [false, true]) {
  const owner = existing ? "lost-update" : "lost-create", entity = "record";
  if (existing) cloud.set(`${owner}:${entity}`, { id: entity, user_id: owner, content: "v0", updated_at: baseVersion });
  const first = await queue(owner, entity, "v1", existing ? baseVersion : null);
  loseResponse = true;
  assert.equal((await engine.replayMutation(first, adapter(owner))).state, "pending");
  assert.equal(cloud.get(`${owner}:${entity}`).content, "v1");
  const second = await queue(owner, entity, "v2", existing ? baseVersion : null);
  assert.notEqual(second.id, first.id);
  assert.equal(second.dependsOn, first.id);
  assert.equal((await box.listMutations(owner)).some(item => item.id === first.id), true);
  assert.equal(await engine.replayMutation(second, adapter(owner)), null);
  modules.delete(resolve(root, "src/lib/offline.ts"));
  const reloaded = load("src/lib/offline.ts");
  const nextAdapter = { ...adapter(owner), claim: reloaded.claimMutation, finish: reloaded.finishMutation, fail: reloaded.failMutation };
  assert.equal((await engine.replayMutation(first, nextAdapter)).state, "confirmed");
  assert.equal((await engine.replayMutation(second, nextAdapter)).state, "confirmed");
  assert.equal(cloud.get(`${owner}:${entity}`).content, "v2");
  assert.equal((await box.listMutations(owner)).length, 0);
  results.push({ case: `SA-01-${existing ? "update" : "create"}`, observed: "receipt restored across reload; successor confirms v2 without false conflict" });
}

// SA-02: after a correction confirms, retain the rejected history without
// letting it override the newer cloud row on the next actual fetch.
const owner = "corrected", entity = "record";
cloud.set(`${owner}:${entity}`, { id: entity, user_id: owner, record_type: "note", content: "original", event_at: baseVersion, updated_at: baseVersion });
const rejected = await queue(owner, entity, "rejected old draft", baseVersion);
rejectWrite = true;
assert.equal((await engine.replayMutation(rejected, adapter(owner))).state, "failed");
rejectWrite = false;
const corrected = await queue(owner, entity, "corrected confirmed draft", "local-only-version");
assert.equal(corrected.expectedUpdatedAt, baseVersion, "Visible failed draft timestamp is not a cloud CAS version");
await box.retryFailedMutations(owner);
assert.equal((await box.listMutations(owner)).find(item => item.id === rejected.id).state, "failed", "Retry must not race the superseding correction");
assert.equal((await engine.replayMutation(corrected, adapter(owner))).state, "confirmed");
assert.equal((await box.listMutations(owner)).length, 1);
assert.equal((await box.listMutations(owner))[0].id, rejected.id);
assert.equal((await box.listMutations(owner))[0].supersededBy, corrected.id);
assert.equal(await box.claimMutation(rejected.id, owner), null);
await box.retryFailedMutations(owner);
assert.equal((await box.listMutations(owner))[0].state, "failed");
const client = {
  auth: { getSession: async () => ({ data: { session: { user: { id: owner }, access_token: "synthetic-session" } } }) },
  from(table) {
    let cursor;
    const chain = { select() { return chain; }, order() { return chain; }, limit() { return chain; }, eq() { return chain; }, is() { return chain; }, gt(_key, value) { cursor = value; return chain; },
      maybeSingle: async () => ({ data: table === "profiles" ? { user_id: owner } : { user_id: owner, theme: "dark", base_currency: "USD" }, error: null }),
      then(yes, no) { return Promise.resolve({ data: table === "records" && !cursor ? [cloud.get(`${owner}:${entity}`)] : [], error: null }).then(yes, no); } };
    return chain;
  }
};
stubs.set(resolve(root, "src/lib/supabase.ts"), { supabase: client });
const fetched = await load("src/lib/data.ts").fetchAppData({ id: owner, email: "synthetic@example.invalid", user_metadata: {} });
assert.equal(cloud.get(`${owner}:${entity}`).content, "corrected confirmed draft");
assert.equal(fetched.records[0].content, "corrected confirmed draft");
assert.equal((await box.loadSnapshot(owner)).records[0].content, "corrected confirmed draft");
results.push({ case: "SA-02", observed: "confirmed correction remains active in fetch/cache; old failed draft retained as non-retryable exportable history" });

// A failed correction does not archive its predecessor or hide either draft.
const failure = await queue("not-confirmed", "entity", "bad", null); rejectWrite = true;
await engine.replayMutation(failure, adapter("not-confirmed"));
const failure2 = await queue("not-confirmed", "entity", "correction", null);
await engine.replayMutation(failure2, adapter("not-confirmed")); rejectWrite = false;
assert.ok((await box.listMutations("not-confirmed")).every(item => !item.supersededBy));

// An external writer remains protected by CAS; correction cannot force overwrite.
cloud.set("foreign-writer:entity", { updated_at: baseVersion, content: "old" });
const denied = await queue("foreign-writer", "entity", "bad", baseVersion); rejectWrite = true;
await engine.replayMutation(denied, adapter("foreign-writer")); rejectWrite = false;
cloud.set("foreign-writer:entity", { updated_at: "2026-10-03T00:00:00Z", content: "other device" });
const correctedConflict = await queue("foreign-writer", "entity", "corrected", "local-only");
assert.equal((await engine.replayMutation(correctedConflict, adapter("foreign-writer"))).state, "conflict");
assert.equal(cloud.get("foreign-writer:entity").content, "other device");
assert.ok((await box.listMutations("foreign-writer")).every(item => !item.supersededBy));

const claims = await Promise.all(Array.from({ length: 20 }, () => box.claimAutomaticSummary("summary-owner", "same-context")));
assert.equal(claims.filter(Boolean).length, 1, "Cross-window admission is an IndexedDB transaction, not a localStorage race");
assert.equal(await load("src/lib/offline.ts").claimAutomaticSummary("summary-owner", "same-context"), false);
assert.equal(await box.claimAutomaticSummary("other-owner", "same-context"), true);
console.log("PASS SA-01/02/05: v2->v3 conservative upgrade, lost-response create/update recovery across reload, confirmed correction/history/cache, failed correction retained, foreign writer CAS, and atomic persistent account-scoped automatic-summary admission.");

````

## scripts/verify-documentation.mjs

<!-- source: scripts/verify-documentation.mjs sha256: 470b26ecf15e97e5959074eb0801308f4f32ac29c085868a1556241c6f25a8b9 encoding: utf8 -->
````javascript
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { createHash } from "node:crypto";
import { readReference } from "./restore-documentation-reference.mjs";

const root = process.cwd();
const docs = ["README.md", "supabase/README.md"];
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const next = resolve(path, entry.name);
    if (entry.isDirectory()) walk(next);
    else if (extname(next) === ".md") docs.push(next);
  }
}
walk(resolve(root, "docs"));
let links = 0;
for (const path of docs) {
  const text = readFileSync(resolve(root, path), "utf8");
  // Snapshot code is opaque data; validate narrative links only.
  const narrative = text.replace(/^\x60{4}[^\n]*\n[\s\S]*?^\x60{4}$/gm, "").replace(/^\x60{3}[^\n]*\n[\s\S]*?^\x60{3}$/gm, "");
  for (const match of narrative.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z]+:\/\//i.test(target) || target.startsWith("#")) continue;
    assert(existsSync(resolve(dirname(resolve(root, path)), target)), `Broken doc link in ${path}: ${target}`);
    links++;
  }
  assert(!/\b(?:sk-[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,})\b/.test(narrative), `Possible private API key in ${path}`);
}
const entries = readReference(resolve(root, "docs/reference"));
for (const [path, entry] of entries) {
  const source = readFileSync(resolve(root, path));
  assert.equal(createHash("sha256").update(source).digest("hex"), entry.sha256, `Stale snapshot: ${path}`);
}
const required = ["ARCHITECTURE", "REBUILD-SPEC", "DATABASE", "API-CONTRACT", "DEPLOYMENT-ROLLBACK", "USER-GUIDE", "CODE-REVIEW-2026-10-01"];
for (const name of required) assert(existsSync(resolve(root, `docs/${name}.md`)));
const api = readFileSync(resolve(root, "docs/API-CONTRACT.md"), "utf8");
for (const name of ["lookup-flight", "deepseek-assist", "start-demo-session", "redeem-invite", "get-api-quota", "owner-admin", "query-transit-route"]) assert(api.includes(name));
for (const value of ["10000", "15次", "80次", "100次", "2次"]) assert(api.includes(value), `Missing quota: ${value}`);
console.log(`Documentation passed: ${docs.length} Markdown files, ${links} local links, ${entries.size} source/asset snapshots verified.`);

````

## scripts/verify-ui-contract.mjs

<!-- source: scripts/verify-ui-contract.mjs sha256: 4707a3bffb33dbc9f1e0097bc8c6d69e8400af531da1aab6ca646a231c0e5c22 encoding: utf8 -->
````javascript
// Read-only contracts for approved V2 presentation and R01–R10 reliability changes.
// This is not a substitute for database/runtime tests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const baseline = "stable-before-v2.0.0";
const before = path => execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
const after = path => readFileSync(path, "utf8");
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline], { encoding: "utf8" }).trim().split("\n");
// Explicitly approved reliability surfaces; everything else in the domain/backend
// guard remains frozen, especially login, entitlement and invitation endpoints.
const reliability = new Set([
  "src/components/HomeRouteSearch.tsx", "supabase/functions/owner-admin/index.ts", // R2-04/05 DST choice and complete pagination, no entitlement policy change.
  "src/lib/offline.ts", "src/lib/data.ts", "src/lib/flightLookup.ts", "src/lib/transport.ts", "src/types.ts",
  "src/lib/ai.ts", "supabase/functions/lookup-flight/index.ts",
  "src/lib/tripDates.ts", // SA-04 strict non-flight DST resolution, same Auth/quota policy.
  "src/components/QuickComposer.tsx",
  "supabase/functions/deepseek-assist/index.ts", "supabase/functions/_shared/api.ts",
  "supabase/functions/get-api-quota/index.ts", // F05/F06 read errors / Shanghai reset dates; no policy change.
]);
let checked = 0;
for (const path of files) {
  const guarded = path.startsWith("src/lib/") && path !== "src/lib/releaseNotes.ts"
    || path.startsWith("supabase/") && !path.endsWith(".md")
    || ["src/types.ts", "src/main.tsx", "vite.config.ts", "index.html"].includes(path)
    || path.startsWith("public/")
    || ["src/components/QuickComposer.tsx", "src/components/HomeRouteSearch.tsx"].includes(path);
  if (guarded && !reliability.has(path)) {
    assert.equal(after(path), before(path), `Protected baseline changed: ${path}`);
    checked++;
  }
}
function functions(source) {
  const ast = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return Object.fromEntries(ast.statements.filter(ts.isFunctionDeclaration).map(statement => [statement.name.text, statement]));
}
const printer = ts.createPrinter({ removeComments: true });
function logicPrefixes(source) {
  const ast = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return Object.fromEntries(Object.values(functions(source)).filter(statement => statement.body).map(statement => {
    const at = statement.body.statements.findIndex(item => ts.isReturnStatement(item));
    const prefix = statement.body.statements.slice(0, at < 0 ? undefined : at);
    return [statement.name.text, prefix.map(item => printer.printNode(ts.EmitHint.Unspecified, item, ast)).join("\n")];
  }));
}
assert.deepEqual(logicPrefixes(after("src/components/LoginScreen.tsx")), logicPrefixes(before("src/components/LoginScreen.tsx")), "OTP send/verify handlers changed");
const approvedSummarySettings = after("src/components/SettingsPanel.tsx")
  .replace("generateDailySummary(summaryContext)", "generateDailySummary()")
  .replace('[result.result, result.warning].filter(Boolean).join("\\n\\n")', "result.result");
assert.deepEqual(logicPrefixes(approvedSummarySettings), logicPrefixes(before("src/components/SettingsPanel.tsx")), "Settings owner/profile handlers changed beyond approved summary calendar/warning");
function firstAuthEffect(source) {
  const ast = ts.createSourceFile("app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "App");
  const effect = app.body.statements.find(item => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.getText(ast) === "useEffect");
  assert.ok(effect?.getText(ast).includes("onAuthStateChange"), "First effect must still manage the Auth session");
  return printer.printNode(ts.EmitHint.Unspecified, effect, ast);
}
assert.equal(firstAuthEffect(after("src/App.tsx")), firstAuthEffect(before("src/App.tsx")), "Session/foreground Auth recovery changed");
const prior = JSON.parse(before("package.json")), current = JSON.parse(after("package.json"));
assert.deepEqual(current.engines, prior.engines, "Node engine changed without compatibility review");
assert.deepEqual(current.scripts, prior.scripts, "Build/development entry points changed");
assert.deepEqual(current.overrides, prior.overrides, "Dependency overrides require explicit review");
const approvedTestTools = { "embedded-postgres": "18.4.0-beta.17", "pg": "8.23.1", "fake-indexeddb": "6.2.5" };
for (const field of ["dependencies", "devDependencies"]) {
  const extras = Object.keys(current[field]).filter(name => !Object.hasOwn(prior[field], name));
  for(const name of extras) assert.equal(field === "devDependencies" ? approvedTestTools[name] : undefined, current[field][name], `Unapproved package addition in ${field}: ${name}`);
  assert.deepEqual(Object.keys(current[field]).filter(name=>!extras.includes(name)).sort(), Object.keys(prior[field]).sort(), `Unapproved package removal in ${field}`);
  for (const name of Object.keys(prior[field])) {
    const major = value => Number(value.match(/\d+/)?.[0]);
    assert.equal(major(current[field][name]), major(prior[field][name]), `Unreviewed dependency major upgrade: ${name}`);
  }
}
assert.equal(current.version, "2.0.0");
assert.ok(after("src/components/SettingsPanel.tsx").includes("Built with the help of Codex, with special thanks to Claude for prompt design and development support."));
assert.equal(after("src/styles/tokens.css").match(/--accent:\s*([^;]+);/)[1].toLowerCase(), "#0a84ff");
for (const path of ["src/styles.css", "src/components/ExpenseStats.tsx"]) assert.ok(!/#[\da-f]{3,8}\b/i.test(after(path)), `Uncentralized visual color: ${path}`);
assert.ok(after("src/styles.css").includes("env(safe-area-inset-top)"));
assert.ok(after("vite.config.ts").includes('registerType: "autoUpdate"'));
assert.ok(after("src/lib/data.ts").includes("save_user_mutation"), "CAS save RPC must not be replaced by blind upsert");
assert.ok(after("src/lib/offline.ts").includes('"by-owner"'), "Owner-partitioned outbox index required");
assert.ok(after("src/lib/syncEngine.ts").includes('data?.code === "CONFLICT"'), "Conflict cannot masquerade as a confirmed write");
console.log(`PASS: ${checked} protected baseline files, immutable historical migrations, OTP/owner/profile/Auth handlers, PWA identity/icons, exact accent token, explicit reliability allowlist and same-major dependencies.`);

````

## .github/workflows/deploy.yml

<!-- source: .github/workflows/deploy.yml sha256: 393bfd1ccc9b7fa2e7809b69bc477ddaef550fe3093c90bfb0f1deae702ef889 encoding: utf8 -->
````yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Setup Pages
        uses: actions/configure-pages@v5
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4

````

## .gitignore

<!-- source: .gitignore sha256: fecc9595cf1b0e64ebdc05d40fe1169c3a42517a8cceb321a13363c41b6992fa encoding: utf8 -->
````text
# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
/node_modules
/.pnp
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# testing
/coverage

# next.js
/.next/
/.vinext/
/out/

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# env files (can opt-in for committing if needed)
.env*
!.env.example

# vercel
.vercel

# typescript
next-env.d.ts
*.tsbuildinfo
vite.config.js
vite.config.d.ts
/dist/
/.wrangler/
/outputs/
/work/
/supabase/.temp/

````

## .env.example

<!-- source: .env.example sha256: 6e220a64f0759477c4b0c9aac15f683680f03d00fc16ed5287ca64289d806faa encoding: utf8 -->
````text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key

````

## package.json

<!-- source: package.json sha256: 6550b2b0851a0fb6373e8c3810491071e2ec88cd9092acd3f21a453f67ec74fe encoding: utf8 -->
````json
{
  "name": "life-tracker-pwa",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.13.0"
  },
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 3000",
    "build": "tsc -b && vite build",
    "preview": "vite preview --host 0.0.0.0 --port 4173",
    "lint": "eslint src --max-warnings=0"
  },
  "dependencies": {
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@supabase/supabase-js": "^2.57.4",
    "idb": "^8.0.3",
    "lucide-react": "^0.468.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "recharts": "^3.2.1"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.0",
    "@tailwindcss/vite": "^4.2.1",
    "@types/node": "^22.19.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.0.2",
    "embedded-postgres": "18.4.0-beta.17",
    "eslint": "^9.39.0",
    "eslint-plugin-react-hooks": "^7.0.1",
    "eslint-plugin-react-refresh": "^0.4.24",
    "fake-indexeddb": "6.2.5",
    "globals": "^16.5.0",
    "pg": "8.23.1",
    "tailwindcss": "^4.2.1",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.48.0",
    "vite": "^8.3.1",
    "vite-plugin-pwa": "^1.1.0"
  }
}

````

## package-lock.json

<!-- source: package-lock.json sha256: 4237f8b6068faba6b486c24651c939f8f29c89772cc0a4fc0bb8ccb9ed7856f2 encoding: utf8 -->
````json
{
  "name": "life-tracker-pwa",
  "version": "2.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "life-tracker-pwa",
      "version": "2.0.0",
      "dependencies": {
        "@dnd-kit/core": "^6.3.1",
        "@dnd-kit/sortable": "^10.0.0",
        "@dnd-kit/utilities": "^3.2.2",
        "@supabase/supabase-js": "^2.57.4",
        "idb": "^8.0.3",
        "lucide-react": "^0.468.0",
        "react": "^19.2.0",
        "react-dom": "^19.2.0",
        "recharts": "^3.2.1"
      },
      "devDependencies": {
        "@eslint/js": "^9.39.0",
        "@tailwindcss/vite": "^4.2.1",
        "@types/node": "^22.19.0",
        "@types/react": "^19.2.0",
        "@types/react-dom": "^19.2.0",
        "@vitejs/plugin-react": "^6.0.2",
        "embedded-postgres": "18.4.0-beta.17",
        "eslint": "^9.39.0",
        "eslint-plugin-react-hooks": "^7.0.1",
        "eslint-plugin-react-refresh": "^0.4.24",
        "fake-indexeddb": "6.2.5",
        "globals": "^16.5.0",
        "pg": "8.23.1",
        "tailwindcss": "^4.2.1",
        "typescript": "^5.9.3",
        "typescript-eslint": "^8.48.0",
        "vite": "^8.3.1",
        "vite-plugin-pwa": "^1.1.0"
      },
      "engines": {
        "node": ">=22.13.0"
      }
    },
    "node_modules/@babel/code-frame": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/code-frame/-/code-frame-7.29.7.tgz",
      "integrity": "sha512-Aup7aUOfpbAUg2ROOJN6Iw5f9DMBlzu0mIkm/malLQFN/YQgO48wCj0Kxa3sEHJvPVFg7siR+qRInwXd2qhQKw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-validator-identifier": "^7.29.7",
        "js-tokens": "^4.0.0",
        "picocolors": "^1.1.1"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/compat-data": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/compat-data/-/compat-data-7.29.7.tgz",
      "integrity": "sha512-locTkQyKvwIEgBzVrn8693ebc97F2U8ZHjbXwDXJ5Fn2TCpNwTlKcaKLkdHop5c/icOFE7qt7Q9JC5hnKNa6Gg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/core": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/core/-/core-7.29.7.tgz",
      "integrity": "sha512-RgHBCvtjbOK2gXSNBNIkNoEc9qoVEtau3hj8gEqKQuL3HZAibKarWFEI3Lfm6EYKkLalOh8eSrj9b+ch9H/VBA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/code-frame": "^7.29.7",
        "@babel/generator": "^7.29.7",
        "@babel/helper-compilation-targets": "^7.29.7",
        "@babel/helper-module-transforms": "^7.29.7",
        "@babel/helpers": "^7.29.7",
        "@babel/parser": "^7.29.7",
        "@babel/template": "^7.29.7",
        "@babel/traverse": "^7.29.7",
        "@babel/types": "^7.29.7",
        "@jridgewell/remapping": "^2.3.5",
        "convert-source-map": "^2.0.0",
        "debug": "^4.1.0",
        "gensync": "^1.0.0-beta.2",
        "json5": "^2.2.3",
        "semver": "^6.3.1"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/babel"
      }
    },
    "node_modules/@babel/generator": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/generator/-/generator-7.29.7.tgz",
      "integrity": "sha512-DkXD5OJQaAQIdZ1bt3UZdEnHAn9Imd3IVBdX03UFe+ony9Ojw5pzr9YVKGDY1jt+Gcn/FnGkNf8r+Vj5NOJWtQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/parser": "^7.29.7",
        "@babel/types": "^7.29.7",
        "@jridgewell/gen-mapping": "^0.3.12",
        "@jridgewell/trace-mapping": "^0.3.28",
        "jsesc": "^3.0.2"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-annotate-as-pure": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-annotate-as-pure/-/helper-annotate-as-pure-7.29.7.tgz",
      "integrity": "sha512-OoK6239jHPuSQOoS0kfTVKn0b/rVTk0seKq4Gd2UMLtmOVLjDC0ki3e+c90Trqv2gMfvJFqkiljrr568+qddiw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-compilation-targets": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-compilation-targets/-/helper-compilation-targets-7.29.7.tgz",
      "integrity": "sha512-wem6WaBj4NaVYVdNhLPPVacES6ZJ+KBBfSkTMD3YZxbP3rm3Di85tJU5ljaUNhaOynt+Aj0xruhYuzQBt8n71g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/compat-data": "^7.29.7",
        "@babel/helper-validator-option": "^7.29.7",
        "browserslist": "^4.24.0",
        "lru-cache": "^5.1.1",
        "semver": "^6.3.1"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-create-class-features-plugin": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-create-class-features-plugin/-/helper-create-class-features-plugin-7.29.7.tgz",
      "integrity": "sha512-IY3ZD9Tmooqr3TUhc3DUWxiuo8xx1DWLhd5M7hQ+ZWJamqM2BbalrBJb2MisSLoYorOj75U03qULCxQTY9r3hg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-annotate-as-pure": "^7.29.7",
        "@babel/helper-member-expression-to-functions": "^7.29.7",
        "@babel/helper-optimise-call-expression": "^7.29.7",
        "@babel/helper-replace-supers": "^7.29.7",
        "@babel/helper-skip-transparent-expression-wrappers": "^7.29.7",
        "@babel/traverse": "^7.29.7",
        "semver": "^6.3.1"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/helper-create-regexp-features-plugin": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-create-regexp-features-plugin/-/helper-create-regexp-features-plugin-7.29.7.tgz",
      "integrity": "sha512-907Uymvqgg1dwUA+7IGwFAOSYzQOuzPXKNJ1yxzwPffzkYFg2q2eHi1fIOs6sXkG9NbIUMunnUlkYsfRFNvomg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-annotate-as-pure": "^7.29.7",
        "regexpu-core": "^6.3.1",
        "semver": "^6.3.1"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/helper-define-polyfill-provider": {
      "version": "0.6.8",
      "resolved": "https://registry.npmjs.org/@babel/helper-define-polyfill-provider/-/helper-define-polyfill-provider-0.6.8.tgz",
      "integrity": "sha512-47UwBLPpQi1NoWzLuHNjRoHlYXMwIJoBf7MFou6viC/sIHWYygpvr0B6IAyh5sBdA2nr2LPIRww8lfaUVQINBA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-compilation-targets": "^7.28.6",
        "@babel/helper-plugin-utils": "^7.28.6",
        "debug": "^4.4.3",
        "lodash.debounce": "^4.0.8",
        "resolve": "^1.22.11"
      },
      "peerDependencies": {
        "@babel/core": "^7.4.0 || ^8.0.0-0 <8.0.0"
      }
    },
    "node_modules/@babel/helper-define-polyfill-provider/node_modules/resolve": {
      "version": "1.22.12",
      "resolved": "https://registry.npmjs.org/resolve/-/resolve-1.22.12.tgz",
      "integrity": "sha512-TyeJ1zif53BPfHootBGwPRYT1RUt6oGWsaQr8UyZW/eAm9bKoijtvruSDEmZHm92CwS9nj7/fWttqPCgzep8CA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "is-core-module": "^2.16.1",
        "path-parse": "^1.0.7",
        "supports-preserve-symlinks-flag": "^1.0.0"
      },
      "bin": {
        "resolve": "bin/resolve"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/@babel/helper-globals": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-globals/-/helper-globals-7.29.7.tgz",
      "integrity": "sha512-3nQVUAtvkKH9zahfWgw96Jc/uFOmjACE1kQz82E2lqWmHBgjzbNlsC22nuQTfahmWeQtTq5nQ/4Nnd2A1wj4zA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-member-expression-to-functions": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-member-expression-to-functions/-/helper-member-expression-to-functions-7.29.7.tgz",
      "integrity": "sha512-j+7JYmk1JYDtACIGj0QJqqWZjoUpMoEikQGADMaHgCMCSDqd2+P32rfcibUNrGOMWrlzK1WJBdxrB3JJQZwWtg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/traverse": "^7.29.7",
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-module-imports": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-module-imports/-/helper-module-imports-7.29.7.tgz",
      "integrity": "sha512-ejHwrQQYcm9xnTivShn2IDOlIzInN34AXskvq9QicvCtEzq1Vzclu/tKF8Jq1Cg8JG2GL6/EmjgsCT7lXepE3g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/traverse": "^7.29.7",
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-module-transforms": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-module-transforms/-/helper-module-transforms-7.29.7.tgz",
      "integrity": "sha512-UPUVSyXbOh627KiCIGQSgwWzGeBKLkaJ9PJEdrngIwMSzxLR4jS4+f1f1jb7VzBbg8nFLaYotvVPFCTqdrmTAg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-module-imports": "^7.29.7",
        "@babel/helper-validator-identifier": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/helper-optimise-call-expression": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-optimise-call-expression/-/helper-optimise-call-expression-7.29.7.tgz",
      "integrity": "sha512-+kmGVjcT9RGYzoDwdwEqEvGgKe3BYq+O1iGzjFubaNgZHwYHP6lsF2Yghf4kEuv9BV7tYDZ913aBW9am6YKong==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-plugin-utils": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-plugin-utils/-/helper-plugin-utils-7.29.7.tgz",
      "integrity": "sha512-G7sHYigPY17oO5SYWnfD/0MTBwVR781S/JI643e/JhUYgVgWE/61SoW3NH9KWUKyKq5LVh3npif99Wkt6j86Jw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-remap-async-to-generator": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-remap-async-to-generator/-/helper-remap-async-to-generator-7.29.7.tgz",
      "integrity": "sha512-16AMiW26DbXWBbr3B8wNozKM0ydMLB892vaOaJW/fPJdnT8vJk5sdkQcU/isqUxyCE0cEoa8wZOcbgDuC4b6Og==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-annotate-as-pure": "^7.29.7",
        "@babel/helper-wrap-function": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/helper-replace-supers": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-replace-supers/-/helper-replace-supers-7.29.7.tgz",
      "integrity": "sha512-atfGXWSeCiF4DnKZIfmJfQRkSw9b9gNNXR1kqKjbhG4pGYCOnkp8OcTB8E3NXjBu8NpheSnOeNKz8KT7UNFTmQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-member-expression-to-functions": "^7.29.7",
        "@babel/helper-optimise-call-expression": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/helper-skip-transparent-expression-wrappers": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-skip-transparent-expression-wrappers/-/helper-skip-transparent-expression-wrappers-7.29.7.tgz",
      "integrity": "sha512-brcMGQaVzIeUb+6/bs1Av0f8YuNNjKY2JyvfRCsFuFsdKccEQ5Ges2y74D74NZ1Rz8lKJ9ksJkfqwQFJ/iNEyQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/traverse": "^7.29.7",
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-string-parser": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-string-parser/-/helper-string-parser-7.29.7.tgz",
      "integrity": "sha512-Pb5ijPrZ89GDH8223L4UP8i6QApWxs04RbPQJTeWDV0/keR2E36MeKnyr6LYmUUvqRRI+Iv87SuF1W6ErINzYw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-validator-identifier": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-validator-identifier/-/helper-validator-identifier-7.29.7.tgz",
      "integrity": "sha512-qehxGkRj55h/ff8EMaJ+cYhyaKlHIxqYDn682wQD7RNp9UujOQsHog2uS0r2vzr4pW+sXf90NeeayjcNaX3fFg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-validator-option": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-validator-option/-/helper-validator-option-7.29.7.tgz",
      "integrity": "sha512-N9ZErrD+yW5geCDtBqnOoxmR8+tNKiGuxKlDpuJxfsqpa2dFcexaziGAE/qoHLiDDreVNMupxGmSoNlyvsA3gw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helper-wrap-function": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helper-wrap-function/-/helper-wrap-function-7.29.7.tgz",
      "integrity": "sha512-iES0Skag9ERIF68aXadpO6dbXa03mNWK3sEqJaMnLNs/eC3l0lkImdfoy6Y09/SfkpawdAB4RjQ7PVA7TcVGdw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/template": "^7.29.7",
        "@babel/traverse": "^7.29.7",
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/helpers": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/helpers/-/helpers-7.29.7.tgz",
      "integrity": "sha512-1k2lAGRMfHTcwuNYcCNUmaUffmQv8KWMfh2iJUUeRlwlwH4FdNG7mfPI10NPfLHJFThE4Tyr4mv7kTNZOiPuBg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/template": "^7.29.7",
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/parser": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/parser/-/parser-7.29.7.tgz",
      "integrity": "sha512-hnORnjP/1P/zFEndoeX+n+t1RwWRJiJpM/jO7FW32Kn9r5+sJB2JWOdYo4L6k78j15eCwY3Gm/7364B1EMwtNg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/types": "^7.29.7"
      },
      "bin": {
        "parser": "bin/babel-parser.js"
      },
      "engines": {
        "node": ">=6.0.0"
      }
    },
    "node_modules/@babel/plugin-bugfix-firefox-class-in-computed-class-key": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-bugfix-firefox-class-in-computed-class-key/-/plugin-bugfix-firefox-class-in-computed-class-key-7.29.7.tgz",
      "integrity": "sha512-j8SrR0zLZrRsC09DlszEx8FpMiwukKffYXMK0d5LmOglO7vGG6sz/BR/20yHqWH+Lnn31JTt2PE3hIWNgM2J6w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-bugfix-safari-class-field-initializer-scope": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-bugfix-safari-class-field-initializer-scope/-/plugin-bugfix-safari-class-field-initializer-scope-7.29.7.tgz",
      "integrity": "sha512-r8j8escF+U2FUHo0KOhPUdMzUO+jp9fInva6+ACVAF3Y97Ev+5iNZwiqTghmzNeWwDkOPlYuTcfb1vDaoZKmAQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-bugfix-safari-id-destructuring-collision-in-function-expression": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-bugfix-safari-id-destructuring-collision-in-function-expression/-/plugin-bugfix-safari-id-destructuring-collision-in-function-expression-7.29.7.tgz",
      "integrity": "sha512-GE1TFSiuFeGsCxmYXZl8HwoPrVlwe4rHPFE8weieGKZqnDORK+Ar3vgWMgW+AOxQ6/2TgLSKx9p6W7O4rC6qgQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-bugfix-safari-rest-destructuring-rhs-array": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-bugfix-safari-rest-destructuring-rhs-array/-/plugin-bugfix-safari-rest-destructuring-rhs-array-7.29.7.tgz",
      "integrity": "sha512-oBNVCvnO5tND+xSopWvV8WNGfpTfgP4Zr/YXXSj8zfmcPktp5Ku/aZlsIowgSD4fjmgHn6sGmB9APVsU5zOdhA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-skip-transparent-expression-wrappers": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-bugfix-v8-spread-parameters-in-optional-chaining": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-bugfix-v8-spread-parameters-in-optional-chaining/-/plugin-bugfix-v8-spread-parameters-in-optional-chaining-7.29.7.tgz",
      "integrity": "sha512-QQt9qKHZ2sg/kivaLr7lnQr8HVrQDdBNSfCsTjiDxRuX/K5ORyKq+Bu8Xr0cDE3Dfkv0cw28Ve0EKyKMvulkOw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-skip-transparent-expression-wrappers": "^7.29.7",
        "@babel/plugin-transform-optional-chaining": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.13.0"
      }
    },
    "node_modules/@babel/plugin-bugfix-v8-static-class-fields-redefine-readonly": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-bugfix-v8-static-class-fields-redefine-readonly/-/plugin-bugfix-v8-static-class-fields-redefine-readonly-7.29.7.tgz",
      "integrity": "sha512-pn6QacGLgvCcwc+syUhKE/qSjV2D1IHDB84RNxWYSt1mW3K/SCtjinZ2p0cETJxAWBjPy3K/1lHwG5BjjPxNlw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-proposal-private-property-in-object": {
      "version": "7.21.0-placeholder-for-preset-env.2",
      "resolved": "https://registry.npmjs.org/@babel/plugin-proposal-private-property-in-object/-/plugin-proposal-private-property-in-object-7.21.0-placeholder-for-preset-env.2.tgz",
      "integrity": "sha512-SOSkfJDddaM7mak6cPEpswyTRnuRltl429hMraQEglW+OkovnCzsiszTmsrlY//qLFjCpQDFRvjdm2wA5pPm9w==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-syntax-import-assertions": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-syntax-import-assertions/-/plugin-syntax-import-assertions-7.29.7.tgz",
      "integrity": "sha512-/An1OCBN93thpBAGyfsK2pcf0jvju1SAtKkL2Ny++B5Sy6sqgzXDQH1cZxWbF96Wuk+bn41MDA9bLd4VVAw6rw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-syntax-import-attributes": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-syntax-import-attributes/-/plugin-syntax-import-attributes-7.29.7.tgz",
      "integrity": "sha512-zGYcYfq/WmZ4V+kBIXQon9dSSc8ircGZqw9ZaNhhGj9nZkeBu1jHLBDQqYYi5WA9uawvA2sIMbry2nCFhf5Djg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-syntax-unicode-sets-regex": {
      "version": "7.18.6",
      "resolved": "https://registry.npmjs.org/@babel/plugin-syntax-unicode-sets-regex/-/plugin-syntax-unicode-sets-regex-7.18.6.tgz",
      "integrity": "sha512-727YkEAPwSIQTv5im8QHz3upqp92JTWhidIC81Tdx4VJYIte/VndKf1qKrfnnhPLiPghStWfvC/iFaMCQu7Nqg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.18.6",
        "@babel/helper-plugin-utils": "^7.18.6"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-transform-arrow-functions": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-arrow-functions/-/plugin-transform-arrow-functions-7.29.7.tgz",
      "integrity": "sha512-N7zArUXWzAMzm+/N0uPBeVB3Fam5lMxtUwMmDK5f/IBBS7a7p1qeUoxd/6CckXoxUdgsntq1Dh8xNW06maZbDQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-async-generator-functions": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-async-generator-functions/-/plugin-transform-async-generator-functions-7.29.7.tgz",
      "integrity": "sha512-d98gXZkgswvkyohMBABkhm3GeXhYj8psWfwQ2C7gtfrKGTykQa/iOIi+JJhwMjPlZ6Vm2XN+DCf3Es1EoG4ZLA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-remap-async-to-generator": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-async-to-generator": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-async-to-generator/-/plugin-transform-async-to-generator-7.29.7.tgz",
      "integrity": "sha512-pcUb2SS+RMo9TWVBwKGI5ShtoG7R+zBsFmCKDa6fe8c+hPr3XJlZgoE5j6i8W7gDjhyvy+85vmYexanvXh3d1w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-module-imports": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-remap-async-to-generator": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-block-scoped-functions": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-block-scoped-functions/-/plugin-transform-block-scoped-functions-7.29.7.tgz",
      "integrity": "sha512-cUSmjh72N+rN4PrkFlN1dJwNCwjVp5d38/CQrEsFggkD10UiFlBFgdH3tv5dNsLuHY+3S8db2xCHjhZcv5WgvA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-block-scoping": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-block-scoping/-/plugin-transform-block-scoping-7.29.7.tgz",
      "integrity": "sha512-ONyr4+AZhKh8yKWInVxU9AXA9EbsyeLcL6V0dJy6M2/62vuvpGm29zzuymbTpdc451GEpDIdAyPLP3r+P61yKQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-class-properties": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-class-properties/-/plugin-transform-class-properties-7.29.7.tgz",
      "integrity": "sha512-GtcpjFvanPfzNQi3eTitsCqtRRmmqzpy/A+yhTR1HaZo1Ly3EA8ZXxlPyHdR8/IuRMYc3E4wdGBewB2QKQjAaA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-class-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-class-static-block": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-class-static-block/-/plugin-transform-class-static-block-7.29.7.tgz",
      "integrity": "sha512-kibJgmEdX2iMwsHY2tSZNDgj8PwIlCQz7FK9KuGKO8zsuoUwSEhoNnNVp/emKWrbY4HeO6kkXfdMqRKKKXBm2A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-class-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.12.0"
      }
    },
    "node_modules/@babel/plugin-transform-classes": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-classes/-/plugin-transform-classes-7.29.7.tgz",
      "integrity": "sha512-qV0OGGBVacduzQHE649JyCneOFI/maT+YKsO+K4Yi3xv2wTPNjM/W2o2gdzMwEAZz7fXNTHAe0NcSg30bIN69g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-annotate-as-pure": "^7.29.7",
        "@babel/helper-compilation-targets": "^7.29.7",
        "@babel/helper-globals": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-replace-supers": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-computed-properties": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-computed-properties/-/plugin-transform-computed-properties-7.29.7.tgz",
      "integrity": "sha512-RK7/IyU5phpuCdBAuig5VkzG/EnbDaui5SQGdU9BFrHdV+mV4cUjLMQ9lJDjLNtWHsqtiefpGZUXQP2BiTYMsA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/template": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-destructuring": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-destructuring/-/plugin-transform-destructuring-7.29.7.tgz",
      "integrity": "sha512-iPX8aD6H9zV5s7ZsqTdNocPN/MGQ5sSMnElKrktxjJRMnB2jN/1p2+R7GkfD6CAYoVFqy5A4XnSIUeGgJzIWpg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-dotall-regex": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-dotall-regex/-/plugin-transform-dotall-regex-7.29.7.tgz",
      "integrity": "sha512-3qc18hsD2RdZiyJNDNc7HQpv6xbncwh8FYtxNFFzclSyh/trPD9KkVR9BDECUjDLvb7yJVF15GfYUuC+LMkkiQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-duplicate-keys": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-duplicate-keys/-/plugin-transform-duplicate-keys-7.29.7.tgz",
      "integrity": "sha512-6IvRRriEMqnBwD6chtxdLpMYCHWEzN+oL5cyQtjykya19UgzbmKhxmhZgKC/LHxS2nYr9Q/qYPZ5Lr6jOL9+yQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-duplicate-named-capturing-groups-regex": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-duplicate-named-capturing-groups-regex/-/plugin-transform-duplicate-named-capturing-groups-regex-7.29.7.tgz",
      "integrity": "sha512-2wiIyo2BjtgU7HufSeDnL9L2O7zr8jmhFKuSr65VpRkUiRKRNpb0mdlk56+XPPKoIrfHqzbMuglDvZun0RISsA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-transform-dynamic-import": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-dynamic-import/-/plugin-transform-dynamic-import-7.29.7.tgz",
      "integrity": "sha512-giOlEm/EFjfjr+te9NsdjkUo2v4f8rS/SXPumRVHAtbNcyNlvtREkU1dZzaIDclNpnaVhlCqRdFKhJBjBikzLg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-explicit-resource-management": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-explicit-resource-management/-/plugin-transform-explicit-resource-management-7.29.7.tgz",
      "integrity": "sha512-Rstj7coNz8sE+7Ju7ihpHLI564lsK5pUpNNlvptCIC/16E/S5hbl6n3kESPKdNRmqEWlpn5xpS5Q2dvXBsySLw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/plugin-transform-destructuring": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-exponentiation-operator": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-exponentiation-operator/-/plugin-transform-exponentiation-operator-7.29.7.tgz",
      "integrity": "sha512-zFpMOTLZBdW5LfObqcSbL6kefg4R4eLdmvS0wbN9M6D5Mym/sKm9toOoWyVOa+xDjvCnuWcHls2YonXwHvH3CQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-export-namespace-from": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-export-namespace-from/-/plugin-transform-export-namespace-from-7.29.7.tgz",
      "integrity": "sha512-24B2nOy2TeJSMheqwPD4DDQOV/elLSIlKxjZt4i05H5AgdPdWR3n18HnNrcJ+j76WJd9gbwb9jPjNYUy6RautA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-for-of": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-for-of/-/plugin-transform-for-of-7.29.7.tgz",
      "integrity": "sha512-zeSIHh0+E1Um1WJRXCFlHQYu2ieJNdivLLjlBEp+dIBu3S51n+SZZmIXjxnItw6pz56Cn+KvK68BIBVsxq2JiQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-skip-transparent-expression-wrappers": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-function-name": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-function-name/-/plugin-transform-function-name-7.29.7.tgz",
      "integrity": "sha512-otRWaHXE6fbAGkePvaj/kvs3HsqXfPhlnzwSOlnFgbqCPMd975dW+4wZ00WFBt+/YlBGcJwNrARQTOJOb4ZrIg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-compilation-targets": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-json-strings": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-json-strings/-/plugin-transform-json-strings-7.29.7.tgz",
      "integrity": "sha512-RRnE2+eon1rJAq8MnoF1b5kTpY1vU88twHcvcKMrsqP/jxIRqDVs9iJB5fqPuqyeFAW0wJo4MlUIPpQCq/aRsg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-literals": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-literals/-/plugin-transform-literals-7.29.7.tgz",
      "integrity": "sha512-DZ/oLP21ZuWx1vKqnoNv6/tvEK48AQOBRai40CX9dTjGluvT/YZCyY3rryDtyUqCEoyNroy5KKPwX2iQCiRvyw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-logical-assignment-operators": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-logical-assignment-operators/-/plugin-transform-logical-assignment-operators-7.29.7.tgz",
      "integrity": "sha512-A0H91hh6W8MFRkp5TqJmMr39jzGD1A1E1Ysiv2O06Sfbhkapm+XyIzxWCEh5kqwOZ1/8QZ0dY3SeQ7XBqfJd5Q==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-member-expression-literals": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-member-expression-literals/-/plugin-transform-member-expression-literals-7.29.7.tgz",
      "integrity": "sha512-hl1kwFZCCiDyfH25Xmco9jTrkPgnS9pmOzSG7W5I4SaGbLeqKv417hcU2RKmaxoPEgsoJh7ZPOrnPGq99bHoUg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-modules-amd": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-modules-amd/-/plugin-transform-modules-amd-7.29.7.tgz",
      "integrity": "sha512-fxtQoH3m5ywUSIfaH0FGCzWu4McsYon5bD3K4XnskC7f+OyQMj7rsOMi4NvvmJ83WwBAg4UCe+ov4VZlqEvyew==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-module-transforms": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-modules-commonjs": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-modules-commonjs/-/plugin-transform-modules-commonjs-7.29.7.tgz",
      "integrity": "sha512-j0vCldybPC5b5dwCQOJ21uKtHzt7hxLygJTg9eF1ScfaikEDNfzn94XoW5Fi+seBR0nCyL23xaBFFkq7dTM8XQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-module-transforms": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-modules-systemjs": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-modules-systemjs/-/plugin-transform-modules-systemjs-7.29.7.tgz",
      "integrity": "sha512-TM2ZcQLoG2/y4HODiStCo10DibYhWhGWAwVv+EQKmG/7GFl0N+AAmUiXOMKM+aiJ9XBJ9AHVZBvTzMnJ2sM3cQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-module-transforms": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-validator-identifier": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-modules-umd": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-modules-umd/-/plugin-transform-modules-umd-7.29.7.tgz",
      "integrity": "sha512-B4UkaTK3QpgCwJnrxKfMPKdo92CN7OKXAlpAAnM3UPu0Q0lCCk57ylA9AJbRy2v8dDKOPAAWcoR6CMyeoHwRCA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-module-transforms": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-named-capturing-groups-regex": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-named-capturing-groups-regex/-/plugin-transform-named-capturing-groups-regex-7.29.7.tgz",
      "integrity": "sha512-vuFoLwr4qnv2xbZ16SQd6uPcH5FNrLHhk/Jzo++0XJFcaDsr4gjJVg6j398oMHiC+83k/GiBzviwF5KBJkPUtQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-transform-new-target": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-new-target/-/plugin-transform-new-target-7.29.7.tgz",
      "integrity": "sha512-fEo41GmsOUhOBlw8ioo6zvjX5Xc2Lqkzlyfqbpsk3eB6TReV18uhxZ0esfEokVbY2+PVJAQHNKxER6lGrzNd3A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-nullish-coalescing-operator": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-nullish-coalescing-operator/-/plugin-transform-nullish-coalescing-operator-7.29.7.tgz",
      "integrity": "sha512-idmp1dFaekP9GbcMvG24Kvw2BfhFZjHnNJCkV4WuIY4PskJzwI3f1N5OdgYke38T7rftO6ERulFRn2cFeZwRkg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-numeric-separator": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-numeric-separator/-/plugin-transform-numeric-separator-7.29.7.tgz",
      "integrity": "sha512-zR7fv/z14OjgHl4AgRtkDBvBMhIzCxqV/qN/2BCRC7LjFwvuzjYe7gDWxC4Wl/SNsLM6SE1IWvRPYMgSJaUvNw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-object-rest-spread": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-object-rest-spread/-/plugin-transform-object-rest-spread-7.29.7.tgz",
      "integrity": "sha512-Ld98jn4c0smUywL57m7SgsHq3OpThOa6LqZJif3G6jYOovPleoFhVrBJ1WegRApSFB2wu4+RelAj9AC9G08Z4A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-compilation-targets": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/plugin-transform-destructuring": "^7.29.7",
        "@babel/plugin-transform-parameters": "^7.29.7",
        "@babel/traverse": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-object-super": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-object-super/-/plugin-transform-object-super-7.29.7.tgz",
      "integrity": "sha512-Ea/diGcw0twB5IlZPO5sgET6fJsLJqPABqTuFWIR+iMPGPZJkATEIWx0wa+aEQ5UY1CBQyP/gkAiLEqn1vBiQA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-replace-supers": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-optional-catch-binding": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-optional-catch-binding/-/plugin-transform-optional-catch-binding-7.29.7.tgz",
      "integrity": "sha512-sLsyndxK2VwX6yNUOakMb7Sh553ZTe/vVM1XJ+9Z5aW1ytsc8xOIwmyk05NNjN60vkc5/KqoTH6hB4V41LJhng==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-optional-chaining": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-optional-chaining/-/plugin-transform-optional-chaining-7.29.7.tgz",
      "integrity": "sha512-6GM1dhvK3gNODkXcEcMCOLEDCLSoZ/sBbro2Ax8HURyasQ4NshagQixkRFdh5niI6E4gmA/jYI/4aT7rRos3ZQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-skip-transparent-expression-wrappers": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-parameters": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-parameters/-/plugin-transform-parameters-7.29.7.tgz",
      "integrity": "sha512-ZDOBqV/qLYJI0YElr8DcENEyARsFQeESqWXH6gZlghYXuPPjvweuDhP4VyEi4BlUBlLRFZVjxoZDMjxhLW766g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-private-methods": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-private-methods/-/plugin-transform-private-methods-7.29.7.tgz",
      "integrity": "sha512-/6Rz4DK1ETDEM/bWHsPHcaEe7ZaT1EqSXjtSP/L0DijOYuaUhiRiOKcwpZ8P7zR4xXEHc2ITdiCgBm9Tpyv9ug==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-class-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-private-property-in-object": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-private-property-in-object/-/plugin-transform-private-property-in-object-7.29.7.tgz",
      "integrity": "sha512-+BNo06dnrzdNNqCm1X6YUaVv0DKk8Q+JYcoZfOkLhYWNCXzlwTSRq8zGWayT1csjcpNXV9CQTBRRbmTLZac5cA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-annotate-as-pure": "^7.29.7",
        "@babel/helper-create-class-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-property-literals": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-property-literals/-/plugin-transform-property-literals-7.29.7.tgz",
      "integrity": "sha512-bOMRLQuI0A5ZqHq3OWJ89/rXpJ/NJrbVhXiP4zwPGMs6kpcVsuTUNjwoE30K0Qm3mf48a/TnRYYD6vPNqcg6jA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-regenerator": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-regenerator/-/plugin-transform-regenerator-7.29.7.tgz",
      "integrity": "sha512-rNNFV0DBAJp988xW2DOntfDoYn1eR8GGF5AT5vYc+rjyfaQkM242c9tZUHHPe7KYaiJizXPWhQTzzdbXySyhBw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-regexp-modifiers": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-regexp-modifiers/-/plugin-transform-regexp-modifiers-7.29.7.tgz",
      "integrity": "sha512-mB5Fs0VWrJ42ZCmc8114v60qetdaUVNkj9PmSZRmanCZM3S9hm0CFRLjRmYIsuXav14l2jvZ+4T8iiCGnhj3nQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/plugin-transform-reserved-words": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-reserved-words/-/plugin-transform-reserved-words-7.29.7.tgz",
      "integrity": "sha512-5+YhdpVgmfSmwZyLMftfaiffLRMHjzIRHFHHLdibcSyJm2pasMrKHrO3Ptrt2DRshjvpgjEJJ1zVW14WPq/6QA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-shorthand-properties": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-shorthand-properties/-/plugin-transform-shorthand-properties-7.29.7.tgz",
      "integrity": "sha512-I+WYbGBAiCn7nA6xBrlgPH+MB7HWb4u8pv5S0Pv7OtwNvIFvCCb24YlttKEeUFVurfBCEaOTnuhlqsb7f0Z5Dg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-spread": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-spread/-/plugin-transform-spread-7.29.7.tgz",
      "integrity": "sha512-/u5K1QWada7tbYNqTjMh96718g9NTwh9tfPJMsSmVsQwGT447FskV+KcfeXkXq2GWki4EM/MuTdmBec+hOuVTQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-skip-transparent-expression-wrappers": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-sticky-regex": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-sticky-regex/-/plugin-transform-sticky-regex-7.29.7.tgz",
      "integrity": "sha512-BCHzNYJGe9l7EpwwDBN/ztlL2NYFFq8hp9ddjtUEM9f2O7S7kKV/lL6Fwo7IF7NSkYhPK2vO+86nIGltA90MsA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-template-literals": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-template-literals/-/plugin-transform-template-literals-7.29.7.tgz",
      "integrity": "sha512-NCSEJ4sLFU2gqAub45HYh4fus2yQ36rr6ei6vpU7NdoJqCpxvEG8E6eJpscGyXP3VHD2Ny+fSXr04k1hoUrFqA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-typeof-symbol": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-typeof-symbol/-/plugin-transform-typeof-symbol-7.29.7.tgz",
      "integrity": "sha512-223mNGoTkBiTEWFoK+Q6Go3tueMRclO8vxxxxquNCYuNI4jWOofFKJRRDu6SDrB8Sgo1UEGW9T4GAQ8ZyRso1A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-unicode-escapes": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-unicode-escapes/-/plugin-transform-unicode-escapes-7.29.7.tgz",
      "integrity": "sha512-jCfXxSjf94lf4E0hKE0AByxF6F3/pVFqRdUUNkDJhsY0m1ZKjnN6ZYyMeHNpzflxb/0q5b7t3p+BE+SLF1WOtA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-unicode-property-regex": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-unicode-property-regex/-/plugin-transform-unicode-property-regex-7.29.7.tgz",
      "integrity": "sha512-OgZ+zoAJgZLUCunsTRQ5LAjOywDv5zzZ2/hQ5aMw1pGXyY2rtE8/chXYUmu3AlVHKpm10KEdG9aMwbI/K76ZGw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-unicode-regex": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-unicode-regex/-/plugin-transform-unicode-regex-7.29.7.tgz",
      "integrity": "sha512-7D/x/23/d/3VqZ0QA+LGbZMlGwZjztBygSWWWsfTPoQ1oQ6Q1P6Mr3d0kk42XabyUVw+fha3LqdRsFqeKqvCyA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/plugin-transform-unicode-sets-regex": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/plugin-transform-unicode-sets-regex/-/plugin-transform-unicode-sets-regex-7.29.7.tgz",
      "integrity": "sha512-BLOhLht9DOJwIxlmp91wHvkXv1lguuHS3/FwUO8HL1H0u8s4hR1gASVFyilu9iGtcTRYqjTZmlsFFeQletntEg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-create-regexp-features-plugin": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0"
      }
    },
    "node_modules/@babel/preset-env": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/preset-env/-/preset-env-7.29.7.tgz",
      "integrity": "sha512-GYzX36n1nsciIb0uyH0GHwxwtNwPQIcpxSeiVLDtG/B7jB5xXgchnmL1f/jCX5o+pwnaDBtO60ONSJhEBJfxYA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/compat-data": "^7.29.7",
        "@babel/helper-compilation-targets": "^7.29.7",
        "@babel/helper-plugin-utils": "^7.29.7",
        "@babel/helper-validator-option": "^7.29.7",
        "@babel/plugin-bugfix-firefox-class-in-computed-class-key": "^7.29.7",
        "@babel/plugin-bugfix-safari-class-field-initializer-scope": "^7.29.7",
        "@babel/plugin-bugfix-safari-id-destructuring-collision-in-function-expression": "^7.29.7",
        "@babel/plugin-bugfix-safari-rest-destructuring-rhs-array": "^7.29.7",
        "@babel/plugin-bugfix-v8-spread-parameters-in-optional-chaining": "^7.29.7",
        "@babel/plugin-bugfix-v8-static-class-fields-redefine-readonly": "^7.29.7",
        "@babel/plugin-proposal-private-property-in-object": "7.21.0-placeholder-for-preset-env.2",
        "@babel/plugin-syntax-import-assertions": "^7.29.7",
        "@babel/plugin-syntax-import-attributes": "^7.29.7",
        "@babel/plugin-syntax-unicode-sets-regex": "^7.18.6",
        "@babel/plugin-transform-arrow-functions": "^7.29.7",
        "@babel/plugin-transform-async-generator-functions": "^7.29.7",
        "@babel/plugin-transform-async-to-generator": "^7.29.7",
        "@babel/plugin-transform-block-scoped-functions": "^7.29.7",
        "@babel/plugin-transform-block-scoping": "^7.29.7",
        "@babel/plugin-transform-class-properties": "^7.29.7",
        "@babel/plugin-transform-class-static-block": "^7.29.7",
        "@babel/plugin-transform-classes": "^7.29.7",
        "@babel/plugin-transform-computed-properties": "^7.29.7",
        "@babel/plugin-transform-destructuring": "^7.29.7",
        "@babel/plugin-transform-dotall-regex": "^7.29.7",
        "@babel/plugin-transform-duplicate-keys": "^7.29.7",
        "@babel/plugin-transform-duplicate-named-capturing-groups-regex": "^7.29.7",
        "@babel/plugin-transform-dynamic-import": "^7.29.7",
        "@babel/plugin-transform-explicit-resource-management": "^7.29.7",
        "@babel/plugin-transform-exponentiation-operator": "^7.29.7",
        "@babel/plugin-transform-export-namespace-from": "^7.29.7",
        "@babel/plugin-transform-for-of": "^7.29.7",
        "@babel/plugin-transform-function-name": "^7.29.7",
        "@babel/plugin-transform-json-strings": "^7.29.7",
        "@babel/plugin-transform-literals": "^7.29.7",
        "@babel/plugin-transform-logical-assignment-operators": "^7.29.7",
        "@babel/plugin-transform-member-expression-literals": "^7.29.7",
        "@babel/plugin-transform-modules-amd": "^7.29.7",
        "@babel/plugin-transform-modules-commonjs": "^7.29.7",
        "@babel/plugin-transform-modules-systemjs": "^7.29.7",
        "@babel/plugin-transform-modules-umd": "^7.29.7",
        "@babel/plugin-transform-named-capturing-groups-regex": "^7.29.7",
        "@babel/plugin-transform-new-target": "^7.29.7",
        "@babel/plugin-transform-nullish-coalescing-operator": "^7.29.7",
        "@babel/plugin-transform-numeric-separator": "^7.29.7",
        "@babel/plugin-transform-object-rest-spread": "^7.29.7",
        "@babel/plugin-transform-object-super": "^7.29.7",
        "@babel/plugin-transform-optional-catch-binding": "^7.29.7",
        "@babel/plugin-transform-optional-chaining": "^7.29.7",
        "@babel/plugin-transform-parameters": "^7.29.7",
        "@babel/plugin-transform-private-methods": "^7.29.7",
        "@babel/plugin-transform-private-property-in-object": "^7.29.7",
        "@babel/plugin-transform-property-literals": "^7.29.7",
        "@babel/plugin-transform-regenerator": "^7.29.7",
        "@babel/plugin-transform-regexp-modifiers": "^7.29.7",
        "@babel/plugin-transform-reserved-words": "^7.29.7",
        "@babel/plugin-transform-shorthand-properties": "^7.29.7",
        "@babel/plugin-transform-spread": "^7.29.7",
        "@babel/plugin-transform-sticky-regex": "^7.29.7",
        "@babel/plugin-transform-template-literals": "^7.29.7",
        "@babel/plugin-transform-typeof-symbol": "^7.29.7",
        "@babel/plugin-transform-unicode-escapes": "^7.29.7",
        "@babel/plugin-transform-unicode-property-regex": "^7.29.7",
        "@babel/plugin-transform-unicode-regex": "^7.29.7",
        "@babel/plugin-transform-unicode-sets-regex": "^7.29.7",
        "@babel/preset-modules": "0.1.6-no-external-plugins",
        "babel-plugin-polyfill-corejs2": "^0.4.15",
        "babel-plugin-polyfill-corejs3": "^0.14.0",
        "babel-plugin-polyfill-regenerator": "^0.6.6",
        "core-js-compat": "^3.48.0",
        "semver": "^6.3.1"
      },
      "engines": {
        "node": ">=6.9.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0"
      }
    },
    "node_modules/@babel/preset-modules": {
      "version": "0.1.6-no-external-plugins",
      "resolved": "https://registry.npmjs.org/@babel/preset-modules/-/preset-modules-0.1.6-no-external-plugins.tgz",
      "integrity": "sha512-HrcgcIESLm9aIR842yhJ5RWan/gebQUJ6E/E5+rf0y9o6oj7w0Br+sWuL6kEQ/o/AdfvR1Je9jG18/gnpwjEyA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-plugin-utils": "^7.0.0",
        "@babel/types": "^7.4.4",
        "esutils": "^2.0.2"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0-0 || ^8.0.0-0 <8.0.0"
      }
    },
    "node_modules/@babel/runtime": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/runtime/-/runtime-7.29.7.tgz",
      "integrity": "sha512-Nq8OhGWiZIZGV6hLHoyAKLLcJihP/xFeBMGJoUrxTX2psI8dCifzLhZISFb+VWS3wFMRDmCGw5R+dOySCqPLhw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/template": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/template/-/template-7.29.7.tgz",
      "integrity": "sha512-puq+Gf35oI24FeN11LkoUQFqv9uwNeWpxXZi/Ji3rRIoKAzKnxRaZ+Gkj0vKS9ZCiTESfng1N9LyOyXvo+m+Gg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/code-frame": "^7.29.7",
        "@babel/parser": "^7.29.7",
        "@babel/types": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/traverse": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/traverse/-/traverse-7.29.7.tgz",
      "integrity": "sha512-EhlfNQtZ+NK22w5BM61ciuiq1m58ed33Wr1Xan//ZRTy6hgjnwyCffRYwzsGXdASJSUJ1guZILsErh1eQcl+zw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/code-frame": "^7.29.7",
        "@babel/generator": "^7.29.7",
        "@babel/helper-globals": "^7.29.7",
        "@babel/parser": "^7.29.7",
        "@babel/template": "^7.29.7",
        "@babel/types": "^7.29.7",
        "debug": "^4.3.1"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@babel/types": {
      "version": "7.29.7",
      "resolved": "https://registry.npmjs.org/@babel/types/-/types-7.29.7.tgz",
      "integrity": "sha512-4zBIxpPzowiZpusoFkyGVwakdRJUyuH5PxQ/PrqghfdFWWasvnCdPfQXHrenDai+gyLARulZjZowCOj6fjT4pA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-string-parser": "^7.29.7",
        "@babel/helper-validator-identifier": "^7.29.7"
      },
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/@dnd-kit/accessibility": {
      "version": "3.1.1",
      "resolved": "https://registry.npmjs.org/@dnd-kit/accessibility/-/accessibility-3.1.1.tgz",
      "integrity": "sha512-2P+YgaXF+gRsIihwwY1gCsQSYnu9Zyj2py8kY5fFvUM1qm2WA2u639R6YNVfU4GWr+ZM5mqEsfHZZLoRONbemw==",
      "license": "MIT",
      "dependencies": {
        "tslib": "^2.0.0"
      },
      "peerDependencies": {
        "react": ">=16.8.0"
      }
    },
    "node_modules/@dnd-kit/core": {
      "version": "6.3.1",
      "resolved": "https://registry.npmjs.org/@dnd-kit/core/-/core-6.3.1.tgz",
      "integrity": "sha512-xkGBRQQab4RLwgXxoqETICr6S5JlogafbhNsidmrkVv2YRs5MLwpjoF2qpiGjQt8S9AoxtIV603s0GIUpY5eYQ==",
      "license": "MIT",
      "dependencies": {
        "@dnd-kit/accessibility": "^3.1.1",
        "@dnd-kit/utilities": "^3.2.2",
        "tslib": "^2.0.0"
      },
      "peerDependencies": {
        "react": ">=16.8.0",
        "react-dom": ">=16.8.0"
      }
    },
    "node_modules/@dnd-kit/sortable": {
      "version": "10.0.0",
      "resolved": "https://registry.npmjs.org/@dnd-kit/sortable/-/sortable-10.0.0.tgz",
      "integrity": "sha512-+xqhmIIzvAYMGfBYYnbKuNicfSsk4RksY2XdmJhT+HAC01nix6fHCztU68jooFiMUB01Ky3F0FyOvhG/BZrWkg==",
      "license": "MIT",
      "dependencies": {
        "@dnd-kit/utilities": "^3.2.2",
        "tslib": "^2.0.0"
      },
      "peerDependencies": {
        "@dnd-kit/core": "^6.3.0",
        "react": ">=16.8.0"
      }
    },
    "node_modules/@dnd-kit/utilities": {
      "version": "3.2.2",
      "resolved": "https://registry.npmjs.org/@dnd-kit/utilities/-/utilities-3.2.2.tgz",
      "integrity": "sha512-+MKAJEOfaBe5SmV6t34p80MMKhjvUz0vRrvVJbPT0WElzaOJ/1xs+D+KDv+tD/NE5ujfrChEcshd4fLn0wpiqg==",
      "license": "MIT",
      "dependencies": {
        "tslib": "^2.0.0"
      },
      "peerDependencies": {
        "react": ">=16.8.0"
      }
    },
    "node_modules/@embedded-postgres/darwin-arm64": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/darwin-arm64/-/darwin-arm64-18.4.0-beta.17.tgz",
      "integrity": "sha512-Kg1ZMNFzkVIJs3g4V2UYEc5X005km9rGinxFBH8R1sOU2Rblvz4pt2Uf93Pu8Rk273Ue9HIdrbMPpgUqwjUi0Q==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@embedded-postgres/darwin-x64": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/darwin-x64/-/darwin-x64-18.4.0-beta.17.tgz",
      "integrity": "sha512-4tShSYWMxUQTSWoQAdLnHISvRj6L9gTch9/31ASJPg6wgyN64LDRwMcOINEWybM7N0ropJ3nTYhFT3UX1bKY5Q==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@embedded-postgres/linux-arm": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/linux-arm/-/linux-arm-18.4.0-beta.17.tgz",
      "integrity": "sha512-VuD1nFasN7yG57zpJcp6MBXM0nXqGfb8GBQV+f1FGJ17+VMNYLIFLhFp99UlY4xnWG74FQC4NPYw8eCwSTJ6qg==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@embedded-postgres/linux-arm64": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/linux-arm64/-/linux-arm64-18.4.0-beta.17.tgz",
      "integrity": "sha512-TIzjtGnDGSD/LbdW0OWCEcbI+YVT0WKSfSr20TCkkP4UR8zeKe+QCZbO0/CM4hS9EWyZ4cDebjRvpRc3iMi6wg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@embedded-postgres/linux-ia32": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/linux-ia32/-/linux-ia32-18.4.0-beta.17.tgz",
      "integrity": "sha512-aSRe4kknqRHuedtpo/rDIaqa8r9VrKIgW9p5FkJyIFqUUkIkxRqND1dg8xrDRREcSUXRJKS0x+j/AuxflgYIfg==",
      "cpu": [
        "ia32"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@embedded-postgres/linux-ppc64": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/linux-ppc64/-/linux-ppc64-18.4.0-beta.17.tgz",
      "integrity": "sha512-zO2RRUFdKRPplrdhmglG39VXJZzDXu3P3ONAG1sFPhGh89vbk24Btd5P7uOmQLIpWehzL0s+UqUWoeE/ZUKvgw==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@embedded-postgres/linux-x64": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-18.4.0-beta.17.tgz",
      "integrity": "sha512-jVw/MdDtIX/vICH/DKIe6/mHpiCggdx6QVyza4vt/NbcZFsL0KhwglF6F1Koqx3gRBZ9XtN+vi63EsqSyqOSxA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@embedded-postgres/windows-x64": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/@embedded-postgres/windows-x64/-/windows-x64-18.4.0-beta.17.tgz",
      "integrity": "sha512-AwRerliA4IGWyW5jWBvHt5vidVUSB0QQW9Tt2y7ScnmifnCb/awfxZr4BkBSTv+gNt8Djcddqs+xSF5Z6/CkTg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/@eslint-community/eslint-utils": {
      "version": "4.9.1",
      "resolved": "https://registry.npmjs.org/@eslint-community/eslint-utils/-/eslint-utils-4.9.1.tgz",
      "integrity": "sha512-phrYmNiYppR7znFEdqgfWHXR6NCkZEK7hwWDHZUjit/2/U0r6XvkDl0SYnoM51Hq7FhCGdLDT6zxCCOY1hexsQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "eslint-visitor-keys": "^3.4.3"
      },
      "engines": {
        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      },
      "peerDependencies": {
        "eslint": "^6.0.0 || ^7.0.0 || >=8.0.0"
      }
    },
    "node_modules/@eslint-community/eslint-utils/node_modules/eslint-visitor-keys": {
      "version": "3.4.3",
      "resolved": "https://registry.npmjs.org/eslint-visitor-keys/-/eslint-visitor-keys-3.4.3.tgz",
      "integrity": "sha512-wpc+LXeiyiisxPlEkUzU6svyS1frIO3Mgxj1fdy7Pm8Ygzguax2N3Fa/D/ag1WqbOprdI+uY6wMUl8/a2G+iag==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/@eslint-community/regexpp": {
      "version": "4.12.2",
      "resolved": "https://registry.npmjs.org/@eslint-community/regexpp/-/regexpp-4.12.2.tgz",
      "integrity": "sha512-EriSTlt5OC9/7SXkRSCAhfSxxoSUgBm33OH+IkwbdpgoqsSsUg7y3uh+IICI/Qg4BBWr3U2i39RpmycbxMq4ew==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "^12.0.0 || ^14.0.0 || >=16.0.0"
      }
    },
    "node_modules/@eslint/config-array": {
      "version": "0.21.2",
      "resolved": "https://registry.npmjs.org/@eslint/config-array/-/config-array-0.21.2.tgz",
      "integrity": "sha512-nJl2KGTlrf9GjLimgIru+V/mzgSK0ABCDQRvxw5BjURL7WfH5uoWmizbH7QB6MmnMBd8cIC9uceWnezL1VZWWw==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@eslint/object-schema": "^2.1.7",
        "debug": "^4.3.1",
        "minimatch": "^3.1.5"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/config-helpers": {
      "version": "0.4.2",
      "resolved": "https://registry.npmjs.org/@eslint/config-helpers/-/config-helpers-0.4.2.tgz",
      "integrity": "sha512-gBrxN88gOIf3R7ja5K9slwNayVcZgK6SOUORm2uBzTeIEfeVaIhOpCtTox3P6R7o2jLFwLFTLnC7kU/RGcYEgw==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@eslint/core": "^0.17.0"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/core": {
      "version": "0.17.0",
      "resolved": "https://registry.npmjs.org/@eslint/core/-/core-0.17.0.tgz",
      "integrity": "sha512-yL/sLrpmtDaFEiUj1osRP4TI2MDz1AddJL+jZ7KSqvBuliN4xqYY54IfdN8qD8Toa6g1iloph1fxQNkjOxrrpQ==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@types/json-schema": "^7.0.15"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/eslintrc": {
      "version": "3.3.5",
      "resolved": "https://registry.npmjs.org/@eslint/eslintrc/-/eslintrc-3.3.5.tgz",
      "integrity": "sha512-4IlJx0X0qftVsN5E+/vGujTRIFtwuLbNsVUe7TO6zYPDR1O6nFwvwhIKEKSrl6dZchmYBITazxKoUYOjdtjlRg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "ajv": "^6.14.0",
        "debug": "^4.3.2",
        "espree": "^10.0.1",
        "globals": "^14.0.0",
        "ignore": "^5.2.0",
        "import-fresh": "^3.2.1",
        "js-yaml": "^4.1.1",
        "minimatch": "^3.1.5",
        "strip-json-comments": "^3.1.1"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/@eslint/eslintrc/node_modules/globals": {
      "version": "14.0.0",
      "resolved": "https://registry.npmjs.org/globals/-/globals-14.0.0.tgz",
      "integrity": "sha512-oahGvuMGQlPw/ivIYBjVSrWAfWLBeku5tpPE2fOPLi+WHffIWbuh2tCjhyQhTBPMf5E9jDEH4FOmTYgYwbKwtQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/@eslint/js": {
      "version": "9.39.4",
      "resolved": "https://registry.npmjs.org/@eslint/js/-/js-9.39.4.tgz",
      "integrity": "sha512-nE7DEIchvtiFTwBw4Lfbu59PG+kCofhjsKaCWzxTpt4lfRjRMqG6uMBzKXuEcyXhOHoUp9riAm7/aWYGhXZ9cw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://eslint.org/donate"
      }
    },
    "node_modules/@eslint/object-schema": {
      "version": "2.1.7",
      "resolved": "https://registry.npmjs.org/@eslint/object-schema/-/object-schema-2.1.7.tgz",
      "integrity": "sha512-VtAOaymWVfZcmZbp6E2mympDIHvyjXs/12LqWYjVw6qjrfF+VK+fyG33kChz3nnK+SU5/NeHOqrTEHS8sXO3OA==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/plugin-kit": {
      "version": "0.4.1",
      "resolved": "https://registry.npmjs.org/@eslint/plugin-kit/-/plugin-kit-0.4.1.tgz",
      "integrity": "sha512-43/qtrDUokr7LJqoF2c3+RInu/t4zfrpYdoSDfYyhg52rwLV6TnOvdG4fXm7IkSB3wErkcmJS9iEhjVtOSEjjA==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@eslint/core": "^0.17.0",
        "levn": "^0.4.1"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@humanfs/core": {
      "version": "0.19.2",
      "resolved": "https://registry.npmjs.org/@humanfs/core/-/core-0.19.2.tgz",
      "integrity": "sha512-UhXNm+CFMWcbChXywFwkmhqjs3PRCmcSa/hfBgLIb7oQ5HNb1wS0icWsGtSAUNgefHeI+eBrA8I1fxmbHsGdvA==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@humanfs/types": "^0.15.0"
      },
      "engines": {
        "node": ">=18.18.0"
      }
    },
    "node_modules/@humanfs/node": {
      "version": "0.16.8",
      "resolved": "https://registry.npmjs.org/@humanfs/node/-/node-0.16.8.tgz",
      "integrity": "sha512-gE1eQNZ3R++kTzFUpdGlpmy8kDZD/MLyHqDwqjkVQI0JMdI1D51sy1H958PNXYkM2rAac7e5/CnIKZrHtPh3BQ==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@humanfs/core": "^0.19.2",
        "@humanfs/types": "^0.15.0",
        "@humanwhocodes/retry": "^0.4.0"
      },
      "engines": {
        "node": ">=18.18.0"
      }
    },
    "node_modules/@humanfs/types": {
      "version": "0.15.0",
      "resolved": "https://registry.npmjs.org/@humanfs/types/-/types-0.15.0.tgz",
      "integrity": "sha512-ZZ1w0aoQkwuUuC7Yf+7sdeaNfqQiiLcSRbfI08oAxqLtpXQr9AIVX7Ay7HLDuiLYAaFPu8oBYNq/QIi9URHJ3Q==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=18.18.0"
      }
    },
    "node_modules/@humanwhocodes/module-importer": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/@humanwhocodes/module-importer/-/module-importer-1.0.1.tgz",
      "integrity": "sha512-bxveV4V8v5Yb4ncFTT3rPSgZBOpCkjfK0y4oVVVJwIuDVBRMDXrPyXRL988i5ap9m9bnyEEjWfm5WkBmtffLfA==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=12.22"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/nzakas"
      }
    },
    "node_modules/@humanwhocodes/retry": {
      "version": "0.4.3",
      "resolved": "https://registry.npmjs.org/@humanwhocodes/retry/-/retry-0.4.3.tgz",
      "integrity": "sha512-bV0Tgo9K4hfPCek+aMAn81RppFKv2ySDQeMoSZuvTASywNTnVJCArCZE2FWqpvIatKu7VMRLWlR1EazvVhDyhQ==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=18.18"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/nzakas"
      }
    },
    "node_modules/@isaacs/cliui": {
      "version": "9.0.0",
      "resolved": "https://registry.npmjs.org/@isaacs/cliui/-/cliui-9.0.0.tgz",
      "integrity": "sha512-AokJm4tuBHillT+FpMtxQ60n8ObyXBatq7jD2/JA9dxbDDokKQm8KMht5ibGzLVU9IJDIKK4TPKgMHEYMn3lMg==",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@jridgewell/gen-mapping": {
      "version": "0.3.13",
      "resolved": "https://registry.npmjs.org/@jridgewell/gen-mapping/-/gen-mapping-0.3.13.tgz",
      "integrity": "sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/sourcemap-codec": "^1.5.0",
        "@jridgewell/trace-mapping": "^0.3.24"
      }
    },
    "node_modules/@jridgewell/remapping": {
      "version": "2.3.5",
      "resolved": "https://registry.npmjs.org/@jridgewell/remapping/-/remapping-2.3.5.tgz",
      "integrity": "sha512-LI9u/+laYG4Ds1TDKSJW2YPrIlcVYOwi2fUC6xB43lueCjgxV4lffOCZCtYFiH6TNOX+tQKXx97T4IKHbhyHEQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/gen-mapping": "^0.3.5",
        "@jridgewell/trace-mapping": "^0.3.24"
      }
    },
    "node_modules/@jridgewell/resolve-uri": {
      "version": "3.1.2",
      "resolved": "https://registry.npmjs.org/@jridgewell/resolve-uri/-/resolve-uri-3.1.2.tgz",
      "integrity": "sha512-bRISgCIjP20/tbWSPWMEi54QVPRZExkuD9lJL+UIxUKtwVJA8wW1Trb1jMs1RFXo1CBTNZ/5hpC9QvmKWdopKw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.0.0"
      }
    },
    "node_modules/@jridgewell/source-map": {
      "version": "0.3.11",
      "resolved": "https://registry.npmjs.org/@jridgewell/source-map/-/source-map-0.3.11.tgz",
      "integrity": "sha512-ZMp1V8ZFcPG5dIWnQLr3NSI1MiCU7UETdS/A0G8V/XWHvJv3ZsFqutJn1Y5RPmAPX6F3BiE397OqveU/9NCuIA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/gen-mapping": "^0.3.5",
        "@jridgewell/trace-mapping": "^0.3.25"
      }
    },
    "node_modules/@jridgewell/sourcemap-codec": {
      "version": "1.5.5",
      "resolved": "https://registry.npmjs.org/@jridgewell/sourcemap-codec/-/sourcemap-codec-1.5.5.tgz",
      "integrity": "sha512-cYQ9310grqxueWbl+WuIUIaiUaDcj7WOq5fVhEljNVgRfOUhY9fy2zTvfoqWsnebh8Sl70VScFbICvJnLKB0Og==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@jridgewell/trace-mapping": {
      "version": "0.3.31",
      "resolved": "https://registry.npmjs.org/@jridgewell/trace-mapping/-/trace-mapping-0.3.31.tgz",
      "integrity": "sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/resolve-uri": "^3.1.0",
        "@jridgewell/sourcemap-codec": "^1.4.14"
      }
    },
    "node_modules/@oxc-project/types": {
      "version": "0.152.0",
      "resolved": "https://registry.npmjs.org/@oxc-project/types/-/types-0.152.0.tgz",
      "integrity": "sha512-oM/5rLBm2tPkg0iBgkH/FOeR3PCDpY19GTgAZjMFM8h9WI9VW7cLgzp6nwtarYKmovavIQZ+Fe/RKX/8C8O/Rw==",
      "dev": true,
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/oxc-project"
      }
    },
    "node_modules/@reduxjs/toolkit": {
      "version": "2.12.0",
      "resolved": "https://registry.npmjs.org/@reduxjs/toolkit/-/toolkit-2.12.0.tgz",
      "integrity": "sha512-KiT+RzZbp6mQET+Mg+h2c97+9j1sNflUxQkIHI7Yuzf6Peu+OYpmkn6nbHWmLLWj+1ZODUJFwGZ7gx3L9R9EOw==",
      "license": "MIT",
      "dependencies": {
        "@standard-schema/spec": "^1.0.0",
        "@standard-schema/utils": "^0.3.0",
        "immer": "^11.0.0",
        "redux": "^5.0.1",
        "redux-thunk": "^3.1.0",
        "reselect": "^5.1.0"
      },
      "peerDependencies": {
        "react": "^16.9.0 || ^17.0.0 || ^18 || ^19",
        "react-redux": "^7.2.1 || ^8.1.3 || ^9.0.0"
      },
      "peerDependenciesMeta": {
        "react": {
          "optional": true
        },
        "react-redux": {
          "optional": true
        }
      }
    },
    "node_modules/@rolldown/binding-android-arm-eabi": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-android-arm-eabi/-/binding-android-arm-eabi-1.2.12.tgz",
      "integrity": "sha512-dB/a1214qKfHMXCpgqR4OZT+jS4kTyEXbQGJPqzobt5EwH5rX080pxE37alt3RzvR1bf1Yz/yGqRfrYAxuPw0A==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-android-arm64": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-android-arm64/-/binding-android-arm64-1.2.12.tgz",
      "integrity": "sha512-7KHFgQ5VJxIHcLlrwrc3Xbds7oTNQT7Pgi9gQCJKrd2VGab/UksIOYp6VD8MzCstGxOKMgNamPwUCfxPdP1OHg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-darwin-arm64": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-darwin-arm64/-/binding-darwin-arm64-1.2.12.tgz",
      "integrity": "sha512-3YIhqHD96nA5SaYNRBR16HnGv4oavZvXfD/ayHM+oYZ0WD/8lBAtf6zQua4kEyAvpqrluKXl0lnOBoiNby7x9w==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-darwin-x64": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-darwin-x64/-/binding-darwin-x64-1.2.12.tgz",
      "integrity": "sha512-UuuJ35MFw4gmFOrE9pEqIV+K3syIKveph+Qc1/ljHZVdoDW4pz/JHR/eMVom+TZGl/5OOvGJOWaOCVt3ZfqhxA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-freebsd-x64": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-freebsd-x64/-/binding-freebsd-x64-1.2.12.tgz",
      "integrity": "sha512-uMvssit0a4W+/7D8CbHUvG719mH3R2jwXAlh/XcPvuHTE0g++LymF88DCGNX0HM2rBOn0xrzgXktIB6fLSJBTQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-arm-gnueabihf": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-arm-gnueabihf/-/binding-linux-arm-gnueabihf-1.2.12.tgz",
      "integrity": "sha512-XcFu0R0xWnwzSf4IQgFH1rJIckPN1pLy2R+4r9IDB7Yfu/ys9cVqfa4pBrMHj7a3gl8mIR4nRNPg0e5IvEVs6g==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-arm64-gnu": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-1.2.12.tgz",
      "integrity": "sha512-260UrKgn8tz39ak+SMDOirKzr7V04M9dWPw5llW00SwBivCZoWcRBKV1d8cXnRkUmSZA3BdiUmBHWk7734Ulpw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-arm64-musl": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-arm64-musl/-/binding-linux-arm64-musl-1.2.12.tgz",
      "integrity": "sha512-5YK1I9SqDkbPgc1IA8BgDl34suqUS2q0KWnBrirm0E51YjOs6eo6dV6jbQfNE/argHRSvd0QUGgtpIoYx+WWpw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-ppc64-gnu": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-ppc64-gnu/-/binding-linux-ppc64-gnu-1.2.12.tgz",
      "integrity": "sha512-Rkcrmp7eFRg74yL5fXEU91JEWbdEPLevWwGtXpmhbjlD1StScbWTmO94Bhly+Mo+ketKYkdmM1vNUKeWSlx8cQ==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-s390x-gnu": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-s390x-gnu/-/binding-linux-s390x-gnu-1.2.12.tgz",
      "integrity": "sha512-qvK4DuAsQc2BSjlx+Xr+IzOIvvxbGZqxFwdWfG6F518Erj0GGISyQbJ6pIappnOxlNPzNHvo/L0BwB30GZ+zVw==",
      "cpu": [
        "s390x"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-x64-gnu": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-1.2.12.tgz",
      "integrity": "sha512-Q9uLBO53Xd4QIq1WOycVQyPP1O4HhraEV2qqb3uTrnVw6QZih9duY4vNXOivL1xoUS1/z+W8eF4NMfl2a8Sdjw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-x64-musl": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-x64-musl/-/binding-linux-x64-musl-1.2.12.tgz",
      "integrity": "sha512-3IBxWFMjbOZskDPKv8Lf9BCnahlKuHthWkYnyIxOH/QcJrFcS4EmcenthApkwr/5+nEqZlLzeYbxeMaX7A5u4g==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-openharmony-arm64": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-openharmony-arm64/-/binding-openharmony-arm64-1.2.12.tgz",
      "integrity": "sha512-xtX61xg4LKPkPWilZU1ynKClz5Gj4bf74LML4r3eVLWumKnGjoEr1OSHQhMdbBDoYTi+yjrujvpZe2pUnqCrrA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openharmony"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-win32-arm64-msvc": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-win32-arm64-msvc/-/binding-win32-arm64-msvc-1.2.12.tgz",
      "integrity": "sha512-At7fPB6PCaIjzgIhEZFxuT+BBFqiQibJDT4d3PhiR3f4E7bbMZF4aKblbFfEM3sETRDd1YiQx/+U/g/B/ou5Ew==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-win32-x64-msvc": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-win32-x64-msvc/-/binding-win32-x64-msvc-1.2.12.tgz",
      "integrity": "sha512-WIw2haVKwjuYdXkHaoC0mF8Le71TuCBxjrdKqLbJGctbBABj+ClfmNvtbOnzpq3RokNo5+V1qhtSzJyXorsklQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/pluginutils": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/@rolldown/pluginutils/-/pluginutils-1.0.1.tgz",
      "integrity": "sha512-2j9bGt5Jh8hj+vPtgzPtl72j0yRxHAyumoo6TNfAjsLB04UtpSvPbPcDcBMxz7n+9CYB0c1GxQFxYRg2jimqGw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@rollup/plugin-babel": {
      "version": "6.1.0",
      "resolved": "https://registry.npmjs.org/@rollup/plugin-babel/-/plugin-babel-6.1.0.tgz",
      "integrity": "sha512-dFZNuFD2YRcoomP4oYf+DvQNSUA9ih+A3vUqopQx5EdtPGo3WBnQcI/S8pwpz91UsGfL0HsMSOlaMld8HrbubA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-module-imports": "^7.18.6",
        "@rollup/pluginutils": "^5.0.1"
      },
      "engines": {
        "node": ">=14.0.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.0.0",
        "@types/babel__core": "^7.1.9",
        "rollup": "^1.20.0||^2.0.0||^3.0.0||^4.0.0"
      },
      "peerDependenciesMeta": {
        "@types/babel__core": {
          "optional": true
        },
        "rollup": {
          "optional": true
        }
      }
    },
    "node_modules/@rollup/plugin-node-resolve": {
      "version": "16.0.3",
      "resolved": "https://registry.npmjs.org/@rollup/plugin-node-resolve/-/plugin-node-resolve-16.0.3.tgz",
      "integrity": "sha512-lUYM3UBGuM93CnMPG1YocWu7X802BrNF3jW2zny5gQyLQgRFJhV1Sq0Zi74+dh/6NBx1DxFC4b4GXg9wUCG5Qg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@rollup/pluginutils": "^5.0.1",
        "@types/resolve": "1.20.2",
        "deepmerge": "^4.2.2",
        "is-module": "^1.0.0",
        "resolve": "^1.22.1"
      },
      "engines": {
        "node": ">=14.0.0"
      },
      "peerDependencies": {
        "rollup": "^2.78.0||^3.0.0||^4.0.0"
      },
      "peerDependenciesMeta": {
        "rollup": {
          "optional": true
        }
      }
    },
    "node_modules/@rollup/plugin-node-resolve/node_modules/resolve": {
      "version": "1.22.12",
      "resolved": "https://registry.npmjs.org/resolve/-/resolve-1.22.12.tgz",
      "integrity": "sha512-TyeJ1zif53BPfHootBGwPRYT1RUt6oGWsaQr8UyZW/eAm9bKoijtvruSDEmZHm92CwS9nj7/fWttqPCgzep8CA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "is-core-module": "^2.16.1",
        "path-parse": "^1.0.7",
        "supports-preserve-symlinks-flag": "^1.0.0"
      },
      "bin": {
        "resolve": "bin/resolve"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/@rollup/plugin-replace": {
      "version": "6.0.3",
      "resolved": "https://registry.npmjs.org/@rollup/plugin-replace/-/plugin-replace-6.0.3.tgz",
      "integrity": "sha512-J4RZarRvQAm5IF0/LwUUg+obsm+xZhYnbMXmXROyoSE1ATJe3oXSb9L5MMppdxP2ylNSjv6zFBwKYjcKMucVfA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@rollup/pluginutils": "^5.0.1",
        "magic-string": "^0.30.3"
      },
      "engines": {
        "node": ">=14.0.0"
      },
      "peerDependencies": {
        "rollup": "^1.20.0||^2.0.0||^3.0.0||^4.0.0"
      },
      "peerDependenciesMeta": {
        "rollup": {
          "optional": true
        }
      }
    },
    "node_modules/@rollup/plugin-terser": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/@rollup/plugin-terser/-/plugin-terser-1.0.0.tgz",
      "integrity": "sha512-FnCxhTBx6bMOYQrar6C8h3scPt8/JwIzw3+AJ2K++6guogH5fYaIFia+zZuhqv0eo1RN7W1Pz630SyvLbDjhtQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "serialize-javascript": "^7.0.3",
        "smob": "^1.0.0",
        "terser": "^5.17.4"
      },
      "engines": {
        "node": ">=20.0.0"
      },
      "peerDependencies": {
        "rollup": "^2.0.0||^3.0.0||^4.0.0"
      },
      "peerDependenciesMeta": {
        "rollup": {
          "optional": true
        }
      }
    },
    "node_modules/@rollup/pluginutils": {
      "version": "5.4.0",
      "resolved": "https://registry.npmjs.org/@rollup/pluginutils/-/pluginutils-5.4.0.tgz",
      "integrity": "sha512-MfPp06CjRLfXQ3wY0R8vJDYBy/MvVcc9OulEfR0B8Iv9ko+GCNaRZ+EpJYFl27LhKsZK0o420sYCRHCjfCgeUg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@types/estree": "^1.0.0",
        "estree-walker": "^2.0.2",
        "picomatch": "^4.0.2"
      },
      "engines": {
        "node": ">=14.0.0"
      },
      "peerDependencies": {
        "rollup": "^1.20.0||^2.0.0||^3.0.0||^4.0.0"
      },
      "peerDependenciesMeta": {
        "rollup": {
          "optional": true
        }
      }
    },
    "node_modules/@rollup/pluginutils/node_modules/estree-walker": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/estree-walker/-/estree-walker-2.0.2.tgz",
      "integrity": "sha512-Rfkk/Mp/DL7JVje3u18FxFujQlTNR2q6QfMSMB7AvCBx91NGj/ba3kCfza0f6dVDbw7YlRf/nDrn7pQrCCyQ/w==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@rollup/rollup-android-arm-eabi": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-android-arm-eabi/-/rollup-android-arm-eabi-4.62.2.tgz",
      "integrity": "sha512-6o7ZLZK+BeenkZCFNDXqpbjw9bD6nuWonvS/lwQJp7NoVVxm6p3qE7qQ5jGuBjiFsgvqjD8mZAU5oWxTmbOeOg==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ]
    },
    "node_modules/@rollup/rollup-android-arm64": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-android-arm64/-/rollup-android-arm64-4.62.2.tgz",
      "integrity": "sha512-BaH7BllCACHoH1LguOU56UItGfUWjujlO65kS9LAodViaN4bwIKd7oeW/ZHJ/4ljr/7MIiENnNy3HJ0zXv8Zkw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ]
    },
    "node_modules/@rollup/rollup-darwin-arm64": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-darwin-arm64/-/rollup-darwin-arm64-4.62.2.tgz",
      "integrity": "sha512-v39RCCvj4He82I9sFmk+M1VZ0PLM9sfsLVikjfx2hYBNALhrrOR2D3JjQA6AhlaSOgcR+RzrKY7e1+bT6SUO/A==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ]
    },
    "node_modules/@rollup/rollup-darwin-x64": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-darwin-x64/-/rollup-darwin-x64-4.62.2.tgz",
      "integrity": "sha512-yl0y2vq3S3lHeuXhEdss6TWfKW8vkujImO12tn4ZkG/4oghr09LvdYm2RElVjokTQiUvDUGXLGsYeLqUMCKpGA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ]
    },
    "node_modules/@rollup/rollup-freebsd-arm64": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-freebsd-arm64/-/rollup-freebsd-arm64-4.62.2.tgz",
      "integrity": "sha512-tT4pvt4qXD+vEoezupCWi+a1F0vvDiksiHc+PxRlYTOH1I6/X4id9jPxTP+Fg+545euaFT1jJVs4CEdHZAU1vw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ]
    },
    "node_modules/@rollup/rollup-freebsd-x64": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-freebsd-x64/-/rollup-freebsd-x64-4.62.2.tgz",
      "integrity": "sha512-6nU5F2wCW+qvCBhTn1pdIU3bzsIoF7EUwsCDRxilWGprQR6yd508YnH9+OKFCwpfS8pjZqDUmnCAr7exax0XCg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ]
    },
    "node_modules/@rollup/rollup-linux-arm-gnueabihf": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-arm-gnueabihf/-/rollup-linux-arm-gnueabihf-4.62.2.tgz",
      "integrity": "sha512-n1GJHPOvpIfhi3TmrCeh6S6URt9BFCt0KQE3qvexyGCTAKpR4Lg+eWvNZEqu7epxwus/8ElT3hacYEucm49SZg==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-arm-musleabihf": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-arm-musleabihf/-/rollup-linux-arm-musleabihf-4.62.2.tgz",
      "integrity": "sha512-JqgflS8wEB+UXV/vS1RpRbifGBeN4D5lz8D8oOFbFZw4vedvdOgCFAjfBmIMdW3yL10XpQQ0Ambepw6MXrhOnA==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-arm64-gnu": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-arm64-gnu/-/rollup-linux-arm64-gnu-4.62.2.tgz",
      "integrity": "sha512-wnFJkogWvN4jm/hQRF2UBaeUmk20j5+DmHvoyWii2b8HJDyvz1MF2OU/6ynXt2KR63rbZLWkFpoytpdc/yBuSA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-arm64-musl": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-arm64-musl/-/rollup-linux-arm64-musl-4.62.2.tgz",
      "integrity": "sha512-HVu2bp0zhvJ8xHEV9+UUs7S90VadmBSY3LcIMvozbPo4AuMGDWlz3ymHLHZPX4hR67TKTt8Qp5PJ5RBg/i+RMQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-loong64-gnu": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-loong64-gnu/-/rollup-linux-loong64-gnu-4.62.2.tgz",
      "integrity": "sha512-mQqqAV8QaoSgr9I2fKDLY2BAVvmKjWoGiu/cSYQonsLvtqwEn1E4QYfnCOcp5zoEqNhsDYin1s6jx/VJmrxlZg==",
      "cpu": [
        "loong64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-loong64-musl": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-loong64-musl/-/rollup-linux-loong64-musl-4.62.2.tgz",
      "integrity": "sha512-IxKLoxCQ2IWi6bT2akyDUBGsOImDKB+sPp4EsTmwFQ/fMwpCKm8uLSSgP/Kx/QYUgKis6SEZ5/Nlhup0DIA0PQ==",
      "cpu": [
        "loong64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-ppc64-gnu": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-ppc64-gnu/-/rollup-linux-ppc64-gnu-4.62.2.tgz",
      "integrity": "sha512-Mk5ha2RQSgyFfmYYLkBpPnUk8D8FriBxesO1u9O75X0mHgXL1UQcH5Itl2lurWL2tj0RxV9b9tJgipac0hRY9A==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-ppc64-musl": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-ppc64-musl/-/rollup-linux-ppc64-musl-4.62.2.tgz",
      "integrity": "sha512-CjvEnqJL/0/TQ3TXX3OPIJ/kmBellrWd4heXUmHeJlTnmwjKpSJzoehLaL6Xk0ZnMHBu9dZuFADNOrtjF4v+2w==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-riscv64-gnu": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-riscv64-gnu/-/rollup-linux-riscv64-gnu-4.62.2.tgz",
      "integrity": "sha512-1SiZbzwdkaDURsew/tSOrooKiYy7EQGT6m8ufavAi9NEyQb/6VuIxFXAL1fqa4iZe3g4NbNk4P7J32z2tw5Mgg==",
      "cpu": [
        "riscv64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-riscv64-musl": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-riscv64-musl/-/rollup-linux-riscv64-musl-4.62.2.tgz",
      "integrity": "sha512-nQts12zJ3NQRoE6uYljOH89v7szzLDvG2JD/vsX+vGXU8w/At1GowTZ5/7qeFQ8m7L55rpR8Okugnuo5bgjy2Q==",
      "cpu": [
        "riscv64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-s390x-gnu": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-s390x-gnu/-/rollup-linux-s390x-gnu-4.62.2.tgz",
      "integrity": "sha512-E9/ll019jhPIJgpzfZoIkBGhcz+kKNgVWYRY0zr9srBdPPFVpvOKW8VaJKUbeK+eZXyQF9ltME+Kk6affeaPgg==",
      "cpu": [
        "s390x"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-x64-gnu": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-x64-gnu/-/rollup-linux-x64-gnu-4.62.2.tgz",
      "integrity": "sha512-5BqxR/pshjey51iliyzTD5Xi3EN0aLmQ2lZ3lvefVV9c82BvrLo2/6OT55iifpWBufs6kdwWbuOKS841DrmK9A==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-linux-x64-musl": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-linux-x64-musl/-/rollup-linux-x64-musl-4.62.2.tgz",
      "integrity": "sha512-uNN83XxQrRAh/w0/pmAfibcwyb6YWt4gP+dpnQKPVJshAloQ785ii8CT8ZCIxkGg9opVsvAlGhFitSm6D1Jjpg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/@rollup/rollup-openbsd-x64": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-openbsd-x64/-/rollup-openbsd-x64-4.62.2.tgz",
      "integrity": "sha512-srjEIxSH3LRnJN6THczDHWQplqEMFiAJrTab0msUryh9kwNpkICf3Ea6q6MN/2cZwRFUNx5w+h6Hpi4QuHS6Zg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openbsd"
      ]
    },
    "node_modules/@rollup/rollup-openharmony-arm64": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-openharmony-arm64/-/rollup-openharmony-arm64-4.62.2.tgz",
      "integrity": "sha512-8hOJnxgbyObnCm5AlRA3A931xX19xq80RjVTKgJOvEKWqJruP/Uf12IbAOaDjjEXYRewwHLfmF0YRIdK3OwKWA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openharmony"
      ]
    },
    "node_modules/@rollup/rollup-win32-arm64-msvc": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-win32-arm64-msvc/-/rollup-win32-arm64-msvc-4.62.2.tgz",
      "integrity": "sha512-mmF4AY1i0hG/bLWUctUq59gtmgaSIRa3cu/A3JFRp/sCNEme2bgDEiDS22P9FbnJB8NJNF4jPJiSP5RHQpUTDg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ]
    },
    "node_modules/@rollup/rollup-win32-ia32-msvc": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-win32-ia32-msvc/-/rollup-win32-ia32-msvc-4.62.2.tgz",
      "integrity": "sha512-DZgkknc6jhHrk46V25vbAM0zZkyP0nSDkJB8/dRkLTxv470dOmWDqGoEJl/9A0dFfS7yE3REOwNDxpHwSLSt0Q==",
      "cpu": [
        "ia32"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ]
    },
    "node_modules/@rollup/rollup-win32-x64-gnu": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-win32-x64-gnu/-/rollup-win32-x64-gnu-4.62.2.tgz",
      "integrity": "sha512-T6xr6ucWSFto+VGajA8YH26LdpHRuP4YLHEKAtCWvJDOlnmWcDZVCI2Jmjr+IFHDlt2zRaTAKE4tfjTaWLgJBg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ]
    },
    "node_modules/@rollup/rollup-win32-x64-msvc": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/@rollup/rollup-win32-x64-msvc/-/rollup-win32-x64-msvc-4.62.2.tgz",
      "integrity": "sha512-BfzEnDJOt9T8M989/lA37EcJgat01wLRnoi5dQf3QzOH7jzpqTAzdDbVfRljVr5r+jzKqpbHeyOfAaXxAd0PAA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ]
    },
    "node_modules/@standard-schema/spec": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/@standard-schema/spec/-/spec-1.1.0.tgz",
      "integrity": "sha512-l2aFy5jALhniG5HgqrD6jXLi/rUWrKvqN/qJx6yoJsgKhblVd+iqqU4RCXavm/jPityDo5TCvKMnpjKnOriy0w==",
      "license": "MIT"
    },
    "node_modules/@standard-schema/utils": {
      "version": "0.3.0",
      "resolved": "https://registry.npmjs.org/@standard-schema/utils/-/utils-0.3.0.tgz",
      "integrity": "sha512-e7Mew686owMaPJVNNLs55PUvgz371nKgwsc4vxE49zsODpJEnxgxRo2y/OKrqueavXgZNMDVj3DdHFlaSAeU8g==",
      "license": "MIT"
    },
    "node_modules/@supabase/auth-js": {
      "version": "2.110.3",
      "resolved": "https://registry.npmjs.org/@supabase/auth-js/-/auth-js-2.110.3.tgz",
      "integrity": "sha512-aUPKlhOtJtH04sVcppDKeOlgIw28aQ4NqtnhwlkmbIbqNACpH5By+PNJyhiHkY17tBWGID70GIaQ96Fi8M/h8A==",
      "license": "MIT",
      "dependencies": {
        "tslib": "2.8.1"
      },
      "engines": {
        "node": ">=22.0.0"
      }
    },
    "node_modules/@supabase/functions-js": {
      "version": "2.110.3",
      "resolved": "https://registry.npmjs.org/@supabase/functions-js/-/functions-js-2.110.3.tgz",
      "integrity": "sha512-jT4kLSRuKVYGt/xY1z1N1HSuq5DeCZHIHkDsChaqcBRUDcDIG2VhPHeD0FbP+AwMy+KpGw7KfZ6jICdWlN+mmQ==",
      "license": "MIT",
      "dependencies": {
        "tslib": "2.8.1"
      },
      "engines": {
        "node": ">=22.0.0"
      }
    },
    "node_modules/@supabase/phoenix": {
      "version": "0.4.4",
      "resolved": "https://registry.npmjs.org/@supabase/phoenix/-/phoenix-0.4.4.tgz",
      "integrity": "sha512-Gt0pqoXuIqX/8dvG0OKp/wMCobXNH3klNbUPBNyOfN0YA1IswrM3HyWFMOPk1Jy+BRaIyDPcFx4jLBwHNmlyfQ==",
      "license": "MIT"
    },
    "node_modules/@supabase/postgrest-js": {
      "version": "2.110.3",
      "resolved": "https://registry.npmjs.org/@supabase/postgrest-js/-/postgrest-js-2.110.3.tgz",
      "integrity": "sha512-YLxqxmz8Ug350yRh18ULsxj26xFu8LEx2YQ32RzwO2SLAZWCKwyxTiEXDl4ZjmDz7Fp23kjPCNzTfjHTcT5DWw==",
      "license": "MIT",
      "dependencies": {
        "tslib": "2.8.1"
      },
      "engines": {
        "node": ">=22.0.0"
      }
    },
    "node_modules/@supabase/realtime-js": {
      "version": "2.110.3",
      "resolved": "https://registry.npmjs.org/@supabase/realtime-js/-/realtime-js-2.110.3.tgz",
      "integrity": "sha512-CVVoUWLqdQz4Uh/gg6mS9hmrnG2T/TIjgD8cCcn2W/MIFvypW5jXtUz8shEZToyHLpCWedKyeawVDgJF7JswVA==",
      "license": "MIT",
      "dependencies": {
        "@supabase/phoenix": "0.4.4",
        "tslib": "2.8.1"
      },
      "engines": {
        "node": ">=22.0.0"
      }
    },
    "node_modules/@supabase/storage-js": {
      "version": "2.110.3",
      "resolved": "https://registry.npmjs.org/@supabase/storage-js/-/storage-js-2.110.3.tgz",
      "integrity": "sha512-cslrXLgHGupTh6HTripRMxw70IDy0JD2hTiJg6oqP3hlQPBumLy8RoALycdBgocvq8ZhakYOZZWJZb1YPiEMtg==",
      "license": "MIT",
      "dependencies": {
        "iceberg-js": "^0.8.1",
        "tslib": "2.8.1"
      },
      "engines": {
        "node": ">=22.0.0"
      }
    },
    "node_modules/@supabase/supabase-js": {
      "version": "2.110.3",
      "resolved": "https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-2.110.3.tgz",
      "integrity": "sha512-Xg2dZas32iN0nvYjOEWjCP2oTSvQSnFqM6WJXhGI7Ue8HQ5IRuTmMZjThYxvqtAq1aUKBuiCxS9w0a8hJx4+lQ==",
      "license": "MIT",
      "dependencies": {
        "@supabase/auth-js": "2.110.3",
        "@supabase/functions-js": "2.110.3",
        "@supabase/postgrest-js": "2.110.3",
        "@supabase/realtime-js": "2.110.3",
        "@supabase/storage-js": "2.110.3"
      },
      "engines": {
        "node": ">=22.0.0"
      }
    },
    "node_modules/@tailwindcss/vite": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/vite/-/vite-4.3.2.tgz",
      "integrity": "sha512-eHpMeX4JXfVNJDEcsouTeCBubJBTcTLigeaw/NTUW6PB5ATKKXdyonnXgTBX2VuRbjz1hjfz6C5XAhr52ImQXA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@tailwindcss/node": "4.3.2",
        "@tailwindcss/oxide": "4.3.2",
        "tailwindcss": "4.3.2"
      },
      "peerDependencies": {
        "vite": "^5.2.0 || ^6 || ^7 || ^8"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/node": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/node/-/node-4.3.2.tgz",
      "integrity": "sha512-yWP/sqEcBLaD8JuA6zNwxoYKr75qxTioYwlRwekj5Jr/I5GXnoJfjetH/psLUIv74cYTH2lBUEzBkinthoYcBg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/remapping": "^2.3.5",
        "enhanced-resolve": "5.21.6",
        "jiti": "^2.7.0",
        "lightningcss": "1.32.0",
        "magic-string": "^0.30.21",
        "source-map-js": "^1.2.1",
        "tailwindcss": "4.3.2"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide/-/oxide-4.3.2.tgz",
      "integrity": "sha512-z8ZgnzX8gdNoWLBLqBPoh/sjnxkwvf9ZuWjnO0l0yIzbLa5/9S+eC5QxGZKRobVHIC3/1BoMWjHblqWjcgFgag==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 20"
      },
      "optionalDependencies": {
        "@tailwindcss/oxide-android-arm64": "4.3.2",
        "@tailwindcss/oxide-darwin-arm64": "4.3.2",
        "@tailwindcss/oxide-darwin-x64": "4.3.2",
        "@tailwindcss/oxide-freebsd-x64": "4.3.2",
        "@tailwindcss/oxide-linux-arm-gnueabihf": "4.3.2",
        "@tailwindcss/oxide-linux-arm64-gnu": "4.3.2",
        "@tailwindcss/oxide-linux-arm64-musl": "4.3.2",
        "@tailwindcss/oxide-linux-x64-gnu": "4.3.2",
        "@tailwindcss/oxide-linux-x64-musl": "4.3.2",
        "@tailwindcss/oxide-wasm32-wasi": "4.3.2",
        "@tailwindcss/oxide-win32-arm64-msvc": "4.3.2",
        "@tailwindcss/oxide-win32-x64-msvc": "4.3.2"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-android-arm64": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-android-arm64/-/oxide-android-arm64-4.3.2.tgz",
      "integrity": "sha512-WHxqIuHpvZ5VtdX6GTl1Ik/Vp2YuN42Et+0CdeaVd/frQ9jAvGmvR8vLT+jk3e8/Q3x8kECB9+R17pgpp2BulA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-darwin-arm64": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-darwin-arm64/-/oxide-darwin-arm64-4.3.2.tgz",
      "integrity": "sha512-GZypeUY/IDJW3877KeM+O67vbXr3MBnbtEL4aYhNErv/JWZhye2vGSWWG9tB6iiqR2MqRNkY8IOUy4NdSZV26w==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-darwin-x64": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-darwin-x64/-/oxide-darwin-x64-4.3.2.tgz",
      "integrity": "sha512-UIIzmefR6KO1sDU7MzRqAxC8iBpft/VhkGjTjnhoS6k7Z3rQ9wEgA1ODSiyH/tcSYssulNm4Ci3hOeK1jH7ccQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-freebsd-x64": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-freebsd-x64/-/oxide-freebsd-x64-4.3.2.tgz",
      "integrity": "sha512-GN+uAmcI6DNspnCDwtOAZrTz6oukJnp337qZvxqCGLd3BHBzJpO0ZbTLRvJNdztOeAmTzewewGIMPb0tk2R4WA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-linux-arm-gnueabihf": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-arm-gnueabihf/-/oxide-linux-arm-gnueabihf-4.3.2.tgz",
      "integrity": "sha512-4ABn7qSbdHRwTiDiuWNegCyb5+2FJ4vKIKc3DmKrvAFw7MU1Lm11dIkTPwUaFdTzc7IsOpDbqBrlh0x6y36U/w==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-linux-arm64-gnu": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-arm64-gnu/-/oxide-linux-arm64-gnu-4.3.2.tgz",
      "integrity": "sha512-wDgEIGwoM8w8pufh9LVt1PahDgNdKXrLC2qfAnV3vAmococ9RWbxeAw4pxPttd/TsJfwjyLf90Dg1y9y8I6Emw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-linux-arm64-musl": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-arm64-musl/-/oxide-linux-arm64-musl-4.3.2.tgz",
      "integrity": "sha512-J5Nuk0uZQIiMTJj3LEx4sAA9tMFUoXQZFv1J6An+QGYe53HKRJuFDi0rpq/tuouCZeAbOBY3kQ6g8qeD4TUjtA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-linux-x64-gnu": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-x64-gnu/-/oxide-linux-x64-gnu-4.3.2.tgz",
      "integrity": "sha512-kqCZpSKOBEJO4mz7OqWoofBZeXTAwaVGPj0ErAj7CojmhKpWVWVOnrt9dE8odoIraZq4oj3ausM37kXi+Tow8w==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-linux-x64-musl": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-x64-musl/-/oxide-linux-x64-musl-4.3.2.tgz",
      "integrity": "sha512-cixpqbh2toJDmkuCRI68nXA8ZxNmdK9Y+9v5h3MC3ZQKy/0BO8AWzlkWyRM7JAFSGBlfig4YVTPsK6MVgqz1uw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-wasm32-wasi": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.2.tgz",
      "integrity": "sha512-4ec2Z/LOmRsAgU23CS4xeJfcJlmRg94A/XrbGRCF1gyU/zdDfRLYDVsS+ynSZCmGNxQ1jQriQOKMQeQxBA3Isw==",
      "bundleDependencies": [
        "@napi-rs/wasm-runtime",
        "@emnapi/core",
        "@emnapi/runtime",
        "@tybys/wasm-util",
        "@emnapi/wasi-threads",
        "tslib"
      ],
      "cpu": [
        "wasm32"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "@emnapi/core": "^1.11.1",
        "@emnapi/runtime": "^1.11.1",
        "@emnapi/wasi-threads": "^1.2.2",
        "@napi-rs/wasm-runtime": "^1.1.4",
        "@tybys/wasm-util": "^0.10.2",
        "tslib": "^2.8.1"
      },
      "engines": {
        "node": ">=14.0.0"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/@emnapi/core": {
      "version": "1.11.1",
      "dev": true,
      "inBundle": true,
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "@emnapi/wasi-threads": "1.2.2",
        "tslib": "^2.4.0"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/@emnapi/runtime": {
      "version": "1.11.1",
      "dev": true,
      "inBundle": true,
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "tslib": "^2.4.0"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/@emnapi/wasi-threads": {
      "version": "1.2.2",
      "dev": true,
      "inBundle": true,
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "tslib": "^2.4.0"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/@napi-rs/wasm-runtime": {
      "version": "1.1.4",
      "dev": true,
      "inBundle": true,
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "@tybys/wasm-util": "^0.10.1"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/Brooooooklyn"
      },
      "peerDependencies": {
        "@emnapi/core": "^1.7.1",
        "@emnapi/runtime": "^1.7.1"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/@tybys/wasm-util": {
      "version": "0.10.2",
      "dev": true,
      "inBundle": true,
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "tslib": "^2.4.0"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/tslib": {
      "version": "2.8.1",
      "dev": true,
      "inBundle": true,
      "license": "0BSD",
      "optional": true
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-win32-arm64-msvc": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-win32-arm64-msvc/-/oxide-win32-arm64-msvc-4.3.2.tgz",
      "integrity": "sha512-Zyr/M0+XcYZu3bZrUytc7TXvrk0ftWfl8gN2MwekNDzhqhKRUucMPSeOzM0o0wH5AWOU49BsKRrfKxI2atCPMQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/@tailwindcss/oxide-win32-x64-msvc": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-win32-x64-msvc/-/oxide-win32-x64-msvc-4.3.2.tgz",
      "integrity": "sha512-QI9BO7KlNZsp2GuO0jwAAj5jCDABOKXRkCk2XuKTSaNEFSdfzqswYVTtCHBNKHLsqyjFyFkqlDiwkNbTYSssMQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss/-/lightningcss-1.32.0.tgz",
      "integrity": "sha512-NXYBzinNrblfraPGyrbPoD19C1h9lfI/1mzgWYvXUTe414Gz/X1FD2XBZSZM7rRTrMA8JL3OtAaGifrIKhQ5yQ==",
      "dev": true,
      "license": "MPL-2.0",
      "dependencies": {
        "detect-libc": "^2.0.3"
      },
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      },
      "optionalDependencies": {
        "lightningcss-android-arm64": "1.32.0",
        "lightningcss-darwin-arm64": "1.32.0",
        "lightningcss-darwin-x64": "1.32.0",
        "lightningcss-freebsd-x64": "1.32.0",
        "lightningcss-linux-arm-gnueabihf": "1.32.0",
        "lightningcss-linux-arm64-gnu": "1.32.0",
        "lightningcss-linux-arm64-musl": "1.32.0",
        "lightningcss-linux-x64-gnu": "1.32.0",
        "lightningcss-linux-x64-musl": "1.32.0",
        "lightningcss-win32-arm64-msvc": "1.32.0",
        "lightningcss-win32-x64-msvc": "1.32.0"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-android-arm64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-android-arm64/-/lightningcss-android-arm64-1.32.0.tgz",
      "integrity": "sha512-YK7/ClTt4kAK0vo6w3X+Pnm0D2cf2vPHbhOXdoNti1Ga0al1P4TBZhwjATvjNwLEBCnKvjJc2jQgHXH0NEwlAg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-darwin-arm64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-arm64/-/lightningcss-darwin-arm64-1.32.0.tgz",
      "integrity": "sha512-RzeG9Ju5bag2Bv1/lwlVJvBE3q6TtXskdZLLCyfg5pt+HLz9BqlICO7LZM7VHNTTn/5PRhHFBSjk5lc4cmscPQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-darwin-x64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-x64/-/lightningcss-darwin-x64-1.32.0.tgz",
      "integrity": "sha512-U+QsBp2m/s2wqpUYT/6wnlagdZbtZdndSmut/NJqlCcMLTWp5muCrID+K5UJ6jqD2BFshejCYXniPDbNh73V8w==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-freebsd-x64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-freebsd-x64/-/lightningcss-freebsd-x64-1.32.0.tgz",
      "integrity": "sha512-JCTigedEksZk3tHTTthnMdVfGf61Fky8Ji2E4YjUTEQX14xiy/lTzXnu1vwiZe3bYe0q+SpsSH/CTeDXK6WHig==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-linux-arm-gnueabihf": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm-gnueabihf/-/lightningcss-linux-arm-gnueabihf-1.32.0.tgz",
      "integrity": "sha512-x6rnnpRa2GL0zQOkt6rts3YDPzduLpWvwAF6EMhXFVZXD4tPrBkEFqzGowzCsIWsPjqSK+tyNEODUBXeeVHSkw==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-linux-arm64-gnu": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-gnu/-/lightningcss-linux-arm64-gnu-1.32.0.tgz",
      "integrity": "sha512-0nnMyoyOLRJXfbMOilaSRcLH3Jw5z9HDNGfT/gwCPgaDjnx0i8w7vBzFLFR1f6CMLKF8gVbebmkUN3fa/kQJpQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-linux-arm64-musl": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-musl/-/lightningcss-linux-arm64-musl-1.32.0.tgz",
      "integrity": "sha512-UpQkoenr4UJEzgVIYpI80lDFvRmPVg6oqboNHfoH4CQIfNA+HOrZ7Mo7KZP02dC6LjghPQJeBsvXhJod/wnIBg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-linux-x64-gnu": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.32.0.tgz",
      "integrity": "sha512-V7Qr52IhZmdKPVr+Vtw8o+WLsQJYCTd8loIfpDaMRWGUZfBOYEJeyJIkqGIDMZPwPx24pUMfwSxxI8phr/MbOA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-linux-x64-musl": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.32.0.tgz",
      "integrity": "sha512-bYcLp+Vb0awsiXg/80uCRezCYHNg1/l3mt0gzHnWV9XP1W5sKa5/TCdGWaR/zBM2PeF/HbsQv/j2URNOiVuxWg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-win32-arm64-msvc": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-arm64-msvc/-/lightningcss-win32-arm64-msvc-1.32.0.tgz",
      "integrity": "sha512-8SbC8BR40pS6baCM8sbtYDSwEVQd4JlFTOlaD3gWGHfThTcABnNDBda6eTZeqbofalIJhFx0qKzgHJmcPTnGdw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/lightningcss-win32-x64-msvc": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-x64-msvc/-/lightningcss-win32-x64-msvc-1.32.0.tgz",
      "integrity": "sha512-Amq9B/SoZYdDi1kFrojnoqPLxYhQ4Wo5XiL8EVJrVsB8ARoC1PWW6VGtT0WKCemjy8aC+louJnjS7U18x3b06Q==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/vite/node_modules/tailwindcss": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/tailwindcss/-/tailwindcss-4.3.2.tgz",
      "integrity": "sha512-WtctNNSH8A9jlMIqxzuYumOHU5uGZyRv0Q5svQl+oEPy5w84YpBxdb7MdqyiSPQge5jTJ6zFQLq0PFygdccSBA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@trickfilm400/rollup-plugin-off-main-thread": {
      "version": "3.0.0-pre1",
      "resolved": "https://registry.npmjs.org/@trickfilm400/rollup-plugin-off-main-thread/-/rollup-plugin-off-main-thread-3.0.0-pre1.tgz",
      "integrity": "sha512-/67zpWDBLV+oYAEL682s1ktXL0HgqX76f6gaVGkGnVZlBbm1zd0v4Bz8MFF2GGhoX9rvfq3KSQHubFHwa6w6/Q==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "ejs": "^3.1.10",
        "json5": "^2.2.3",
        "magic-string": "^0.30.21",
        "string.prototype.matchall": "^4.0.12"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/@types/d3-array": {
      "version": "3.2.2",
      "resolved": "https://registry.npmjs.org/@types/d3-array/-/d3-array-3.2.2.tgz",
      "integrity": "sha512-hOLWVbm7uRza0BYXpIIW5pxfrKe0W+D5lrFiAEYR+pb6w3N2SwSMaJbXdUfSEv+dT4MfHBLtn5js0LAWaO6otw==",
      "license": "MIT"
    },
    "node_modules/@types/d3-color": {
      "version": "3.1.3",
      "resolved": "https://registry.npmjs.org/@types/d3-color/-/d3-color-3.1.3.tgz",
      "integrity": "sha512-iO90scth9WAbmgv7ogoq57O9YpKmFBbmoEoCHDB2xMBY0+/KVrqAaCDyCE16dUspeOvIxFFRI+0sEtqDqy2b4A==",
      "license": "MIT"
    },
    "node_modules/@types/d3-ease": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/@types/d3-ease/-/d3-ease-3.0.2.tgz",
      "integrity": "sha512-NcV1JjO5oDzoK26oMzbILE6HW7uVXOHLQvHshBUW4UMdZGfiY6v5BeQwh9a9tCzv+CeefZQHJt5SRgK154RtiA==",
      "license": "MIT"
    },
    "node_modules/@types/d3-interpolate": {
      "version": "3.0.4",
      "resolved": "https://registry.npmjs.org/@types/d3-interpolate/-/d3-interpolate-3.0.4.tgz",
      "integrity": "sha512-mgLPETlrpVV1YRJIglr4Ez47g7Yxjl1lj7YKsiMCb27VJH9W8NVM6Bb9d8kkpG/uAQS5AmbA48q2IAolKKo1MA==",
      "license": "MIT",
      "dependencies": {
        "@types/d3-color": "*"
      }
    },
    "node_modules/@types/d3-path": {
      "version": "3.1.1",
      "resolved": "https://registry.npmjs.org/@types/d3-path/-/d3-path-3.1.1.tgz",
      "integrity": "sha512-VMZBYyQvbGmWyWVea0EHs/BwLgxc+MKi1zLDCONksozI4YJMcTt8ZEuIR4Sb1MMTE8MMW49v0IwI5+b7RmfWlg==",
      "license": "MIT"
    },
    "node_modules/@types/d3-scale": {
      "version": "4.0.9",
      "resolved": "https://registry.npmjs.org/@types/d3-scale/-/d3-scale-4.0.9.tgz",
      "integrity": "sha512-dLmtwB8zkAeO/juAMfnV+sItKjlsw2lKdZVVy6LRr0cBmegxSABiLEpGVmSJJ8O08i4+sGR6qQtb6WtuwJdvVw==",
      "license": "MIT",
      "dependencies": {
        "@types/d3-time": "*"
      }
    },
    "node_modules/@types/d3-shape": {
      "version": "3.1.8",
      "resolved": "https://registry.npmjs.org/@types/d3-shape/-/d3-shape-3.1.8.tgz",
      "integrity": "sha512-lae0iWfcDeR7qt7rA88BNiqdvPS5pFVPpo5OfjElwNaT2yyekbM0C9vK+yqBqEmHr6lDkRnYNoTBYlAgJa7a4w==",
      "license": "MIT",
      "dependencies": {
        "@types/d3-path": "*"
      }
    },
    "node_modules/@types/d3-time": {
      "version": "3.0.4",
      "resolved": "https://registry.npmjs.org/@types/d3-time/-/d3-time-3.0.4.tgz",
      "integrity": "sha512-yuzZug1nkAAaBlBBikKZTgzCeA+k1uy4ZFwWANOfKw5z5LRhV0gNA7gNkKm7HoK+HRN0wX3EkxGk0fpbWhmB7g==",
      "license": "MIT"
    },
    "node_modules/@types/d3-timer": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/@types/d3-timer/-/d3-timer-3.0.2.tgz",
      "integrity": "sha512-Ps3T8E8dZDam6fUyNiMkekK3XUsaUEik+idO9/YjPtfj2qruF8tFBXS7XhtE4iIXBLxhmLjP3SXpLhVf21I9Lw==",
      "license": "MIT"
    },
    "node_modules/@types/estree": {
      "version": "1.0.9",
      "resolved": "https://registry.npmjs.org/@types/estree/-/estree-1.0.9.tgz",
      "integrity": "sha512-GhdPgy1el4/ImP05X05Uw4cw2/M93BCUmnEvWZNStlCzEKME4Fkk+YpoA5OiHNQmoS7Cafb8Xa3Pya8m1Qrzeg==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@types/json-schema": {
      "version": "7.0.15",
      "resolved": "https://registry.npmjs.org/@types/json-schema/-/json-schema-7.0.15.tgz",
      "integrity": "sha512-5+fP8P8MFNC+AyZCDxrB2pkZFPGzqQWUzpSeuuVLvm8VMcorNYavBqoFcxK8bQz4Qsbn4oUEEem4wDLfcysGHA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@types/node": {
      "version": "22.19.19",
      "resolved": "https://registry.npmjs.org/@types/node/-/node-22.19.19.tgz",
      "integrity": "sha512-dyh/xO2Fh5bYrfWaaqGrRQQGkNdmYw6AmaAUvYeUMNTWQtvb796ikLdmTchRmOlOiIJ1TDXfWgVx1QkUlQ6Hew==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "undici-types": "~6.21.0"
      }
    },
    "node_modules/@types/react": {
      "version": "19.2.14",
      "resolved": "https://registry.npmjs.org/@types/react/-/react-19.2.14.tgz",
      "integrity": "sha512-ilcTH/UniCkMdtexkoCN0bI7pMcJDvmQFPvuPvmEaYA/NSfFTAgdUSLAoVjaRJm7+6PvcM+q1zYOwS4wTYMF9w==",
      "devOptional": true,
      "license": "MIT",
      "dependencies": {
        "csstype": "^3.2.2"
      }
    },
    "node_modules/@types/react-dom": {
      "version": "19.2.3",
      "resolved": "https://registry.npmjs.org/@types/react-dom/-/react-dom-19.2.3.tgz",
      "integrity": "sha512-jp2L/eY6fn+KgVVQAOqYItbF0VY/YApe5Mz2F0aykSO8gx31bYCZyvSeYxCHKvzHG5eZjc+zyaS5BrBWya2+kQ==",
      "dev": true,
      "license": "MIT",
      "peerDependencies": {
        "@types/react": "^19.2.0"
      }
    },
    "node_modules/@types/resolve": {
      "version": "1.20.2",
      "resolved": "https://registry.npmjs.org/@types/resolve/-/resolve-1.20.2.tgz",
      "integrity": "sha512-60BCwRFOZCQhDncwQdxxeOEEkbc5dIMccYLwbxsS4TUNeVECQ/pBJ0j09mrHOl/JJvpRPGwO9SvE4nR2Nb/a4Q==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@types/trusted-types": {
      "version": "2.0.7",
      "resolved": "https://registry.npmjs.org/@types/trusted-types/-/trusted-types-2.0.7.tgz",
      "integrity": "sha512-ScaPdn1dQczgbl0QFTeTOmVHFULt394XJgOQNoyVhZ6r2vLnMLJfBPd53SB52T/3G36VI1/g2MZaX0cwDuXsfw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@types/use-sync-external-store": {
      "version": "0.0.6",
      "resolved": "https://registry.npmjs.org/@types/use-sync-external-store/-/use-sync-external-store-0.0.6.tgz",
      "integrity": "sha512-zFDAD+tlpf2r4asuHEj0XH6pY6i0g5NeAHPn+15wk3BV6JA69eERFXC1gyGThDkVa1zCyKr5jox1+2LbV/AMLg==",
      "license": "MIT"
    },
    "node_modules/@typescript-eslint/eslint-plugin": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/eslint-plugin/-/eslint-plugin-8.59.3.tgz",
      "integrity": "sha512-PwFvSKsXGShKGW6n5bZOhGHEcCZXM8HofLK9fNsEwZXzFRjoY+XT1Vsf1zgyXdwTr0ZYz1/2tkZ0DBTT9jZjhw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@eslint-community/regexpp": "^4.12.2",
        "@typescript-eslint/scope-manager": "8.59.3",
        "@typescript-eslint/type-utils": "8.59.3",
        "@typescript-eslint/utils": "8.59.3",
        "@typescript-eslint/visitor-keys": "8.59.3",
        "ignore": "^7.0.5",
        "natural-compare": "^1.4.0",
        "ts-api-utils": "^2.5.0"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "@typescript-eslint/parser": "^8.59.3",
        "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0",
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/@typescript-eslint/eslint-plugin/node_modules/ignore": {
      "version": "7.0.5",
      "resolved": "https://registry.npmjs.org/ignore/-/ignore-7.0.5.tgz",
      "integrity": "sha512-Hs59xBNfUIunMFgWAbGX5cq6893IbWg4KnrjbYwX3tx0ztorVgTDA6B2sxf8ejHJ4wz8BqGUMYlnzNBer5NvGg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 4"
      }
    },
    "node_modules/@typescript-eslint/parser": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/parser/-/parser-8.59.3.tgz",
      "integrity": "sha512-HPwA+hVkfcriajbNvTmZv4VRauibay+cWArYUYq7u7W7PmGShMxbPxLvrwDme55a6d5alG3nrYfhyJ/G28XlLg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@typescript-eslint/scope-manager": "8.59.3",
        "@typescript-eslint/types": "8.59.3",
        "@typescript-eslint/typescript-estree": "8.59.3",
        "@typescript-eslint/visitor-keys": "8.59.3",
        "debug": "^4.4.3"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0",
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/@typescript-eslint/project-service": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/project-service/-/project-service-8.59.3.tgz",
      "integrity": "sha512-ECiUWa/KYRGDFUqTNehaRgzDshnJfkTABJxVemHk4ko22gcr0ukloKjWvyQ64g8YCV/UI47kN1dbmjf/GaQYng==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@typescript-eslint/tsconfig-utils": "^8.59.3",
        "@typescript-eslint/types": "^8.59.3",
        "debug": "^4.4.3"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/@typescript-eslint/scope-manager": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/scope-manager/-/scope-manager-8.59.3.tgz",
      "integrity": "sha512-t2LvZnoEfzKtnPjgeEu41xw5gxq9mQVfYy4OoZ4Vlt0sk3JwxmhCca/AR7DwOiHrjWgjAj6as4AhRLKSDfvZIA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@typescript-eslint/types": "8.59.3",
        "@typescript-eslint/visitor-keys": "8.59.3"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      }
    },
    "node_modules/@typescript-eslint/tsconfig-utils": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/tsconfig-utils/-/tsconfig-utils-8.59.3.tgz",
      "integrity": "sha512-PcIJHjmaREXLgIAIzLnSY9VucEzz8FKXsRgFa1DmdGCK/5tJpW03TKJF01Q6VZd1lLdz2sIKPWaDUZN9dp//dw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/@typescript-eslint/type-utils": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/type-utils/-/type-utils-8.59.3.tgz",
      "integrity": "sha512-g71d8QD8UaiHGvrJwyIS1hCX5r63w6Jll+4VEYhEAHXTDIqX1JgxhTAbEHtKntL9kuc4jRo7/GWw5xfCepSccQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@typescript-eslint/types": "8.59.3",
        "@typescript-eslint/typescript-estree": "8.59.3",
        "@typescript-eslint/utils": "8.59.3",
        "debug": "^4.4.3",
        "ts-api-utils": "^2.5.0"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0",
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/@typescript-eslint/types": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/types/-/types-8.59.3.tgz",
      "integrity": "sha512-ePFoH0g4ludssdRFqqDxQePCxU4WQyRa9+XVwjm7yLn0FKhMeoetC+qBEEI1Eyb1pGSDveTIT09Bvw2WhlGayg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      }
    },
    "node_modules/@typescript-eslint/typescript-estree": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/typescript-estree/-/typescript-estree-8.59.3.tgz",
      "integrity": "sha512-CbRjVRAf7Lr9Kr8RopKcbY45p2VfmmHrm0ygOCYFi7oU8q19m0Fs/6iHS7kNOmwpp+ob07ZVcAqlxUod9lYdmg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@typescript-eslint/project-service": "8.59.3",
        "@typescript-eslint/tsconfig-utils": "8.59.3",
        "@typescript-eslint/types": "8.59.3",
        "@typescript-eslint/visitor-keys": "8.59.3",
        "debug": "^4.4.3",
        "minimatch": "^10.2.2",
        "semver": "^7.7.3",
        "tinyglobby": "^0.2.15",
        "ts-api-utils": "^2.5.0"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/@typescript-eslint/typescript-estree/node_modules/balanced-match": {
      "version": "4.0.4",
      "resolved": "https://registry.npmjs.org/balanced-match/-/balanced-match-4.0.4.tgz",
      "integrity": "sha512-BLrgEcRTwX2o6gGxGOCNyMvGSp35YofuYzw9h1IMTRmKqttAZZVU67bdb9Pr2vUHA8+j3i2tJfjO6C6+4myGTA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "18 || 20 || >=22"
      }
    },
    "node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion": {
      "version": "5.0.12",
      "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
      "integrity": "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "balanced-match": "^4.0.2"
      },
      "engines": {
        "node": "20 || >=22"
      }
    },
    "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch": {
      "version": "10.2.5",
      "resolved": "https://registry.npmjs.org/minimatch/-/minimatch-10.2.5.tgz",
      "integrity": "sha512-MULkVLfKGYDFYejP07QOurDLLQpcjk7Fw+7jXS2R2czRQzR56yHRveU5NDJEOviH+hETZKSkIk5c+T23GjFUMg==",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "dependencies": {
        "brace-expansion": "^5.0.5"
      },
      "engines": {
        "node": "18 || 20 || >=22"
      },
      "funding": {
        "url": "https://github.com/sponsors/isaacs"
      }
    },
    "node_modules/@typescript-eslint/typescript-estree/node_modules/semver": {
      "version": "7.8.0",
      "resolved": "https://registry.npmjs.org/semver/-/semver-7.8.0.tgz",
      "integrity": "sha512-AcM7dV/5ul4EekoQ29Agm5vri8JNqRyj39o0qpX6vDF2GZrtutZl5RwgD1XnZjiTAfncsJhMI48QQH3sN87YNA==",
      "dev": true,
      "license": "ISC",
      "bin": {
        "semver": "bin/semver.js"
      },
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/@typescript-eslint/utils": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/utils/-/utils-8.59.3.tgz",
      "integrity": "sha512-JAvT14goBzRzzzZyqq3P9BLArIxTtQURUtFgQ/V7FO+eU+Gg6ES+5ymOPP1wRxXcxAYeivCk4uS3jCKWI1K8Zg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@eslint-community/eslint-utils": "^4.9.1",
        "@typescript-eslint/scope-manager": "8.59.3",
        "@typescript-eslint/types": "8.59.3",
        "@typescript-eslint/typescript-estree": "8.59.3"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0",
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/@typescript-eslint/visitor-keys": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/@typescript-eslint/visitor-keys/-/visitor-keys-8.59.3.tgz",
      "integrity": "sha512-f1UQF7ggd42YiwI5wGrRaPsa+P0CINBlrkLPmGfpq/u/I/oVtecoEIfFR9ag/oa1sLOsRNZ6xehf6qMZhQGBDg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@typescript-eslint/types": "8.59.3",
        "eslint-visitor-keys": "^5.0.0"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      }
    },
    "node_modules/@typescript-eslint/visitor-keys/node_modules/eslint-visitor-keys": {
      "version": "5.0.1",
      "resolved": "https://registry.npmjs.org/eslint-visitor-keys/-/eslint-visitor-keys-5.0.1.tgz",
      "integrity": "sha512-tD40eHxA35h0PEIZNeIjkHoDR4YjjJp34biM0mDvplBe//mB+IHCqHDGV7pxF+7MklTvighcCPPZC7ynWyjdTA==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": "^20.19.0 || ^22.13.0 || >=24"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/@vitejs/plugin-react": {
      "version": "6.0.2",
      "resolved": "https://registry.npmjs.org/@vitejs/plugin-react/-/plugin-react-6.0.2.tgz",
      "integrity": "sha512-DlSMqo4WhThw4vB8Mpn0Woe9J+Jfq1geJ61AKW0QEgLzGMNwtIMdxbDUzLxcun8W7NbJO0e2Jg/Nxm3cCSVzzg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@rolldown/pluginutils": "^1.0.0"
      },
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      },
      "peerDependencies": {
        "@rolldown/plugin-babel": "^0.1.7 || ^0.2.0",
        "babel-plugin-react-compiler": "^1.0.0",
        "vite": "^8.0.0"
      },
      "peerDependenciesMeta": {
        "@rolldown/plugin-babel": {
          "optional": true
        },
        "babel-plugin-react-compiler": {
          "optional": true
        }
      }
    },
    "node_modules/acorn": {
      "version": "8.16.0",
      "resolved": "https://registry.npmjs.org/acorn/-/acorn-8.16.0.tgz",
      "integrity": "sha512-UVJyE9MttOsBQIDKw1skb9nAwQuR5wuGD3+82K6JgJlm/Y+KI92oNsMNGZCYdDsVtRHSak0pcV5Dno5+4jh9sw==",
      "dev": true,
      "license": "MIT",
      "bin": {
        "acorn": "bin/acorn"
      },
      "engines": {
        "node": ">=0.4.0"
      }
    },
    "node_modules/acorn-jsx": {
      "version": "5.3.2",
      "resolved": "https://registry.npmjs.org/acorn-jsx/-/acorn-jsx-5.3.2.tgz",
      "integrity": "sha512-rq9s+JNhf0IChjtDXxllJ7g41oZk5SlXtp0LHwyA5cejwn7vKmKp4pPri6YEePv2PU65sAsegbXtIinmDFDXgQ==",
      "dev": true,
      "license": "MIT",
      "peerDependencies": {
        "acorn": "^6.0.0 || ^7.0.0 || ^8.0.0"
      }
    },
    "node_modules/ajv": {
      "version": "6.15.0",
      "resolved": "https://registry.npmjs.org/ajv/-/ajv-6.15.0.tgz",
      "integrity": "sha512-fgFx7Hfoq60ytK2c7DhnF8jIvzYgOMxfugjLOSMHjLIPgenqa7S7oaagATUq99mV6IYvN2tRmC0wnTYX6iPbMw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "fast-deep-equal": "^3.1.1",
        "fast-json-stable-stringify": "^2.0.0",
        "json-schema-traverse": "^0.4.1",
        "uri-js": "^4.2.2"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/epoberezkin"
      }
    },
    "node_modules/ansi-styles": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz",
      "integrity": "sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "color-convert": "^2.0.1"
      },
      "engines": {
        "node": ">=8"
      },
      "funding": {
        "url": "https://github.com/chalk/ansi-styles?sponsor=1"
      }
    },
    "node_modules/argparse": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz",
      "integrity": "sha512-8+9WqebbFzpX9OR+Wa6O29asIogeRMzcGtAINdpMHHyAg10f05aSFVBbcEqGf/PXw1EjAZ+q2/bEBg3DvurK3Q==",
      "dev": true,
      "license": "Python-2.0"
    },
    "node_modules/array-buffer-byte-length": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/array-buffer-byte-length/-/array-buffer-byte-length-1.0.2.tgz",
      "integrity": "sha512-LHE+8BuR7RYGDKvnrmcuSq3tDcKv9OFEXQt/HpbZhY7V6h0zlUXutnAD82GiFx9rdieCMjkvtcsPqBwgUl1Iiw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "is-array-buffer": "^3.0.5"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/arraybuffer.prototype.slice": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/arraybuffer.prototype.slice/-/arraybuffer.prototype.slice-1.0.4.tgz",
      "integrity": "sha512-BNoCY6SXXPQ7gF2opIP4GBE+Xw7U+pHMYKuzjgCN3GwiaIR09UUeKfheyIry77QtrCBlC0KK0q5/TER/tYh3PQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "array-buffer-byte-length": "^1.0.1",
        "call-bind": "^1.0.8",
        "define-properties": "^1.2.1",
        "es-abstract": "^1.23.5",
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.6",
        "is-array-buffer": "^3.0.4"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/async": {
      "version": "3.2.6",
      "resolved": "https://registry.npmjs.org/async/-/async-3.2.6.tgz",
      "integrity": "sha512-htCUDlxyyCLMgaM3xXg0C0LW2xqfuQ6p05pCEIsXuyQ+a1koYKTuBMzRNwmybfLgvJDMd0r1LTn4+E0Ti6C2AA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/async-exit-hook": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/async-exit-hook/-/async-exit-hook-2.0.1.tgz",
      "integrity": "sha512-NW2cX8m1Q7KPA7a5M2ULQeZ2wR5qI5PAbw5L0UOMxdioVk9PMZ0h1TmyZEkPYrCvYjDlFICusOu1dlEKAAeXBw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.12.0"
      }
    },
    "node_modules/async-function": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/async-function/-/async-function-1.0.0.tgz",
      "integrity": "sha512-hsU18Ae8CDTR6Kgu9DYf0EbCr/a5iGL0rytQDobUcdpYOKokk8LEjVphnXkDkgpi0wYVsqrXuP0bZxJaTqdgoA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/at-least-node": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/at-least-node/-/at-least-node-1.0.0.tgz",
      "integrity": "sha512-+q/t7Ekv1EDY2l6Gda6LLiX14rU9TV20Wa3ofeQmwPFZbOMo9DXrLbOjFaaclkXKWidIaopwAObQDqwWtGUjqg==",
      "dev": true,
      "license": "ISC",
      "engines": {
        "node": ">= 4.0.0"
      }
    },
    "node_modules/available-typed-arrays": {
      "version": "1.0.7",
      "resolved": "https://registry.npmjs.org/available-typed-arrays/-/available-typed-arrays-1.0.7.tgz",
      "integrity": "sha512-wvUjBtSGN7+7SjNpq/9M2Tg350UZD3q62IFZLbRAR1bSMlCo1ZaeW+BJ+D090e4hIIZLBcTDWe4Mh4jvUDajzQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "possible-typed-array-names": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/babel-plugin-polyfill-corejs2": {
      "version": "0.4.17",
      "resolved": "https://registry.npmjs.org/babel-plugin-polyfill-corejs2/-/babel-plugin-polyfill-corejs2-0.4.17.tgz",
      "integrity": "sha512-aTyf30K/rqAsNwN76zYrdtx8obu0E4KoUME29B1xj+B3WxgvWkp943vYQ+z8Mv3lw9xHXMHpvSPOBxzAkIa94w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/compat-data": "^7.28.6",
        "@babel/helper-define-polyfill-provider": "^0.6.8",
        "semver": "^6.3.1"
      },
      "peerDependencies": {
        "@babel/core": "^7.4.0 || ^8.0.0-0 <8.0.0"
      }
    },
    "node_modules/babel-plugin-polyfill-corejs3": {
      "version": "0.14.2",
      "resolved": "https://registry.npmjs.org/babel-plugin-polyfill-corejs3/-/babel-plugin-polyfill-corejs3-0.14.2.tgz",
      "integrity": "sha512-coWpDLJ410R781Npmn/SIBZEsAetR4xVi0SxLMXPaMO4lSf1MwnkGYMtkFxew0Dn8B3/CpbpYxN0JCgg8mn67g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-define-polyfill-provider": "^0.6.8",
        "core-js-compat": "^3.48.0"
      },
      "peerDependencies": {
        "@babel/core": "^7.4.0 || ^8.0.0-0 <8.0.0"
      }
    },
    "node_modules/babel-plugin-polyfill-regenerator": {
      "version": "0.6.8",
      "resolved": "https://registry.npmjs.org/babel-plugin-polyfill-regenerator/-/babel-plugin-polyfill-regenerator-0.6.8.tgz",
      "integrity": "sha512-M762rNHfSF1EV3SLtnCJXFoQbbIIz0OyRwnCmV0KPC7qosSfCO0QLTSuJX3ayAebubhE6oYBAYPrBA5ljowaZg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/helper-define-polyfill-provider": "^0.6.8"
      },
      "peerDependencies": {
        "@babel/core": "^7.4.0 || ^8.0.0-0 <8.0.0"
      }
    },
    "node_modules/balanced-match": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/balanced-match/-/balanced-match-1.0.2.tgz",
      "integrity": "sha512-3oSeUO0TMV67hN1AmbXsK4yaqU7tjiHlbxRDZOpH0KW9+CeX4bRAaX0Anxt0tx2MrpRpWwQaPwIlISEJhYU5Pw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/baseline-browser-mapping": {
      "version": "2.11.26",
      "resolved": "https://registry.npmjs.org/baseline-browser-mapping/-/baseline-browser-mapping-2.11.26.tgz",
      "integrity": "sha512-GLQdD3y6UF8iVuMJl5fHgE4jdn/ua7n+toKfLgNlg3BqQtOZjpy68T8Tup8/wGWZCDlm7KMg7tPb4MPn7oN0TQ==",
      "dev": true,
      "license": "Apache-2.0",
      "bin": {
        "baseline-browser-mapping": "dist/cli.cjs"
      },
      "engines": {
        "node": ">=6.0.0"
      }
    },
    "node_modules/brace-expansion": {
      "version": "1.1.21",
      "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-1.1.21.tgz",
      "integrity": "sha512-9zeA+KLZNNzglF2TPKRQEDyx6Yby7daAkuy8MiPzpXPsYDWi/DRM8jmwUDxokQjYqBpv5DgPiwD4h4ZZSy1Ujw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "balanced-match": "^1.0.0",
        "concat-map": "0.0.1"
      }
    },
    "node_modules/browserslist": {
      "version": "4.29.3",
      "resolved": "https://registry.npmjs.org/browserslist/-/browserslist-4.29.3.tgz",
      "integrity": "sha512-1R4kiYKXGViqEN0CnoDrXc1StD9niAwu+j2dukWzrD4bJgsD4lDmEp0CRbc6E/vYJIfTHwPmwyaKtVSudICdPA==",
      "dev": true,
      "funding": [
        {
          "type": "opencollective",
          "url": "https://opencollective.com/browserslist"
        },
        {
          "type": "tidelift",
          "url": "https://tidelift.com/funding/github/npm/browserslist"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "baseline-browser-mapping": "^2.11.26",
        "caniuse-lite": "^1.0.30001813",
        "electron-to-chromium": "^1.5.439",
        "node-releases": "^2.0.57",
        "update-browserslist-db": "^1.3.3"
      },
      "bin": {
        "browserslist": "cli.js"
      },
      "engines": {
        "node": "^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7"
      }
    },
    "node_modules/buffer-from": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/buffer-from/-/buffer-from-1.1.2.tgz",
      "integrity": "sha512-E+XQCRwSbaaiChtv6k6Dwgc+bx+Bs6vuKJHHl5kox/BaKbhiXzqQOwK4cO22yElGp2OCmjwVhT3HmxgyPGnJfQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/call-bind": {
      "version": "1.0.9",
      "resolved": "https://registry.npmjs.org/call-bind/-/call-bind-1.0.9.tgz",
      "integrity": "sha512-a/hy+pNsFUTR+Iz8TCJvXudKVLAnz/DyeSUo10I5yvFDQJBFU2s9uqQpoSrJlroHUKoKqzg+epxyP9lqFdzfBQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind-apply-helpers": "^1.0.2",
        "es-define-property": "^1.0.1",
        "get-intrinsic": "^1.3.0",
        "set-function-length": "^1.2.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/call-bind-apply-helpers": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/call-bind-apply-helpers/-/call-bind-apply-helpers-1.0.2.tgz",
      "integrity": "sha512-Sp1ablJ0ivDkSzjcaJdxEunN5/XvksFJ2sMBFfq6x0ryhQV/2b/KwFe21cMpmHtPOSij8K99/wSfoEuTObmuMQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "function-bind": "^1.1.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/call-bound": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/call-bound/-/call-bound-1.0.4.tgz",
      "integrity": "sha512-+ys997U96po4Kx/ABpBCqhA9EuxJaQWDQg7295H4hBphv3IZg0boBKuwYpt4YXp6MZ5AmZQnU/tyMTlRpaSejg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind-apply-helpers": "^1.0.2",
        "get-intrinsic": "^1.3.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/callsites": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/callsites/-/callsites-3.1.0.tgz",
      "integrity": "sha512-P8BjAsXvZS+VIDUI11hHCQEv74YT67YUi5JJFNWIqL235sBmjX4+qx9Muvls5ivyNENctx46xQLQ3aTuE7ssaQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/caniuse-lite": {
      "version": "1.0.30001814",
      "resolved": "https://registry.npmjs.org/caniuse-lite/-/caniuse-lite-1.0.30001814.tgz",
      "integrity": "sha512-/Uaf1lAzr59XcMpW0o96WoEfr+VXK2OX4U9AgFoiSHsVJ4HppnIFUjtYzsyDH2+tgANaQb2/oxYGwCPapN1FpA==",
      "dev": true,
      "funding": [
        {
          "type": "opencollective",
          "url": "https://opencollective.com/browserslist"
        },
        {
          "type": "tidelift",
          "url": "https://tidelift.com/funding/github/npm/caniuse-lite"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "CC-BY-4.0"
    },
    "node_modules/chalk": {
      "version": "4.1.2",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz",
      "integrity": "sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "ansi-styles": "^4.1.0",
        "supports-color": "^7.1.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/chalk/chalk?sponsor=1"
      }
    },
    "node_modules/clsx": {
      "version": "2.1.1",
      "resolved": "https://registry.npmjs.org/clsx/-/clsx-2.1.1.tgz",
      "integrity": "sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA==",
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/color-convert": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/color-convert/-/color-convert-2.0.1.tgz",
      "integrity": "sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "color-name": "~1.1.4"
      },
      "engines": {
        "node": ">=7.0.0"
      }
    },
    "node_modules/color-name": {
      "version": "1.1.4",
      "resolved": "https://registry.npmjs.org/color-name/-/color-name-1.1.4.tgz",
      "integrity": "sha512-dOy+3AuW3a2wNbZHIuMZpTcgjGuLU/uBL/ubcZF9OXbDo8ff4O8yVp5Bf0efS8uEoYo5q4Fx7dY9OgQGXgAsQA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/commander": {
      "version": "2.20.3",
      "resolved": "https://registry.npmjs.org/commander/-/commander-2.20.3.tgz",
      "integrity": "sha512-GpVkmM8vF2vQUkj2LvZmD35JxeJOLCwJ9cUkugyk2nuhbv3+mJvpLYYt+0+USMxE+oj+ey/lJEnhZw75x/OMcQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/common-tags": {
      "version": "1.8.2",
      "resolved": "https://registry.npmjs.org/common-tags/-/common-tags-1.8.2.tgz",
      "integrity": "sha512-gk/Z852D2Wtb//0I+kRFNKKE9dIIVirjoqPoA1wJU+XePVXZfGeBpk45+A1rKO4Q43prqWBNY/MiIeRLbPWUaA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=4.0.0"
      }
    },
    "node_modules/concat-map": {
      "version": "0.0.1",
      "resolved": "https://registry.npmjs.org/concat-map/-/concat-map-0.0.1.tgz",
      "integrity": "sha512-/Srv4dswyQNBfohGpz9o6Yb3Gz3SrUDqBH5rTuhGR7ahtlbYKnVxw2bCFMRljaA7EXHaXZ8wsHdodFvbkhKmqg==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/convert-source-map": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/convert-source-map/-/convert-source-map-2.0.0.tgz",
      "integrity": "sha512-Kvp459HrV2FEJ1CAsi1Ku+MY3kasH19TFykTz2xWmMeq6bk2NU3XXvfJ+Q61m0xktWwt+1HSYf3JZsTms3aRJg==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/core-js-compat": {
      "version": "3.49.0",
      "resolved": "https://registry.npmjs.org/core-js-compat/-/core-js-compat-3.49.0.tgz",
      "integrity": "sha512-VQXt1jr9cBz03b331DFDCCP90b3fanciLkgiOoy8SBHy06gNf+vQ1A3WFLqG7I8TipYIKeYK9wxd0tUrvHcOZA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "browserslist": "^4.28.1"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/core-js"
      }
    },
    "node_modules/cross-spawn": {
      "version": "7.0.6",
      "resolved": "https://registry.npmjs.org/cross-spawn/-/cross-spawn-7.0.6.tgz",
      "integrity": "sha512-uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "path-key": "^3.1.0",
        "shebang-command": "^2.0.0",
        "which": "^2.0.1"
      },
      "engines": {
        "node": ">= 8"
      }
    },
    "node_modules/crypto-random-string": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/crypto-random-string/-/crypto-random-string-2.0.0.tgz",
      "integrity": "sha512-v1plID3y9r/lPhviJ1wrXpLeyUIGAZ2SHNYTEapm7/8A9nLPoyvVp3RK/EPFqn5kEznyWgYZNsRtYYIWbuG8KA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/csstype": {
      "version": "3.2.3",
      "resolved": "https://registry.npmjs.org/csstype/-/csstype-3.2.3.tgz",
      "integrity": "sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==",
      "devOptional": true,
      "license": "MIT"
    },
    "node_modules/d3-array": {
      "version": "3.2.4",
      "resolved": "https://registry.npmjs.org/d3-array/-/d3-array-3.2.4.tgz",
      "integrity": "sha512-tdQAmyA18i4J7wprpYq8ClcxZy3SC31QMeByyCFyRt7BVHdREQZ5lpzoe5mFEYZUWe+oq8HBvk9JjpibyEV4Jg==",
      "license": "ISC",
      "dependencies": {
        "internmap": "1 - 2"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-color": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/d3-color/-/d3-color-3.1.0.tgz",
      "integrity": "sha512-zg/chbXyeBtMQ1LbD/WSoW2DpC3I0mpmPdW+ynRTj/x2DAWYrIY7qeZIHidozwV24m4iavr15lNwIwLxRmOxhA==",
      "license": "ISC",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-ease": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/d3-ease/-/d3-ease-3.0.1.tgz",
      "integrity": "sha512-wR/XK3D3XcLIZwpbvQwQ5fK+8Ykds1ip7A2Txe0yxncXSdq1L9skcG7blcedkOX+ZcgxGAmLX1FrRGbADwzi0w==",
      "license": "BSD-3-Clause",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-format": {
      "version": "3.1.2",
      "resolved": "https://registry.npmjs.org/d3-format/-/d3-format-3.1.2.tgz",
      "integrity": "sha512-AJDdYOdnyRDV5b6ArilzCPPwc1ejkHcoyFarqlPqT7zRYjhavcT3uSrqcMvsgh2CgoPbK3RCwyHaVyxYcP2Arg==",
      "license": "ISC",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-interpolate": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/d3-interpolate/-/d3-interpolate-3.0.1.tgz",
      "integrity": "sha512-3bYs1rOD33uo8aqJfKP3JWPAibgw8Zm2+L9vBKEHJ2Rg+viTR7o5Mmv5mZcieN+FRYaAOWX5SJATX6k1PWz72g==",
      "license": "ISC",
      "dependencies": {
        "d3-color": "1 - 3"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-path": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/d3-path/-/d3-path-3.1.0.tgz",
      "integrity": "sha512-p3KP5HCf/bvjBSSKuXid6Zqijx7wIfNW+J/maPs+iwR35at5JCbLUT0LzF1cnjbCHWhqzQTIN2Jpe8pRebIEFQ==",
      "license": "ISC",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-scale": {
      "version": "4.0.2",
      "resolved": "https://registry.npmjs.org/d3-scale/-/d3-scale-4.0.2.tgz",
      "integrity": "sha512-GZW464g1SH7ag3Y7hXjf8RoUuAFIqklOAq3MRl4OaWabTFJY9PN/E1YklhXLh+OQ3fM9yS2nOkCoS+WLZ6kvxQ==",
      "license": "ISC",
      "dependencies": {
        "d3-array": "2.10.0 - 3",
        "d3-format": "1 - 3",
        "d3-interpolate": "1.2.0 - 3",
        "d3-time": "2.1.1 - 3",
        "d3-time-format": "2 - 4"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-shape": {
      "version": "3.2.0",
      "resolved": "https://registry.npmjs.org/d3-shape/-/d3-shape-3.2.0.tgz",
      "integrity": "sha512-SaLBuwGm3MOViRq2ABk3eLoxwZELpH6zhl3FbAoJ7Vm1gofKx6El1Ib5z23NUEhF9AsGl7y+dzLe5Cw2AArGTA==",
      "license": "ISC",
      "dependencies": {
        "d3-path": "^3.1.0"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-time": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/d3-time/-/d3-time-3.1.0.tgz",
      "integrity": "sha512-VqKjzBLejbSMT4IgbmVgDjpkYrNWUYJnbCGo874u7MMKIWsILRX+OpX/gTk8MqjpT1A/c6HY2dCA77ZN0lkQ2Q==",
      "license": "ISC",
      "dependencies": {
        "d3-array": "2 - 3"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-time-format": {
      "version": "4.1.0",
      "resolved": "https://registry.npmjs.org/d3-time-format/-/d3-time-format-4.1.0.tgz",
      "integrity": "sha512-dJxPBlzC7NugB2PDLwo9Q8JiTR3M3e4/XANkreKSUxF8vvXKqm1Yfq4Q5dl8budlunRVlUUaDUgFt7eA8D6NLg==",
      "license": "ISC",
      "dependencies": {
        "d3-time": "1 - 3"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/d3-timer": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/d3-timer/-/d3-timer-3.0.1.tgz",
      "integrity": "sha512-ndfJ/JxxMd3nw31uyKoY2naivF+r29V+Lc0svZxe1JvvIRmi8hUsrMvdOwgS1o6uBHmiz91geQ0ylPP0aj1VUA==",
      "license": "ISC",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/data-view-buffer": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/data-view-buffer/-/data-view-buffer-1.0.2.tgz",
      "integrity": "sha512-EmKO5V3OLXh1rtK2wgXRansaK1/mtVdTUEiEI0W8RkvgT05kfxaH29PliLnpLP73yYO6142Q72QNa8Wx/A5CqQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "es-errors": "^1.3.0",
        "is-data-view": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/data-view-byte-length": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/data-view-byte-length/-/data-view-byte-length-1.0.2.tgz",
      "integrity": "sha512-tuhGbE6CfTM9+5ANGf+oQb72Ky/0+s3xKUpHvShfiz2RxMFgFPjsXuRLBVMtvMs15awe45SRb83D6wH4ew6wlQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "es-errors": "^1.3.0",
        "is-data-view": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/inspect-js"
      }
    },
    "node_modules/data-view-byte-offset": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/data-view-byte-offset/-/data-view-byte-offset-1.0.1.tgz",
      "integrity": "sha512-BS8PfmtDGnrgYdOonGZQdLZslWIeCGFP9tpan0hi1Co2Zr2NKADsvGYA8XxuG/4UWgJ6Cjtv+YJnB6MM69QGlQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "es-errors": "^1.3.0",
        "is-data-view": "^1.0.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/debug": {
      "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",
      "integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "ms": "^2.1.3"
      },
      "engines": {
        "node": ">=6.0"
      },
      "peerDependenciesMeta": {
        "supports-color": {
          "optional": true
        }
      }
    },
    "node_modules/decimal.js-light": {
      "version": "2.5.1",
      "resolved": "https://registry.npmjs.org/decimal.js-light/-/decimal.js-light-2.5.1.tgz",
      "integrity": "sha512-qIMFpTMZmny+MMIitAB6D7iVPEorVw6YQRWkvarTkT4tBeSLLiHzcwj6q0MmYSFCiVpiqPJTJEYIrpcPzVEIvg==",
      "license": "MIT"
    },
    "node_modules/deep-is": {
      "version": "0.1.4",
      "resolved": "https://registry.npmjs.org/deep-is/-/deep-is-0.1.4.tgz",
      "integrity": "sha512-oIPzksmTg4/MriiaYGO+okXDT7ztn/w3Eptv/+gSIdMdKsJo0u4CfYNFJPy+4SKMuCqGw2wxnA+URMg3t8a/bQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/deepmerge": {
      "version": "4.3.1",
      "resolved": "https://registry.npmjs.org/deepmerge/-/deepmerge-4.3.1.tgz",
      "integrity": "sha512-3sUqbMEc77XqpdNO7FRyRog+eW3ph+GYCbj+rK+uYyRMuwsVy0rMiVtPn+QJlKFvWP/1PYpapqYn0Me2knFn+A==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/define-data-property": {
      "version": "1.1.4",
      "resolved": "https://registry.npmjs.org/define-data-property/-/define-data-property-1.1.4.tgz",
      "integrity": "sha512-rBMvIzlpA8v6E+SJZoo++HAYqsLrkg7MSfIinMPFhmkorw7X+dOXVJQs+QT69zGkzMyfDnIMN2Wid1+NbL3T+A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-define-property": "^1.0.0",
        "es-errors": "^1.3.0",
        "gopd": "^1.0.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/define-properties": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/define-properties/-/define-properties-1.2.1.tgz",
      "integrity": "sha512-8QmQKqEASLd5nx0U1B1okLElbUuuttJ/AnYmRXbbbGDWh6uS208EjD4Xqq/I9wK7u0v6O08XhTWnt5XtEbR6Dg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "define-data-property": "^1.0.1",
        "has-property-descriptors": "^1.0.0",
        "object-keys": "^1.1.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/detect-libc": {
      "version": "2.1.2",
      "resolved": "https://registry.npmjs.org/detect-libc/-/detect-libc-2.1.2.tgz",
      "integrity": "sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/dunder-proto": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/dunder-proto/-/dunder-proto-1.0.1.tgz",
      "integrity": "sha512-KIN/nDJBQRcXw0MLVhZE9iQHmG68qAVIBg9CqmUYjmQIhgij9U5MFvrqkUL5FbtyyzZuOeOt0zdeRe4UY7ct+A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind-apply-helpers": "^1.0.1",
        "es-errors": "^1.3.0",
        "gopd": "^1.2.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/ejs": {
      "version": "3.1.10",
      "resolved": "https://registry.npmjs.org/ejs/-/ejs-3.1.10.tgz",
      "integrity": "sha512-UeJmFfOrAQS8OJWPZ4qtgHyWExa088/MtK5UEyoJGFH67cDEXkZSviOiKRCZ4Xij0zxI3JECgYs3oKx+AizQBA==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "jake": "^10.8.5"
      },
      "bin": {
        "ejs": "bin/cli.js"
      },
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/electron-to-chromium": {
      "version": "1.5.443",
      "resolved": "https://registry.npmjs.org/electron-to-chromium/-/electron-to-chromium-1.5.443.tgz",
      "integrity": "sha512-TDJG36L9A3CWWwZ97HKaE+Iz1sW80pNp6sAU0owzCIV3Zc9eVyRqZK8Vz6NKuMIU8WjP0pIkoqCa0VRf/yFD0Q==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/embedded-postgres": {
      "version": "18.4.0-beta.17",
      "resolved": "https://registry.npmjs.org/embedded-postgres/-/embedded-postgres-18.4.0-beta.17.tgz",
      "integrity": "sha512-ORT/A1YiO6ecpRHpyIIBgyCR/8ASqqYZuFw11aX9PkqTX3FUM5+9sNOXY1mGIixxsm2TWSIA5WghJEk7A5ZxVw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "async-exit-hook": "^2.0.1",
        "pg": "^8.7.3"
      },
      "engines": {
        "node": ">=16"
      },
      "optionalDependencies": {
        "@embedded-postgres/darwin-arm64": "^18.4.0-beta.17",
        "@embedded-postgres/darwin-x64": "^18.4.0-beta.17",
        "@embedded-postgres/linux-arm": "^18.4.0-beta.17",
        "@embedded-postgres/linux-arm64": "^18.4.0-beta.17",
        "@embedded-postgres/linux-ia32": "^18.4.0-beta.17",
        "@embedded-postgres/linux-ppc64": "^18.4.0-beta.17",
        "@embedded-postgres/linux-x64": "^18.4.0-beta.17",
        "@embedded-postgres/windows-x64": "^18.4.0-beta.17"
      }
    },
    "node_modules/enhanced-resolve": {
      "version": "5.21.6",
      "resolved": "https://registry.npmjs.org/enhanced-resolve/-/enhanced-resolve-5.21.6.tgz",
      "integrity": "sha512-aNnGCvbJ/RIyWo1IuhNdVjnNF+EjH9wpzpNHt+ci/m9He9LJvUN8wrCcXjp9cWsGNAuvSpVFTx/vraAFQ8qGjQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "graceful-fs": "^4.2.4",
        "tapable": "^2.3.3"
      },
      "engines": {
        "node": ">=10.13.0"
      }
    },
    "node_modules/es-abstract": {
      "version": "1.24.2",
      "resolved": "https://registry.npmjs.org/es-abstract/-/es-abstract-1.24.2.tgz",
      "integrity": "sha512-2FpH9Q5i2RRwyEP1AylXe6nYLR5OhaJTZwmlcP0dL/+JCbgg7yyEo/sEK6HeGZRf3dFpWwThaRHVApXSkW3xeg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "array-buffer-byte-length": "^1.0.2",
        "arraybuffer.prototype.slice": "^1.0.4",
        "available-typed-arrays": "^1.0.7",
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.4",
        "data-view-buffer": "^1.0.2",
        "data-view-byte-length": "^1.0.2",
        "data-view-byte-offset": "^1.0.1",
        "es-define-property": "^1.0.1",
        "es-errors": "^1.3.0",
        "es-object-atoms": "^1.1.1",
        "es-set-tostringtag": "^2.1.0",
        "es-to-primitive": "^1.3.0",
        "function.prototype.name": "^1.1.8",
        "get-intrinsic": "^1.3.0",
        "get-proto": "^1.0.1",
        "get-symbol-description": "^1.1.0",
        "globalthis": "^1.0.4",
        "gopd": "^1.2.0",
        "has-property-descriptors": "^1.0.2",
        "has-proto": "^1.2.0",
        "has-symbols": "^1.1.0",
        "hasown": "^2.0.2",
        "internal-slot": "^1.1.0",
        "is-array-buffer": "^3.0.5",
        "is-callable": "^1.2.7",
        "is-data-view": "^1.0.2",
        "is-negative-zero": "^2.0.3",
        "is-regex": "^1.2.1",
        "is-set": "^2.0.3",
        "is-shared-array-buffer": "^1.0.4",
        "is-string": "^1.1.1",
        "is-typed-array": "^1.1.15",
        "is-weakref": "^1.1.1",
        "math-intrinsics": "^1.1.0",
        "object-inspect": "^1.13.4",
        "object-keys": "^1.1.1",
        "object.assign": "^4.1.7",
        "own-keys": "^1.0.1",
        "regexp.prototype.flags": "^1.5.4",
        "safe-array-concat": "^1.1.3",
        "safe-push-apply": "^1.0.0",
        "safe-regex-test": "^1.1.0",
        "set-proto": "^1.0.0",
        "stop-iteration-iterator": "^1.1.0",
        "string.prototype.trim": "^1.2.10",
        "string.prototype.trimend": "^1.0.9",
        "string.prototype.trimstart": "^1.0.8",
        "typed-array-buffer": "^1.0.3",
        "typed-array-byte-length": "^1.0.3",
        "typed-array-byte-offset": "^1.0.4",
        "typed-array-length": "^1.0.7",
        "unbox-primitive": "^1.1.0",
        "which-typed-array": "^1.1.19"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/es-define-property": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz",
      "integrity": "sha512-e3nRfgfUZ4rNGL232gUgX06QNyyez04KdjFrF+LTRoOXmrOgFKDg4BCdsjW8EnT69eqdYGmRpJwiPVYNrCaW3g==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/es-errors": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/es-errors/-/es-errors-1.3.0.tgz",
      "integrity": "sha512-Zf5H2Kxt2xjTvbJvP2ZWLEICxA6j+hAmMzIlypy4xcBg1vKVnx89Wy0GbS+kf5cwCVFFzdCFh2XSCFNULS6csw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/es-object-atoms": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/es-object-atoms/-/es-object-atoms-1.1.1.tgz",
      "integrity": "sha512-FGgH2h8zKNim9ljj7dankFPcICIK9Cp5bm+c2gQSYePhpaG5+esrLODihIorn+Pe6FGJzWhXQotPv73jTaldXA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/es-set-tostringtag": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/es-set-tostringtag/-/es-set-tostringtag-2.1.0.tgz",
      "integrity": "sha512-j6vWzfrGVfyXxge+O0x5sh6cvxAog0a/4Rdd2K36zCMV5eJ+/+tOAngRO8cODMNWbVRdVlmGZQL2YS3yR8bIUA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.6",
        "has-tostringtag": "^1.0.2",
        "hasown": "^2.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/es-to-primitive": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/es-to-primitive/-/es-to-primitive-1.3.0.tgz",
      "integrity": "sha512-w+5mJ3GuFL+NjVtJlvydShqE1eN3h3PbI7/5LAsYJP/2qtuMXjfL2LpHSRqo4b4eSF5K/DH1JXKUAHSB2UW50g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "is-callable": "^1.2.7",
        "is-date-object": "^1.0.5",
        "is-symbol": "^1.0.4"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/es-toolkit": {
      "version": "1.49.0",
      "resolved": "https://registry.npmjs.org/es-toolkit/-/es-toolkit-1.49.0.tgz",
      "integrity": "sha512-G5iZ6Pc/FNRY/soKZHC+TxGDD83rHUDXxzaWhGCX44vAv/tMs56WMusnm/KMNK+luUPsgA9U28cGr4RDlSzL2g==",
      "license": "MIT",
      "workspaces": [
        "docs",
        "benchmarks"
      ]
    },
    "node_modules/escalade": {
      "version": "3.2.0",
      "resolved": "https://registry.npmjs.org/escalade/-/escalade-3.2.0.tgz",
      "integrity": "sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/escape-string-regexp": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-4.0.0.tgz",
      "integrity": "sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/eslint": {
      "version": "9.39.4",
      "resolved": "https://registry.npmjs.org/eslint/-/eslint-9.39.4.tgz",
      "integrity": "sha512-XoMjdBOwe/esVgEvLmNsD3IRHkm7fbKIUGvrleloJXUZgDHig2IPWNniv+GwjyJXzuNqVjlr5+4yVUZjycJwfQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@eslint-community/eslint-utils": "^4.8.0",
        "@eslint-community/regexpp": "^4.12.1",
        "@eslint/config-array": "^0.21.2",
        "@eslint/config-helpers": "^0.4.2",
        "@eslint/core": "^0.17.0",
        "@eslint/eslintrc": "^3.3.5",
        "@eslint/js": "9.39.4",
        "@eslint/plugin-kit": "^0.4.1",
        "@humanfs/node": "^0.16.6",
        "@humanwhocodes/module-importer": "^1.0.1",
        "@humanwhocodes/retry": "^0.4.2",
        "@types/estree": "^1.0.6",
        "ajv": "^6.14.0",
        "chalk": "^4.0.0",
        "cross-spawn": "^7.0.6",
        "debug": "^4.3.2",
        "escape-string-regexp": "^4.0.0",
        "eslint-scope": "^8.4.0",
        "eslint-visitor-keys": "^4.2.1",
        "espree": "^10.4.0",
        "esquery": "^1.5.0",
        "esutils": "^2.0.2",
        "fast-deep-equal": "^3.1.3",
        "file-entry-cache": "^8.0.0",
        "find-up": "^5.0.0",
        "glob-parent": "^6.0.2",
        "ignore": "^5.2.0",
        "imurmurhash": "^0.1.4",
        "is-glob": "^4.0.0",
        "json-stable-stringify-without-jsonify": "^1.0.1",
        "lodash.merge": "^4.6.2",
        "minimatch": "^3.1.5",
        "natural-compare": "^1.4.0",
        "optionator": "^0.9.3"
      },
      "bin": {
        "eslint": "bin/eslint.js"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://eslint.org/donate"
      },
      "peerDependencies": {
        "jiti": "*"
      },
      "peerDependenciesMeta": {
        "jiti": {
          "optional": true
        }
      }
    },
    "node_modules/eslint-plugin-react-hooks": {
      "version": "7.1.1",
      "resolved": "https://registry.npmjs.org/eslint-plugin-react-hooks/-/eslint-plugin-react-hooks-7.1.1.tgz",
      "integrity": "sha512-f2I7Gw6JbvCexzIInuSbZpfdQ44D7iqdWX01FKLvrPgqxoE7oMj8clOfto8U6vYiz4yd5oKu39rRSVOe1zRu0g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@babel/core": "^7.24.4",
        "@babel/parser": "^7.24.4",
        "hermes-parser": "^0.25.1",
        "zod": "^3.25.0 || ^4.0.0",
        "zod-validation-error": "^3.5.0 || ^4.0.0"
      },
      "engines": {
        "node": ">=18"
      },
      "peerDependencies": {
        "eslint": "^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0-0 || ^9.0.0 || ^10.0.0"
      }
    },
    "node_modules/eslint-plugin-react-refresh": {
      "version": "0.4.26",
      "resolved": "https://registry.npmjs.org/eslint-plugin-react-refresh/-/eslint-plugin-react-refresh-0.4.26.tgz",
      "integrity": "sha512-1RETEylht2O6FM/MvgnyvT+8K21wLqDNg4qD51Zj3guhjt433XbnnkVttHMyaVyAFD03QSV4LPS5iE3VQmO7XQ==",
      "dev": true,
      "license": "MIT",
      "peerDependencies": {
        "eslint": ">=8.40"
      }
    },
    "node_modules/eslint-scope": {
      "version": "8.4.0",
      "resolved": "https://registry.npmjs.org/eslint-scope/-/eslint-scope-8.4.0.tgz",
      "integrity": "sha512-sNXOfKCn74rt8RICKMvJS7XKV/Xk9kA7DyJr8mJik3S7Cwgy3qlkkmyS2uQB3jiJg6VNdZd/pDBJu0nvG2NlTg==",
      "dev": true,
      "license": "BSD-2-Clause",
      "dependencies": {
        "esrecurse": "^4.3.0",
        "estraverse": "^5.2.0"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/eslint-visitor-keys": {
      "version": "4.2.1",
      "resolved": "https://registry.npmjs.org/eslint-visitor-keys/-/eslint-visitor-keys-4.2.1.tgz",
      "integrity": "sha512-Uhdk5sfqcee/9H/rCOJikYz67o0a2Tw2hGRPOG2Y1R2dg7brRe1uG0yaNQDHu+TO/uQPF/5eCapvYSmHUjt7JQ==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/espree": {
      "version": "10.4.0",
      "resolved": "https://registry.npmjs.org/espree/-/espree-10.4.0.tgz",
      "integrity": "sha512-j6PAQ2uUr79PZhBjP5C5fhl8e39FmRnOjsD5lGnWrFU8i2G776tBK7+nP8KuQUTTyAZUwfQqXAgrVH5MbH9CYQ==",
      "dev": true,
      "license": "BSD-2-Clause",
      "dependencies": {
        "acorn": "^8.15.0",
        "acorn-jsx": "^5.3.2",
        "eslint-visitor-keys": "^4.2.1"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/esquery": {
      "version": "1.7.0",
      "resolved": "https://registry.npmjs.org/esquery/-/esquery-1.7.0.tgz",
      "integrity": "sha512-Ap6G0WQwcU/LHsvLwON1fAQX9Zp0A2Y6Y/cJBl9r/JbW90Zyg4/zbG6zzKa2OTALELarYHmKu0GhpM5EO+7T0g==",
      "dev": true,
      "license": "BSD-3-Clause",
      "dependencies": {
        "estraverse": "^5.1.0"
      },
      "engines": {
        "node": ">=0.10"
      }
    },
    "node_modules/esrecurse": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/esrecurse/-/esrecurse-4.3.0.tgz",
      "integrity": "sha512-KmfKL3b6G+RXvP8N1vr3Tq1kL/oCFgn2NYXEtqP8/L3pKapUA4G8cFVaoF3SU323CD4XypR/ffioHmkti6/Tag==",
      "dev": true,
      "license": "BSD-2-Clause",
      "dependencies": {
        "estraverse": "^5.2.0"
      },
      "engines": {
        "node": ">=4.0"
      }
    },
    "node_modules/estraverse": {
      "version": "5.3.0",
      "resolved": "https://registry.npmjs.org/estraverse/-/estraverse-5.3.0.tgz",
      "integrity": "sha512-MMdARuVEQziNTeJD8DgMqmhwR11BRQ/cBP+pLtYdSTnf3MIO8fFeiINEbX36ZdNlfU/7A9f3gUw49B3oQsvwBA==",
      "dev": true,
      "license": "BSD-2-Clause",
      "engines": {
        "node": ">=4.0"
      }
    },
    "node_modules/esutils": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/esutils/-/esutils-2.0.3.tgz",
      "integrity": "sha512-kVscqXk4OCp68SZ0dkgEKVi6/8ij300KBWTJq32P/dYeWTSwK41WyTxalN1eRmA5Z9UU/LX9D7FWSmV9SAYx6g==",
      "dev": true,
      "license": "BSD-2-Clause",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/eta": {
      "version": "4.6.0",
      "resolved": "https://registry.npmjs.org/eta/-/eta-4.6.0.tgz",
      "integrity": "sha512-lW6is4T1NFOYnmqGZIfvixqj7A7sSvScF+DN8EK6K58xI5MZ5UvYe0GjopxOXQtZvUn4eDdVuZ8XSoYWTMEKwA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=20"
      },
      "funding": {
        "url": "https://github.com/bgub/eta?sponsor=1"
      }
    },
    "node_modules/eventemitter3": {
      "version": "5.0.4",
      "resolved": "https://registry.npmjs.org/eventemitter3/-/eventemitter3-5.0.4.tgz",
      "integrity": "sha512-mlsTRyGaPBjPedk6Bvw+aqbsXDtoAyAzm5MO7JgU+yVRyMQ5O8bD4Kcci7BS85f93veegeCPkL8R4GLClnjLFw==",
      "license": "MIT"
    },
    "node_modules/fake-indexeddb": {
      "version": "6.2.5",
      "resolved": "https://registry.npmjs.org/fake-indexeddb/-/fake-indexeddb-6.2.5.tgz",
      "integrity": "sha512-CGnyrvbhPlWYMngksqrSSUT1BAVP49dZocrHuK0SvtR0D5TMs5wP0o3j7jexDJW01KSadjBp1M/71o/KR3nD1w==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/fast-deep-equal": {
      "version": "3.1.3",
      "resolved": "https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz",
      "integrity": "sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/fast-json-stable-stringify": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/fast-json-stable-stringify/-/fast-json-stable-stringify-2.1.0.tgz",
      "integrity": "sha512-lhd/wF+Lk98HZoTCtlVraHtfh5XYijIjalXck7saUtuanSDyLMxnHhSXEDJqHxD7msR8D0uCmqlkwjCV8xvwHw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/fast-levenshtein": {
      "version": "2.0.6",
      "resolved": "https://registry.npmjs.org/fast-levenshtein/-/fast-levenshtein-2.0.6.tgz",
      "integrity": "sha512-DCXu6Ifhqcks7TZKY3Hxp3y6qphY5SJZmrWMDrKcERSOXWQdMhU9Ig/PYrzyw/ul9jOIyh0N4M0tbC5hodg8dw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/fast-uri": {
      "version": "3.1.8",
      "resolved": "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz",
      "integrity": "sha512-GZMtZUTNRpOVIECoXwLNZS5xUGE+mVNbTB8h/7Rwh2TFWcBQiPzTgyZi05BF9UMZKkLJv8XBRJTlU7zg8+ZfMg==",
      "dev": true,
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "BSD-3-Clause"
    },
    "node_modules/file-entry-cache": {
      "version": "8.0.0",
      "resolved": "https://registry.npmjs.org/file-entry-cache/-/file-entry-cache-8.0.0.tgz",
      "integrity": "sha512-XXTUwCvisa5oacNGRP9SfNtYBNAMi+RPwBFmblZEF7N7swHYQS6/Zfk7SRwx4D5j3CH211YNRco1DEMNVfZCnQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "flat-cache": "^4.0.0"
      },
      "engines": {
        "node": ">=16.0.0"
      }
    },
    "node_modules/filelist": {
      "version": "1.0.6",
      "resolved": "https://registry.npmjs.org/filelist/-/filelist-1.0.6.tgz",
      "integrity": "sha512-5giy2PkLYY1cP39p17Ech+2xlpTRL9HLspOfEgm0L6CwBXBTgsK5ou0JtzYuepxkaQ/tvhCFIJ5uXo0OrM2DxA==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "minimatch": "^5.0.1"
      }
    },
    "node_modules/filelist/node_modules/brace-expansion": {
      "version": "2.1.7",
      "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-2.1.7.tgz",
      "integrity": "sha512-uZbew1NqdmPDTMJ8ah1y+b+9QEJrfkXFk3RcTQw3X0jW/xRUvFKsg1CfQdSYGdTbXZWExtU3J3ccxtnfw1Fi0g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "balanced-match": "^1.0.0"
      }
    },
    "node_modules/filelist/node_modules/minimatch": {
      "version": "5.1.9",
      "resolved": "https://registry.npmjs.org/minimatch/-/minimatch-5.1.9.tgz",
      "integrity": "sha512-7o1wEA2RyMP7Iu7GNba9vc0RWWGACJOCZBJX2GJWip0ikV+wcOsgVuY9uE8CPiyQhkGFSlhuSkZPavN7u1c2Fw==",
      "dev": true,
      "license": "ISC",
      "dependencies": {
        "brace-expansion": "^2.0.1"
      },
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/find-up": {
      "version": "5.0.0",
      "resolved": "https://registry.npmjs.org/find-up/-/find-up-5.0.0.tgz",
      "integrity": "sha512-78/PXT1wlLLDgTzDs7sjq9hzz0vXD+zn+7wypEe4fXQxCmdmqfGsEPQxmiCSQI3ajFV91bVSsvNtrJRiW6nGng==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "locate-path": "^6.0.0",
        "path-exists": "^4.0.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/flat-cache": {
      "version": "4.0.1",
      "resolved": "https://registry.npmjs.org/flat-cache/-/flat-cache-4.0.1.tgz",
      "integrity": "sha512-f7ccFPK3SXFHpx15UIGyRJ/FJQctuKZ0zVuN3frBo4HnK3cay9VEW0R6yPYFHC0AgqhukPzKjq22t5DmAyqGyw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "flatted": "^3.2.9",
        "keyv": "^4.5.4"
      },
      "engines": {
        "node": ">=16"
      }
    },
    "node_modules/flatted": {
      "version": "3.4.2",
      "resolved": "https://registry.npmjs.org/flatted/-/flatted-3.4.2.tgz",
      "integrity": "sha512-PjDse7RzhcPkIJwy5t7KPWQSZ9cAbzQXcafsetQoD7sOJRQlGikNbx7yZp2OotDnJyrDcbyRq3Ttb18iYOqkxA==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/for-each": {
      "version": "0.3.5",
      "resolved": "https://registry.npmjs.org/for-each/-/for-each-0.3.5.tgz",
      "integrity": "sha512-dKx12eRCVIzqCxFGplyFKJMPvLEWgmNtUrpTiJIR5u97zEhRG8ySrtboPHZXx7daLxQVrl643cTzbab2tkQjxg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "is-callable": "^1.2.7"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/foreground-child": {
      "version": "3.3.1",
      "resolved": "https://registry.npmjs.org/foreground-child/-/foreground-child-3.3.1.tgz",
      "integrity": "sha512-gIXjKqtFuWEgzFRJA9WCQeSJLZDjgJUOMCMzxtvFq/37KojM1BFGufqsCy0r4qSQmYLsZYMeyRqzIWOMup03sw==",
      "dev": true,
      "license": "ISC",
      "dependencies": {
        "cross-spawn": "^7.0.6",
        "signal-exit": "^4.0.1"
      },
      "engines": {
        "node": ">=14"
      },
      "funding": {
        "url": "https://github.com/sponsors/isaacs"
      }
    },
    "node_modules/fs-extra": {
      "version": "9.1.0",
      "resolved": "https://registry.npmjs.org/fs-extra/-/fs-extra-9.1.0.tgz",
      "integrity": "sha512-hcg3ZmepS30/7BSFqRvoo3DOMQu7IjqxO5nCDt+zM9XWjb33Wg7ziNT+Qvqbuc3+gWpzO02JubVyk2G4Zvo1OQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "at-least-node": "^1.0.0",
        "graceful-fs": "^4.2.0",
        "jsonfile": "^6.0.1",
        "universalify": "^2.0.0"
      },
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/fsevents": {
      "version": "2.3.3",
      "resolved": "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
      "integrity": "sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==",
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^8.16.0 || ^10.6.0 || >=11.0.0"
      }
    },
    "node_modules/function-bind": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/function-bind/-/function-bind-1.1.2.tgz",
      "integrity": "sha512-7XHNxH7qX9xG5mIwxkhumTox/MIRNcOgDrxWsMt2pAr23WHp6MrRlN7FBSFpCpr+oVO0F744iUgR82nJMfG2SA==",
      "dev": true,
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/function.prototype.name": {
      "version": "1.1.8",
      "resolved": "https://registry.npmjs.org/function.prototype.name/-/function.prototype.name-1.1.8.tgz",
      "integrity": "sha512-e5iwyodOHhbMr/yNrc7fDYG4qlbIvI5gajyzPnb5TCwyhjApznQh1BMFou9b30SevY43gCJKXycoCBjMbsuW0Q==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.3",
        "define-properties": "^1.2.1",
        "functions-have-names": "^1.2.3",
        "hasown": "^2.0.2",
        "is-callable": "^1.2.7"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/functions-have-names": {
      "version": "1.2.3",
      "resolved": "https://registry.npmjs.org/functions-have-names/-/functions-have-names-1.2.3.tgz",
      "integrity": "sha512-xckBUXyTIqT97tq2x2AMb+g163b5JFysYk0x4qxNFwbfQkmNZoiRHb6sPzI9/QV33WeuvVYBUIiD4NzNIyqaRQ==",
      "dev": true,
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/generator-function": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/generator-function/-/generator-function-2.0.1.tgz",
      "integrity": "sha512-SFdFmIJi+ybC0vjlHN0ZGVGHc3lgE0DxPAT0djjVg+kjOnSqclqmj0KQ7ykTOLP6YxoqOvuAODGdcHJn+43q3g==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/gensync": {
      "version": "1.0.0-beta.2",
      "resolved": "https://registry.npmjs.org/gensync/-/gensync-1.0.0-beta.2.tgz",
      "integrity": "sha512-3hN7NaskYvMDLQY55gnW3NQ+mesEAepTqlg+VEbj7zzqEMBVNhzcGYYeqFo/TlYz6eQiFcp1HcsCZO+nGgS8zg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.9.0"
      }
    },
    "node_modules/get-intrinsic": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/get-intrinsic/-/get-intrinsic-1.3.0.tgz",
      "integrity": "sha512-9fSjSaos/fRIVIp+xSJlE6lfwhES7LNtKaCBIamHsjr2na1BiABJPo0mOjjz8GJDURarmCPGqaiVg5mfjb98CQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind-apply-helpers": "^1.0.2",
        "es-define-property": "^1.0.1",
        "es-errors": "^1.3.0",
        "es-object-atoms": "^1.1.1",
        "function-bind": "^1.1.2",
        "get-proto": "^1.0.1",
        "gopd": "^1.2.0",
        "has-symbols": "^1.1.0",
        "hasown": "^2.0.2",
        "math-intrinsics": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/get-own-enumerable-property-symbols": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/get-own-enumerable-property-symbols/-/get-own-enumerable-property-symbols-3.0.2.tgz",
      "integrity": "sha512-I0UBV/XOz1XkIJHEUDMZAbzCThU/H8DxmSfmdGcKPnVhu2VfFqr34jr9777IyaTYvxjedWhqVIilEDsCdP5G6g==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/get-proto": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/get-proto/-/get-proto-1.0.1.tgz",
      "integrity": "sha512-sTSfBjoXBp89JvIKIefqw7U2CCebsc74kiY6awiGogKtoSGbgjYE/G/+l9sF3MWFPNc9IcoOC4ODfKHfxFmp0g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "dunder-proto": "^1.0.1",
        "es-object-atoms": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/get-symbol-description": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/get-symbol-description/-/get-symbol-description-1.1.0.tgz",
      "integrity": "sha512-w9UMqWwJxHNOvoNzSJ2oPF5wvYcvP7jUvYzhp67yEhTi17ZDBBC1z9pTdGuzjD+EFIqLSYRweZjqfiPzQ06Ebg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.6"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/glob": {
      "version": "11.1.0",
      "resolved": "https://registry.npmjs.org/glob/-/glob-11.1.0.tgz",
      "integrity": "sha512-vuNwKSaKiqm7g0THUBu2x7ckSs3XJLXE+2ssL7/MfTGPLLcrJQ/4Uq1CjPTtO5cCIiRxqvN6Twy1qOwhL0Xjcw==",
      "deprecated": "Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "dependencies": {
        "foreground-child": "^3.3.1",
        "jackspeak": "^4.1.1",
        "minimatch": "^10.1.1",
        "minipass": "^7.1.2",
        "package-json-from-dist": "^1.0.0",
        "path-scurry": "^2.0.0"
      },
      "bin": {
        "glob": "dist/esm/bin.mjs"
      },
      "engines": {
        "node": "20 || >=22"
      },
      "funding": {
        "url": "https://github.com/sponsors/isaacs"
      }
    },
    "node_modules/glob-parent": {
      "version": "6.0.2",
      "resolved": "https://registry.npmjs.org/glob-parent/-/glob-parent-6.0.2.tgz",
      "integrity": "sha512-XxwI8EOhVQgWp6iDL+3b0r86f4d6AX6zSU55HfB4ydCEuXLXc5FcYeOu+nnGftS4TEju/11rt4KJPTMgbfmv4A==",
      "dev": true,
      "license": "ISC",
      "dependencies": {
        "is-glob": "^4.0.3"
      },
      "engines": {
        "node": ">=10.13.0"
      }
    },
    "node_modules/glob/node_modules/balanced-match": {
      "version": "4.0.4",
      "resolved": "https://registry.npmjs.org/balanced-match/-/balanced-match-4.0.4.tgz",
      "integrity": "sha512-BLrgEcRTwX2o6gGxGOCNyMvGSp35YofuYzw9h1IMTRmKqttAZZVU67bdb9Pr2vUHA8+j3i2tJfjO6C6+4myGTA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "18 || 20 || >=22"
      }
    },
    "node_modules/glob/node_modules/brace-expansion": {
      "version": "5.0.12",
      "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
      "integrity": "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "balanced-match": "^4.0.2"
      },
      "engines": {
        "node": "20 || >=22"
      }
    },
    "node_modules/glob/node_modules/minimatch": {
      "version": "10.2.5",
      "resolved": "https://registry.npmjs.org/minimatch/-/minimatch-10.2.5.tgz",
      "integrity": "sha512-MULkVLfKGYDFYejP07QOurDLLQpcjk7Fw+7jXS2R2czRQzR56yHRveU5NDJEOviH+hETZKSkIk5c+T23GjFUMg==",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "dependencies": {
        "brace-expansion": "^5.0.5"
      },
      "engines": {
        "node": "18 || 20 || >=22"
      },
      "funding": {
        "url": "https://github.com/sponsors/isaacs"
      }
    },
    "node_modules/globals": {
      "version": "16.5.0",
      "resolved": "https://registry.npmjs.org/globals/-/globals-16.5.0.tgz",
      "integrity": "sha512-c/c15i26VrJ4IRt5Z89DnIzCGDn9EcebibhAOjw5ibqEHsE1wLUgkPn9RDmNcUKyU87GeaL633nyJ+pplFR2ZQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/globalthis": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/globalthis/-/globalthis-1.0.4.tgz",
      "integrity": "sha512-DpLKbNU4WylpxJykQujfCcwYWiV/Jhm50Goo0wrVILAv5jOr9d+H+UR3PhSCD2rCCEIg0uc+G+muBTwD54JhDQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "define-properties": "^1.2.1",
        "gopd": "^1.0.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/gopd": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/gopd/-/gopd-1.2.0.tgz",
      "integrity": "sha512-ZUKRh6/kUFoAiTAtTYPZJ3hw9wNxx+BIBOijnlG9PnrJsCcSjs1wyyD6vJpaYtgnzDrKYRSqf3OO6Rfa93xsRg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/graceful-fs": {
      "version": "4.2.11",
      "resolved": "https://registry.npmjs.org/graceful-fs/-/graceful-fs-4.2.11.tgz",
      "integrity": "sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/has-bigints": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/has-bigints/-/has-bigints-1.1.0.tgz",
      "integrity": "sha512-R3pbpkcIqv2Pm3dUwgjclDRVmWpTJW2DcMzcIhEXEx1oh/CEMObMm3KLmRJOdvhM7o4uQBnwr8pzRK2sJWIqfg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/has-flag": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/has-flag/-/has-flag-4.0.0.tgz",
      "integrity": "sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/has-property-descriptors": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/has-property-descriptors/-/has-property-descriptors-1.0.2.tgz",
      "integrity": "sha512-55JNKuIW+vq4Ke1BjOTjM2YctQIvCT7GFzHwmfZPGo5wnrgkid0YQtnAleFSqumZm4az3n2BS+erby5ipJdgrg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-define-property": "^1.0.0"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/has-proto": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/has-proto/-/has-proto-1.2.0.tgz",
      "integrity": "sha512-KIL7eQPfHQRC8+XluaIw7BHUwwqL19bQn4hzNgdr+1wXoU0KKj6rufu47lhY7KbJR2C6T6+PfyN0Ea7wkSS+qQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "dunder-proto": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/has-symbols": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/has-symbols/-/has-symbols-1.1.0.tgz",
      "integrity": "sha512-1cDNdwJ2Jaohmb3sg4OmKaMBwuC48sYni5HUw2DvsC8LjGTLK9h+eb1X6RyuOHe4hT0ULCW68iomhjUoKUqlPQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/has-tostringtag": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/has-tostringtag/-/has-tostringtag-1.0.2.tgz",
      "integrity": "sha512-NqADB8VjPFLM2V0VvHUewwwsw0ZWBaIdgo+ieHtK3hasLz4qeCRjYcqfB6AQrBggRKppKF8L52/VqdVsO47Dlw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "has-symbols": "^1.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/hasown": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/hasown/-/hasown-2.0.3.tgz",
      "integrity": "sha512-ej4AhfhfL2Q2zpMmLo7U1Uv9+PyhIZpgQLGT1F9miIGmiCJIoCgSmczFdrc97mWT4kVY72KA+WnnhJ5pghSvSg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "function-bind": "^1.1.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/hermes-estree": {
      "version": "0.25.1",
      "resolved": "https://registry.npmjs.org/hermes-estree/-/hermes-estree-0.25.1.tgz",
      "integrity": "sha512-0wUoCcLp+5Ev5pDW2OriHC2MJCbwLwuRx+gAqMTOkGKJJiBCLjtrvy4PWUGn6MIVefecRpzoOZ/UV6iGdOr+Cw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/hermes-parser": {
      "version": "0.25.1",
      "resolved": "https://registry.npmjs.org/hermes-parser/-/hermes-parser-0.25.1.tgz",
      "integrity": "sha512-6pEjquH3rqaI6cYAXYPcz9MS4rY6R4ngRgrgfDshRptUZIc3lw0MCIJIGDj9++mfySOuPTHB4nrSW99BCvOPIA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "hermes-estree": "0.25.1"
      }
    },
    "node_modules/iceberg-js": {
      "version": "0.8.1",
      "resolved": "https://registry.npmjs.org/iceberg-js/-/iceberg-js-0.8.1.tgz",
      "integrity": "sha512-1dhVQZXhcHje7798IVM+xoo/1ZdVfzOMIc8/rgVSijRK38EDqOJoGula9N/8ZI5RD8QTxNQtK/Gozpr+qUqRRA==",
      "license": "MIT",
      "engines": {
        "node": ">=20.0.0"
      }
    },
    "node_modules/idb": {
      "version": "8.0.3",
      "resolved": "https://registry.npmjs.org/idb/-/idb-8.0.3.tgz",
      "integrity": "sha512-LtwtVyVYO5BqRvcsKuB2iUMnHwPVByPCXFXOpuU96IZPPoPN6xjOGxZQ74pgSVVLQWtUOYgyeL4GE98BY5D3wg==",
      "license": "ISC"
    },
    "node_modules/ignore": {
      "version": "5.3.2",
      "resolved": "https://registry.npmjs.org/ignore/-/ignore-5.3.2.tgz",
      "integrity": "sha512-hsBTNUqQTDwkWtcdYI2i06Y/nUBEsNEDJKjWdigLvegy8kDuJAS8uRlpkkcQpyEXL0Z/pjDy5HBmMjRCJ2gq+g==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 4"
      }
    },
    "node_modules/immer": {
      "version": "11.1.11",
      "resolved": "https://registry.npmjs.org/immer/-/immer-11.1.11.tgz",
      "integrity": "sha512-qzXuyXAkPySAGYkfsAwodDPWT8Zm7/Uo5BNt4BjhMhG5WlWyZZ4wQqnWwdS8kjlQ1Cwu6gjw3A6+0gTQwlyYtw==",
      "license": "MIT",
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/immer"
      }
    },
    "node_modules/import-fresh": {
      "version": "3.3.1",
      "resolved": "https://registry.npmjs.org/import-fresh/-/import-fresh-3.3.1.tgz",
      "integrity": "sha512-TR3KfrTZTYLPB6jUjfx6MF9WcWrHL9su5TObK4ZkYgBdWKPOFoSoQIdEuTuR82pmtxH2spWG9h6etwfr1pLBqQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "parent-module": "^1.0.0",
        "resolve-from": "^4.0.0"
      },
      "engines": {
        "node": ">=6"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/imurmurhash": {
      "version": "0.1.4",
      "resolved": "https://registry.npmjs.org/imurmurhash/-/imurmurhash-0.1.4.tgz",
      "integrity": "sha512-JmXMZ6wuvDmLiHEml9ykzqO6lwFbof0GG4IkcGaENdCRDDmMVnny7s5HsIgHCbaq0w2MyPhDqkhTUgS2LU2PHA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.8.19"
      }
    },
    "node_modules/internal-slot": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/internal-slot/-/internal-slot-1.1.0.tgz",
      "integrity": "sha512-4gd7VpWNQNB4UKKCFFVcp1AVv+FMOgs9NKzjHKusc8jTMhd5eL1NqQqOpE0KzMds804/yHlglp3uxgluOqAPLw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "hasown": "^2.0.2",
        "side-channel": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/internmap": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/internmap/-/internmap-2.0.3.tgz",
      "integrity": "sha512-5Hh7Y1wQbvY5ooGgPbDaL5iYLAPzMTUrjMulskHLH6wnv/A+1q5rgEaiuqEjB+oxGXIVZs1FF+R/KPN3ZSQYYg==",
      "license": "ISC",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/is-array-buffer": {
      "version": "3.0.5",
      "resolved": "https://registry.npmjs.org/is-array-buffer/-/is-array-buffer-3.0.5.tgz",
      "integrity": "sha512-DDfANUiiG2wC1qawP66qlTugJeL5HyzMpfr8lLK+jMQirGzNod0B12cFB/9q838Ru27sBwfw78/rdoU7RERz6A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.3",
        "get-intrinsic": "^1.2.6"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-async-function": {
      "version": "2.1.1",
      "resolved": "https://registry.npmjs.org/is-async-function/-/is-async-function-2.1.1.tgz",
      "integrity": "sha512-9dgM/cZBnNvjzaMYHVoxxfPj2QXt22Ev7SuuPrs+xav0ukGB0S6d4ydZdEiM48kLx5kDV+QBPrpVnFyefL8kkQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "async-function": "^1.0.0",
        "call-bound": "^1.0.3",
        "get-proto": "^1.0.1",
        "has-tostringtag": "^1.0.2",
        "safe-regex-test": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-bigint": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/is-bigint/-/is-bigint-1.1.0.tgz",
      "integrity": "sha512-n4ZT37wG78iz03xPRKJrHTdZbe3IicyucEtdRsV5yglwc3GyUfbAfpSeD0FJ41NbUNSt5wbhqfp1fS+BgnvDFQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "has-bigints": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-boolean-object": {
      "version": "1.2.2",
      "resolved": "https://registry.npmjs.org/is-boolean-object/-/is-boolean-object-1.2.2.tgz",
      "integrity": "sha512-wa56o2/ElJMYqjCjGkXri7it5FbebW5usLw/nPmCMs5DeZ7eziSYZhSmPRn0txqeW4LnAmQQU7FgqLpsEFKM4A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "has-tostringtag": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-callable": {
      "version": "1.2.7",
      "resolved": "https://registry.npmjs.org/is-callable/-/is-callable-1.2.7.tgz",
      "integrity": "sha512-1BC0BVFhS/p0qtw6enp8e+8OD0UrK0oFLztSjNzhcKA3WDuJxxAPXzPuPtKkjEY9UUoEWlX/8fgKeu2S8i9JTA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-core-module": {
      "version": "2.16.2",
      "resolved": "https://registry.npmjs.org/is-core-module/-/is-core-module-2.16.2.tgz",
      "integrity": "sha512-evOr8xfXKxE6qSR0hSXL2r3sd7ALj8+7jQEUvPYcm5sgZFdJ+AYzT6yNmJenvIYQBgIGwfwz08sL8zoL7yq2BA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "hasown": "^2.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-data-view": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/is-data-view/-/is-data-view-1.0.2.tgz",
      "integrity": "sha512-RKtWF8pGmS87i2D6gqQu/l7EYRlVdfzemCJN/P3UOs//x1QE7mfhvzHIApBTRf7axvT6DMGwSwBXYCT0nfB9xw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "get-intrinsic": "^1.2.6",
        "is-typed-array": "^1.1.13"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-date-object": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/is-date-object/-/is-date-object-1.1.0.tgz",
      "integrity": "sha512-PwwhEakHVKTdRNVOw+/Gyh0+MzlCl4R6qKvkhuvLtPMggI1WAHt9sOwZxQLSGpUaDnrdyDsomoRgNnCfKNSXXg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "has-tostringtag": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-extglob": {
      "version": "2.1.1",
      "resolved": "https://registry.npmjs.org/is-extglob/-/is-extglob-2.1.1.tgz",
      "integrity": "sha512-SbKbANkN603Vi4jEZv49LeVJMn4yGwsbzZworEoyEiutsN3nJYdbO36zfhGJ6QEDpOZIFkDtnq5JRxmvl3jsoQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/is-finalizationregistry": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/is-finalizationregistry/-/is-finalizationregistry-1.1.1.tgz",
      "integrity": "sha512-1pC6N8qWJbWoPtEjgcL2xyhQOP491EQjeUo3qTKcmV8YSDDJrOepfG8pcC7h/QgnQHYSv0mJ3Z/ZWxmatVrysg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-generator-function": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/is-generator-function/-/is-generator-function-1.1.2.tgz",
      "integrity": "sha512-upqt1SkGkODW9tsGNG5mtXTXtECizwtS2kA161M+gJPc1xdb/Ax629af6YrTwcOeQHbewrPNlE5Dx7kzvXTizA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.4",
        "generator-function": "^2.0.0",
        "get-proto": "^1.0.1",
        "has-tostringtag": "^1.0.2",
        "safe-regex-test": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-glob": {
      "version": "4.0.3",
      "resolved": "https://registry.npmjs.org/is-glob/-/is-glob-4.0.3.tgz",
      "integrity": "sha512-xelSayHH36ZgE7ZWhli7pW34hNbNl8Ojv5KVmkJD4hBdD3th8Tfk9vYasLM+mXWOZhFkgZfxhLSnrwRr4elSSg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "is-extglob": "^2.1.1"
      },
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/is-map": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/is-map/-/is-map-2.0.3.tgz",
      "integrity": "sha512-1Qed0/Hr2m+YqxnM09CjA2d/i6YZNfF6R2oRAOj36eUdS6qIV/huPJNSEpKbupewFs+ZsJlxsjjPbc0/afW6Lw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-module": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/is-module/-/is-module-1.0.0.tgz",
      "integrity": "sha512-51ypPSPCoTEIN9dy5Oy+h4pShgJmPCygKfyRCISBI+JoWT/2oJvK8QPxmwv7b/p239jXrm9M1mlQbyKJ5A152g==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/is-negative-zero": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/is-negative-zero/-/is-negative-zero-2.0.3.tgz",
      "integrity": "sha512-5KoIu2Ngpyek75jXodFvnafB6DJgr3u8uuK0LEZJjrU19DrMD3EVERaR8sjz8CCGgpZvxPl9SuE1GMVPFHx1mw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-number-object": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/is-number-object/-/is-number-object-1.1.1.tgz",
      "integrity": "sha512-lZhclumE1G6VYD8VHe35wFaIif+CTy5SJIi5+3y4psDgWu4wPDoBhF8NxUOinEc7pHgiTsT6MaBb92rKhhD+Xw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "has-tostringtag": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-obj": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/is-obj/-/is-obj-1.0.1.tgz",
      "integrity": "sha512-l4RyHgRqGN4Y3+9JHVrNqO+tN0rV5My76uW5/nuO4K1b6vw5G8d/cmFjP9tRfEsdhZNt0IFdZuK/c2Vr4Nb+Qg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/is-regex": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/is-regex/-/is-regex-1.2.1.tgz",
      "integrity": "sha512-MjYsKHO5O7mCsmRGxWcLWheFqN9DJ/2TmngvjKXihe6efViPqc274+Fx/4fYj/r03+ESvBdTXK0V6tA3rgez1g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "gopd": "^1.2.0",
        "has-tostringtag": "^1.0.2",
        "hasown": "^2.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-regexp": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/is-regexp/-/is-regexp-1.0.0.tgz",
      "integrity": "sha512-7zjFAPO4/gwyQAAgRRmqeEeyIICSdmCqa3tsVHMdBzaXXRiqopZL4Cyghg/XulGWrtABTpbnYYzzIRffLkP4oA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/is-set": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/is-set/-/is-set-2.0.3.tgz",
      "integrity": "sha512-iPAjerrse27/ygGLxw+EBR9agv9Y6uLeYVJMu+QNCoouJ1/1ri0mGrcWpfCqFZuzzx3WjtwxG098X+n4OuRkPg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-shared-array-buffer": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/is-shared-array-buffer/-/is-shared-array-buffer-1.0.4.tgz",
      "integrity": "sha512-ISWac8drv4ZGfwKl5slpHG9OwPNty4jOWPRIhBpxOoD+hqITiwuipOQ2bNthAzwA3B4fIjO4Nln74N0S9byq8A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-stream": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/is-stream/-/is-stream-2.0.1.tgz",
      "integrity": "sha512-hFoiJiTl63nn+kstHGBtewWSKnQLpyb155KHheA1l39uvtO9nWIop1p3udqPcUd/xbF1VLMO4n7OI6p7RbngDg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/is-string": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/is-string/-/is-string-1.1.1.tgz",
      "integrity": "sha512-BtEeSsoaQjlSPBemMQIrY1MY0uM6vnS1g5fmufYOtnxLGUZM2178PKbhsk7Ffv58IX+ZtcvoGwccYsh0PglkAA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "has-tostringtag": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-symbol": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/is-symbol/-/is-symbol-1.1.1.tgz",
      "integrity": "sha512-9gGx6GTtCQM73BgmHQXfDmLtfjjTUDSyoxTCbp5WtoixAhfgsDirWIcVQ/IHpvI5Vgd5i/J5F7B9cN/WlVbC/w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "has-symbols": "^1.1.0",
        "safe-regex-test": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-typed-array": {
      "version": "1.1.15",
      "resolved": "https://registry.npmjs.org/is-typed-array/-/is-typed-array-1.1.15.tgz",
      "integrity": "sha512-p3EcsicXjit7SaskXHs1hA91QxgTw46Fv6EFKKGS5DRFLD8yKnohjF3hxoju94b/OcMZoQukzpPpBE9uLVKzgQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "which-typed-array": "^1.1.16"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-weakmap": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/is-weakmap/-/is-weakmap-2.0.2.tgz",
      "integrity": "sha512-K5pXYOm9wqY1RgjpL3YTkF39tni1XajUIkawTLUo9EZEVUFga5gSQJF8nNS7ZwJQ02y+1YCNYcMh+HIf1ZqE+w==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-weakref": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/is-weakref/-/is-weakref-1.1.1.tgz",
      "integrity": "sha512-6i9mGWSlqzNMEqpCp93KwRS1uUOodk2OJ6b+sq7ZPDSy2WuI5NFIxp/254TytR8ftefexkWn5xNiHUNpPOfSew==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-weakset": {
      "version": "2.0.4",
      "resolved": "https://registry.npmjs.org/is-weakset/-/is-weakset-2.0.4.tgz",
      "integrity": "sha512-mfcwb6IzQyOKTs84CQMrOwW4gQcaTOAWJ0zzJCl2WSPDrWk/OzDaImWFH3djXhb24g4eudZfLRozAvPGw4d9hQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "get-intrinsic": "^1.2.6"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/isarray": {
      "version": "2.0.5",
      "resolved": "https://registry.npmjs.org/isarray/-/isarray-2.0.5.tgz",
      "integrity": "sha512-xHjhDr3cNBK0BzdUJSPXZntQUx/mwMS5Rw4A7lPJ90XGAO6ISP/ePDNuo0vhqOZU+UD5JoodwCAAoZQd3FeAKw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/isexe": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/isexe/-/isexe-2.0.0.tgz",
      "integrity": "sha512-RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/jackspeak": {
      "version": "4.2.3",
      "resolved": "https://registry.npmjs.org/jackspeak/-/jackspeak-4.2.3.tgz",
      "integrity": "sha512-ykkVRwrYvFm1nb2AJfKKYPr0emF6IiXDYUaFx4Zn9ZuIH7MrzEZ3sD5RlqGXNRpHtvUHJyOnCEFxOlNDtGo7wg==",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "dependencies": {
        "@isaacs/cliui": "^9.0.0"
      },
      "engines": {
        "node": "20 || >=22"
      },
      "funding": {
        "url": "https://github.com/sponsors/isaacs"
      }
    },
    "node_modules/jake": {
      "version": "10.9.4",
      "resolved": "https://registry.npmjs.org/jake/-/jake-10.9.4.tgz",
      "integrity": "sha512-wpHYzhxiVQL+IV05BLE2Xn34zW1S223hvjtqk0+gsPrwd/8JNLXJgZZM/iPFsYc1xyphF+6M6EvdE5E9MBGkDA==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "async": "^3.2.6",
        "filelist": "^1.0.4",
        "picocolors": "^1.1.1"
      },
      "bin": {
        "jake": "bin/cli.js"
      },
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/jiti": {
      "version": "2.7.0",
      "resolved": "https://registry.npmjs.org/jiti/-/jiti-2.7.0.tgz",
      "integrity": "sha512-AC/7JofJvZGrrneWNaEnJeOLUx+JlGt7tNa0wZiRPT4MY1wmfKjt2+6O2p2uz2+skll8OZZmJMNqeke7kKbNgQ==",
      "dev": true,
      "license": "MIT",
      "bin": {
        "jiti": "lib/jiti-cli.mjs"
      }
    },
    "node_modules/js-tokens": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz",
      "integrity": "sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/js-yaml": {
      "version": "4.3.2",
      "resolved": "https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.2.tgz",
      "integrity": "sha512-SFNOvSJ+Dgf/9An904Yx+CgSlIPCkIpao4qo51lpee25TIRejdH3rhR4EZMGoNx3/TP3O+wzWuiTFl4sqbltzA==",
      "dev": true,
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/puzrin"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/nodeca"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "argparse": "^2.0.1"
      },
      "bin": {
        "js-yaml": "bin/js-yaml.js"
      }
    },
    "node_modules/jsesc": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/jsesc/-/jsesc-3.1.0.tgz",
      "integrity": "sha512-/sM3dO2FOzXjKQhJuo0Q173wf2KOo8t4I8vHy6lF9poUp7bKT0/NHE8fPX23PwfhnykfqnC2xRxOnVw5XuGIaA==",
      "dev": true,
      "license": "MIT",
      "bin": {
        "jsesc": "bin/jsesc"
      },
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/json-buffer": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/json-buffer/-/json-buffer-3.0.1.tgz",
      "integrity": "sha512-4bV5BfR2mqfQTJm+V5tPPdf+ZpuhiIvTuAB5g8kcrXOZpTT/QwwVRWBywX1ozr6lEuPdbHxwaJlm9G6mI2sfSQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/json-schema-traverse": {
      "version": "0.4.1",
      "resolved": "https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-0.4.1.tgz",
      "integrity": "sha512-xbbCH5dCYU5T8LcEhhuh7HJ88HXuW3qsI3Y0zOZFKfZEHcpWiHU/Jxzk629Brsab/mMiHQti9wMP+845RPe3Vg==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/json-stable-stringify-without-jsonify": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/json-stable-stringify-without-jsonify/-/json-stable-stringify-without-jsonify-1.0.1.tgz",
      "integrity": "sha512-Bdboy+l7tA3OGW6FjyFHWkP5LuByj1Tk33Ljyq0axyzdk9//JSi2u3fP1QSmd1KNwq6VOKYGlAu87CisVir6Pw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/json5": {
      "version": "2.2.3",
      "resolved": "https://registry.npmjs.org/json5/-/json5-2.2.3.tgz",
      "integrity": "sha512-XmOWe7eyHYH14cLdVPoyg+GOH3rYX++KpzrylJwSW98t3Nk+U8XOl8FWKOgwtzdb8lXGf6zYwDUzeHMWfxasyg==",
      "dev": true,
      "license": "MIT",
      "bin": {
        "json5": "lib/cli.js"
      },
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/jsonfile": {
      "version": "6.2.1",
      "resolved": "https://registry.npmjs.org/jsonfile/-/jsonfile-6.2.1.tgz",
      "integrity": "sha512-zwOTdL3rFQ/lRdBnntKVOX6k5cKJwEc1HdilT71BWEu7J41gXIB2MRp+vxduPSwZJPWBxEzv4yH1wYLJGUHX4Q==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "universalify": "^2.0.0"
      },
      "optionalDependencies": {
        "graceful-fs": "^4.1.6"
      }
    },
    "node_modules/jsonpointer": {
      "version": "5.0.1",
      "resolved": "https://registry.npmjs.org/jsonpointer/-/jsonpointer-5.0.1.tgz",
      "integrity": "sha512-p/nXbhSEcu3pZRdkW1OfJhpsVtW1gd4Wa1fnQc9YLiTfAjn0312eMKimbdIQzuZl9aa9xUGaRlP9T/CJE/ditQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/keyv": {
      "version": "4.5.4",
      "resolved": "https://registry.npmjs.org/keyv/-/keyv-4.5.4.tgz",
      "integrity": "sha512-oxVHkHR/EJf2CNXnWxRLW6mg7JyCCUcG0DtEGmL2ctUo1PNTin1PUil+r/+4r5MpVgC/fn1kjsx7mjSujKqIpw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "json-buffer": "3.0.1"
      }
    },
    "node_modules/leven": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/leven/-/leven-3.1.0.tgz",
      "integrity": "sha512-qsda+H8jTaUaN/x5vzW2rzc+8Rw4TAQ/4KjB46IwK5VH+IlVeeeje/EoZRpiXvIqjFgK84QffqPztGI3VBLG1A==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/levn": {
      "version": "0.4.1",
      "resolved": "https://registry.npmjs.org/levn/-/levn-0.4.1.tgz",
      "integrity": "sha512-+bT2uH4E5LGE7h/n3evcS/sQlJXCpIp6ym8OWJ5eV6+67Dsql/LaaT7qJBAt2rzfoa/5QBGBhxDix1dMt2kQKQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "prelude-ls": "^1.2.1",
        "type-check": "~0.4.0"
      },
      "engines": {
        "node": ">= 0.8.0"
      }
    },
    "node_modules/lightningcss": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss/-/lightningcss-1.33.0.tgz",
      "integrity": "sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==",
      "dev": true,
      "license": "MPL-2.0",
      "dependencies": {
        "detect-libc": "^2.0.3"
      },
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      },
      "optionalDependencies": {
        "lightningcss-android-arm64": "1.33.0",
        "lightningcss-darwin-arm64": "1.33.0",
        "lightningcss-darwin-x64": "1.33.0",
        "lightningcss-freebsd-x64": "1.33.0",
        "lightningcss-linux-arm-gnueabihf": "1.33.0",
        "lightningcss-linux-arm64-gnu": "1.33.0",
        "lightningcss-linux-arm64-musl": "1.33.0",
        "lightningcss-linux-x64-gnu": "1.33.0",
        "lightningcss-linux-x64-musl": "1.33.0",
        "lightningcss-win32-arm64-msvc": "1.33.0",
        "lightningcss-win32-x64-msvc": "1.33.0"
      }
    },
    "node_modules/lightningcss-android-arm64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-android-arm64/-/lightningcss-android-arm64-1.33.0.tgz",
      "integrity": "sha512-gEpRTalKdosp4Bb8qWtc2iOgE5SeIHlpS1up9bFq2wAyYhl1UdTObYiHe98zEM9SQvSoqQZ1IQD0JNpg3Ml5pg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-darwin-arm64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-arm64/-/lightningcss-darwin-arm64-1.33.0.tgz",
      "integrity": "sha512-Sciaz8eenNTKn9b3t7+xr0ipTp9YxKQY4npwQ3mrRuL0BAVHBLyZxofhaKBAVtzmtRZ/zTyo0/to4B1uWG/Djg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-darwin-x64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-x64/-/lightningcss-darwin-x64-1.33.0.tgz",
      "integrity": "sha512-Z5UPAxzrjlWNNyGy6i65cJzzvgJ5D3T6wMvs+gWpY9d7qRhANrxqAp6LhxIgZhWEw18RfJTGcRxjuLIBr+m8XQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-freebsd-x64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-freebsd-x64/-/lightningcss-freebsd-x64-1.33.0.tgz",
      "integrity": "sha512-QQM/Ti/hQajJwCY+RiWuCZ9sdtI/XQk7nDK5vC8kkdwixezOlDgvDx7+RT+QjK6FcFT4MpsuoBnHIo/O3StRRg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-arm-gnueabihf": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm-gnueabihf/-/lightningcss-linux-arm-gnueabihf-1.33.0.tgz",
      "integrity": "sha512-N7FVBe6iS24MlM6R/4RBTxGhQheZGs7tiQ9U32UtF75NzP5Q7xWPRqLBCKxlRQRk3rY1jCIPLzx7WzOhuUIRLQ==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-arm64-gnu": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-gnu/-/lightningcss-linux-arm64-gnu-1.33.0.tgz",
      "integrity": "sha512-j2v/itmy4HlNxlc6voKXYgBqNi0Ng2LShg4z7GufpEgs05P+2suBVyi9I6YHq5uoVFx9ETin3eCEhLVyXGQnKg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-arm64-musl": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-musl/-/lightningcss-linux-arm64-musl-1.33.0.tgz",
      "integrity": "sha512-yiO5ROMuYQgXbC60yjZU5CYSFZGKXL0HFATXt9mHJn1+zW55oCtMI9NfcVhYLMFDL7gV7oBPon/EmMMGg2OvtQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-x64-gnu": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.33.0.tgz",
      "integrity": "sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "glibc"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-x64-musl": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.33.0.tgz",
      "integrity": "sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "libc": [
        "musl"
      ],
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-win32-arm64-msvc": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-arm64-msvc/-/lightningcss-win32-arm64-msvc-1.33.0.tgz",
      "integrity": "sha512-1K+MPfLSFVpphzpdbfkhlWk6wBrTObBzS2T6db10PNOZgR9GoVsAWzwNyuhUYYbTp23j+4RrncfujZ4uAzXvwA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-win32-x64-msvc": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-x64-msvc/-/lightningcss-win32-x64-msvc-1.33.0.tgz",
      "integrity": "sha512-OlEICDx/Xl0FqSp4bry8zFnCvGpig3Gl4gCquvYwHuqJKEC1+n9NgDniFvqHGmMv1ZkqDJrDqKKSykTDX+ehuA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/locate-path": {
      "version": "6.0.0",
      "resolved": "https://registry.npmjs.org/locate-path/-/locate-path-6.0.0.tgz",
      "integrity": "sha512-iPZK6eYjbxRu3uB4/WZ3EsEIMJFMqAoopl3R+zuq0UjcAm/MO6KCweDgPfP3elTztoKP3KtnVHxTn2NHBSDVUw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "p-locate": "^5.0.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/lodash.debounce": {
      "version": "4.0.8",
      "resolved": "https://registry.npmjs.org/lodash.debounce/-/lodash.debounce-4.0.8.tgz",
      "integrity": "sha512-FT1yDzDYEoYWhnSGnpE/4Kj1fLZkDFyqRb7fNt6FdYOSxlUWAtp42Eh6Wb0rGIv/m9Bgo7x4GhQbm5Ys4SG5ow==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/lodash.merge": {
      "version": "4.6.2",
      "resolved": "https://registry.npmjs.org/lodash.merge/-/lodash.merge-4.6.2.tgz",
      "integrity": "sha512-0KpjqXRVvrYyCsX1swR/XTK0va6VQkQM6MNo7PqW77ByjAhoARA8EfrP1N4+KlKj8YS0ZUCtRT/YUuhyYDujIQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/lodash.sortby": {
      "version": "4.7.0",
      "resolved": "https://registry.npmjs.org/lodash.sortby/-/lodash.sortby-4.7.0.tgz",
      "integrity": "sha512-HDWXG8isMntAyRF5vZ7xKuEvOhT4AhlRt/3czTSjvGUxjYCBVRQY48ViDHyfYz9VIoBkW4TMGQNapx+l3RUwdA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/lru-cache": {
      "version": "5.1.1",
      "resolved": "https://registry.npmjs.org/lru-cache/-/lru-cache-5.1.1.tgz",
      "integrity": "sha512-KpNARQA3Iwv+jTA0utUVVbrh+Jlrr1Fv0e56GGzAFOXN7dk/FviaDW8LHmK52DlcH4WP2n6gI8vN1aesBFgo9w==",
      "dev": true,
      "license": "ISC",
      "dependencies": {
        "yallist": "^3.0.2"
      }
    },
    "node_modules/lucide-react": {
      "version": "0.468.0",
      "resolved": "https://registry.npmjs.org/lucide-react/-/lucide-react-0.468.0.tgz",
      "integrity": "sha512-6koYRhnM2N0GGZIdXzSeiNwguv1gt/FAjZOiPl76roBi3xKEXa4WmfpxgQwTTL4KipXjefrnf3oV4IsYhi4JFA==",
      "license": "ISC",
      "peerDependencies": {
        "react": "^16.5.1 || ^17.0.0 || ^18.0.0 || ^19.0.0-rc"
      }
    },
    "node_modules/magic-string": {
      "version": "0.30.21",
      "resolved": "https://registry.npmjs.org/magic-string/-/magic-string-0.30.21.tgz",
      "integrity": "sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/sourcemap-codec": "^1.5.5"
      }
    },
    "node_modules/math-intrinsics": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/math-intrinsics/-/math-intrinsics-1.1.0.tgz",
      "integrity": "sha512-/IXtbwEk5HTPyEwyKX6hGkYXxM9nbj64B+ilVJnC/R6B0pH5G4V3b0pVbL7DBj4tkhBAppbQUlf6F6Xl9LHu1g==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/minimatch": {
      "version": "3.1.5",
      "resolved": "https://registry.npmjs.org/minimatch/-/minimatch-3.1.5.tgz",
      "integrity": "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==",
      "dev": true,
      "license": "ISC",
      "dependencies": {
        "brace-expansion": "^1.1.7"
      },
      "engines": {
        "node": "*"
      }
    },
    "node_modules/minipass": {
      "version": "7.1.3",
      "resolved": "https://registry.npmjs.org/minipass/-/minipass-7.1.3.tgz",
      "integrity": "sha512-tEBHqDnIoM/1rXME1zgka9g6Q2lcoCkxHLuc7ODJ5BxbP5d4c2Z5cGgtXAku59200Cx7diuHTOYfSBD8n6mm8A==",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "engines": {
        "node": ">=16 || 14 >=14.17"
      }
    },
    "node_modules/ms": {
      "version": "2.1.3",
      "resolved": "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
      "integrity": "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/nanoid": {
      "version": "3.3.19",
      "resolved": "https://registry.npmjs.org/nanoid/-/nanoid-3.3.19.tgz",
      "integrity": "sha512-Y2tUNy4ouw6tq5oDSKeQYGOyhkUBhNOcGV/02KC+6kd9eDGqdZd++mjMiIDilrBYvjEnCYvVtsuHCuP+okSfug==",
      "dev": true,
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "MIT",
      "bin": {
        "nanoid": "bin/nanoid.cjs"
      },
      "engines": {
        "node": "^10 || ^12 || ^13.7 || ^14 || >=15.0.1"
      }
    },
    "node_modules/natural-compare": {
      "version": "1.4.0",
      "resolved": "https://registry.npmjs.org/natural-compare/-/natural-compare-1.4.0.tgz",
      "integrity": "sha512-OWND8ei3VtNC9h7V60qff3SVobHr996CTwgxubgyQYEpg290h9J0buyECNNJexkFm5sOajh5G116RYA1c8ZMSw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/node-releases": {
      "version": "2.0.57",
      "resolved": "https://registry.npmjs.org/node-releases/-/node-releases-2.0.57.tgz",
      "integrity": "sha512-kQK9LGGFiHtrWiNhZtA7Qbw17AQz+dmsEKODRIVTXA9+e5MS/2gZEBhYJt13GrAz5/IOZKddH/0Z3TP/Zgo+yw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/object-inspect": {
      "version": "1.13.4",
      "resolved": "https://registry.npmjs.org/object-inspect/-/object-inspect-1.13.4.tgz",
      "integrity": "sha512-W67iLl4J2EXEGTbfeHCffrjDfitvLANg0UlX3wFUUSTx92KXRFegMHUVgSqE+wvhAbi4WqjGg9czysTV2Epbew==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/object-keys": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/object-keys/-/object-keys-1.1.1.tgz",
      "integrity": "sha512-NuAESUOUMrlIXOfHKzD6bpPu3tYt3xvjNdRIQ+FeT0lNb4K8WR70CaDxhuNguS2XG+GjkyMwOzsN5ZktImfhLA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/object.assign": {
      "version": "4.1.7",
      "resolved": "https://registry.npmjs.org/object.assign/-/object.assign-4.1.7.tgz",
      "integrity": "sha512-nK28WOo+QIjBkDduTINE4JkF/UJJKyf2EJxvJKfblDpyg0Q+pkOHNTL0Qwy6NP6FhE/EnzV73BxxqcJaXY9anw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.3",
        "define-properties": "^1.2.1",
        "es-object-atoms": "^1.0.0",
        "has-symbols": "^1.1.0",
        "object-keys": "^1.1.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/optionator": {
      "version": "0.9.4",
      "resolved": "https://registry.npmjs.org/optionator/-/optionator-0.9.4.tgz",
      "integrity": "sha512-6IpQ7mKUxRcZNLIObR0hz7lxsapSSIYNZJwXPGeF0mTVqGKFIXj1DQcMoT22S3ROcLyY/rz0PWaWZ9ayWmad9g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "deep-is": "^0.1.3",
        "fast-levenshtein": "^2.0.6",
        "levn": "^0.4.1",
        "prelude-ls": "^1.2.1",
        "type-check": "^0.4.0",
        "word-wrap": "^1.2.5"
      },
      "engines": {
        "node": ">= 0.8.0"
      }
    },
    "node_modules/own-keys": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/own-keys/-/own-keys-1.0.1.tgz",
      "integrity": "sha512-qFOyK5PjiWZd+QQIh+1jhdb9LpxTF0qs7Pm8o5QHYZ0M3vKqSqzsZaEB6oWlxZ+q2sJBMI/Ktgd2N5ZwQoRHfg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "get-intrinsic": "^1.2.6",
        "object-keys": "^1.1.1",
        "safe-push-apply": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/p-limit": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/p-limit/-/p-limit-3.1.0.tgz",
      "integrity": "sha512-TYOanM3wGwNGsZN2cVTYPArw454xnXj5qmWF1bEoAc4+cU/ol7GVh7odevjp1FNHduHc3KZMcFduxU5Xc6uJRQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "yocto-queue": "^0.1.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/p-locate": {
      "version": "5.0.0",
      "resolved": "https://registry.npmjs.org/p-locate/-/p-locate-5.0.0.tgz",
      "integrity": "sha512-LaNjtRWUBY++zB5nE/NwcaoMylSPk+S+ZHNB1TzdbMJMny6dynpAGt7X/tl/QYq3TIeE6nxHppbo2LGymrG5Pw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "p-limit": "^3.0.2"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/package-json-from-dist": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/package-json-from-dist/-/package-json-from-dist-1.0.1.tgz",
      "integrity": "sha512-UEZIS3/by4OC8vL3P2dTXRETpebLI2NiI5vIrjaD/5UtrkFX/tNbwjTSRAGC/+7CAo2pIcBaRgWmcBBHcsaCIw==",
      "dev": true,
      "license": "BlueOak-1.0.0"
    },
    "node_modules/parent-module": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/parent-module/-/parent-module-1.0.1.tgz",
      "integrity": "sha512-GQ2EWRpQV8/o+Aw8YqtfZZPfNRWZYkbidE9k5rpl/hC3vtHHBfGm2Ifi6qWV+coDGkrUKZAxE3Lot5kcsRlh+g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "callsites": "^3.0.0"
      },
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/path-exists": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/path-exists/-/path-exists-4.0.0.tgz",
      "integrity": "sha512-ak9Qy5Q7jYb2Wwcey5Fpvg2KoAc/ZIhLSLOSBmRmygPsGwkVVt0fZa0qrtMz+m6tJTAHfZQ8FnmB4MG4LWy7/w==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/path-key": {
      "version": "3.1.1",
      "resolved": "https://registry.npmjs.org/path-key/-/path-key-3.1.1.tgz",
      "integrity": "sha512-ojmeN0qd+y0jszEtoY48r0Peq5dwMEkIlCOu6Q5f41lfkswXuKtYrhgoTpLnyIcHm24Uhqx+5Tqm2InSwLhE6Q==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/path-parse": {
      "version": "1.0.7",
      "resolved": "https://registry.npmjs.org/path-parse/-/path-parse-1.0.7.tgz",
      "integrity": "sha512-LDJzPVEEEPR+y48z93A0Ed0yXb8pAByGWo/k5YYdYgpY2/2EsOsksJrq7lOHxryrVOn1ejG6oAp8ahvOIQD8sw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/path-scurry": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/path-scurry/-/path-scurry-2.0.2.tgz",
      "integrity": "sha512-3O/iVVsJAPsOnpwWIeD+d6z/7PmqApyQePUtCndjatj/9I5LylHvt5qluFaBT3I5h3r1ejfR056c+FCv+NnNXg==",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "dependencies": {
        "lru-cache": "^11.0.0",
        "minipass": "^7.1.2"
      },
      "engines": {
        "node": "18 || 20 || >=22"
      },
      "funding": {
        "url": "https://github.com/sponsors/isaacs"
      }
    },
    "node_modules/path-scurry/node_modules/lru-cache": {
      "version": "11.5.2",
      "resolved": "https://registry.npmjs.org/lru-cache/-/lru-cache-11.5.2.tgz",
      "integrity": "sha512-4pfM1Ff0x50o0tQwb5ucw/RzNyD0/YJME6IVcStalZuMWxdt3sR3huStTtxz4PUmvZfRguvDejasvQ2kifR11g==",
      "dev": true,
      "license": "BlueOak-1.0.0",
      "engines": {
        "node": "20 || >=22"
      }
    },
    "node_modules/pg": {
      "version": "8.23.1",
      "resolved": "https://registry.npmjs.org/pg/-/pg-8.23.1.tgz",
      "integrity": "sha512-aL96AHANtWjPLDOLqnhx+ngp9+UK7ETEU8VJrDCGvsSSi/mGLcWYsS6Herg7lmaBJe4uwrfqsa7gTEFaSizDoQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "pg-connection-string": "^2.14.1",
        "pg-pool": "^3.14.0",
        "pg-protocol": "^1.16.1",
        "pg-types": "2.2.0",
        "pgpass": "1.0.5"
      },
      "engines": {
        "node": ">= 16.0.0"
      },
      "optionalDependencies": {
        "pg-cloudflare": "^1.4.1"
      },
      "peerDependencies": {
        "pg-native": ">=3.0.1"
      },
      "peerDependenciesMeta": {
        "pg-native": {
          "optional": true
        }
      }
    },
    "node_modules/pg-cloudflare": {
      "version": "1.4.1",
      "resolved": "https://registry.npmjs.org/pg-cloudflare/-/pg-cloudflare-1.4.1.tgz",
      "integrity": "sha512-6PQbsFWZcp9EmJEwy5cGQ2La+AMWpP46lgbb8X+U/XsHIUweYDNCpeuKck5RxL2MdVFi7krbbEi5nX4Zh7JhrQ==",
      "dev": true,
      "license": "MIT",
      "optional": true
    },
    "node_modules/pg-connection-string": {
      "version": "2.14.1",
      "resolved": "https://registry.npmjs.org/pg-connection-string/-/pg-connection-string-2.14.1.tgz",
      "integrity": "sha512-qR3kGNPBLpCNtz0evbKA0Y/MRFXwSSdT+pTJvYp/bXTcReZbvX1kzF0IyTc1QnxqF7AZbOeBhNL8R5mYQZV/MA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/pg-int8": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/pg-int8/-/pg-int8-1.0.1.tgz",
      "integrity": "sha512-WCtabS6t3c8SkpDBUlb1kjOs7l66xsGdKpIPZsg4wR+B3+u9UAum2odSsF9tnvxg80h4ZxLWMy4pRjOsFIqQpw==",
      "dev": true,
      "license": "ISC",
      "engines": {
        "node": ">=4.0.0"
      }
    },
    "node_modules/pg-pool": {
      "version": "3.14.0",
      "resolved": "https://registry.npmjs.org/pg-pool/-/pg-pool-3.14.0.tgz",
      "integrity": "sha512-gKtPkFdQPU3DksooVLi9LsjZxrsBUZIpa+7aVx+LV5pNh0KzP4Zleud2po+ConrxbuXGBJ6Hfer6hdgpIBpBaw==",
      "dev": true,
      "license": "MIT",
      "peerDependencies": {
        "pg": ">=8.0"
      }
    },
    "node_modules/pg-protocol": {
      "version": "1.16.1",
      "resolved": "https://registry.npmjs.org/pg-protocol/-/pg-protocol-1.16.1.tgz",
      "integrity": "sha512-p9VOFMiHB/ZbJATetbg+99PxssTVSQRnyuPSQ67mN1+1KBOjZaZ83ZQzltnxPhJwSsC3nwVjJ10DVJlerbFzLg==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/pg-types": {
      "version": "2.2.0",
      "resolved": "https://registry.npmjs.org/pg-types/-/pg-types-2.2.0.tgz",
      "integrity": "sha512-qTAAlrEsl8s4OiEQY69wDvcMIdQN6wdz5ojQiOy6YRMuynxenON0O5oCpJI6lshc6scgAY8qvJ2On/p+CXY0GA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "pg-int8": "1.0.1",
        "postgres-array": "~2.0.0",
        "postgres-bytea": "~1.0.0",
        "postgres-date": "~1.0.4",
        "postgres-interval": "^1.1.0"
      },
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/pgpass": {
      "version": "1.0.5",
      "resolved": "https://registry.npmjs.org/pgpass/-/pgpass-1.0.5.tgz",
      "integrity": "sha512-FdW9r/jQZhSeohs1Z3sI1yxFQNFvMcnmfuj4WBMUTxOrAyLMaTcE1aAMBiTlbMNaXvBCQuVi0R7hd8udDSP7ug==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "split2": "^4.1.0"
      }
    },
    "node_modules/picocolors": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz",
      "integrity": "sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/picomatch": {
      "version": "4.0.7",
      "resolved": "https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz",
      "integrity": "sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=12"
      },
      "funding": {
        "url": "https://github.com/sponsors/jonschlinkert"
      }
    },
    "node_modules/possible-typed-array-names": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/possible-typed-array-names/-/possible-typed-array-names-1.1.0.tgz",
      "integrity": "sha512-/+5VFTchJDoVj3bhoqi6UeymcD00DAwb1nJwamzPvHEszJ4FpF6SNNbUbOS8yI56qHzdV8eK0qEfOSiodkTdxg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/postcss": {
      "version": "8.5.28",
      "resolved": "https://registry.npmjs.org/postcss/-/postcss-8.5.28.tgz",
      "integrity": "sha512-RRuzqDtt5Y9h3quz5hWhK+TPnsmVs6WwSU6LkJMeY4HstUEDuYTG8UJSdawMRzmzAtV+KEoG8N3Qg2qLy5vM/A==",
      "dev": true,
      "funding": [
        {
          "type": "opencollective",
          "url": "https://opencollective.com/postcss/"
        },
        {
          "type": "tidelift",
          "url": "https://tidelift.com/funding/github/npm/postcss"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "nanoid": "^3.3.18",
        "picocolors": "^1.1.1",
        "source-map-js": "^1.2.1"
      },
      "engines": {
        "node": "^10 || ^12 || >=14"
      }
    },
    "node_modules/postgres-array": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/postgres-array/-/postgres-array-2.0.0.tgz",
      "integrity": "sha512-VpZrUqU5A69eQyW2c5CA1jtLecCsN2U/bD6VilrFDWq5+5UIEVO7nazS3TEcHf1zuPYO/sqGvUvW62g86RXZuA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/postgres-bytea": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/postgres-bytea/-/postgres-bytea-1.0.1.tgz",
      "integrity": "sha512-5+5HqXnsZPE65IJZSMkZtURARZelel2oXUEO8rH83VS/hxH5vv1uHquPg5wZs8yMAfdv971IU+kcPUczi7NVBQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/postgres-date": {
      "version": "1.0.7",
      "resolved": "https://registry.npmjs.org/postgres-date/-/postgres-date-1.0.7.tgz",
      "integrity": "sha512-suDmjLVQg78nMK2UZ454hAG+OAW+HQPZ6n++TNDUX+L0+uUlLywnoxJKDou51Zm+zTCjrCl0Nq6J9C5hP9vK/Q==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/postgres-interval": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/postgres-interval/-/postgres-interval-1.2.0.tgz",
      "integrity": "sha512-9ZhXKM/rw350N1ovuWHbGxnGh/SNJ4cnxHiM0rxE4VN41wsg8P8zWn9hv/buK00RP4WvlOyr/RBDiptyxVbkZQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "xtend": "^4.0.0"
      },
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/prelude-ls": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/prelude-ls/-/prelude-ls-1.2.1.tgz",
      "integrity": "sha512-vkcDPrRZo1QZLbn5RLGPpg/WmIQ65qoWWhcGKf/b5eplkkarX0m9z8ppCat4mlOqUsWpyNuYgO3VRyrYHSzX5g==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.8.0"
      }
    },
    "node_modules/pretty-bytes": {
      "version": "6.1.1",
      "resolved": "https://registry.npmjs.org/pretty-bytes/-/pretty-bytes-6.1.1.tgz",
      "integrity": "sha512-mQUvGU6aUFQ+rNvTIAcZuWGRT9a6f6Yrg9bHs4ImKF+HZCEK+plBvnAZYSIQztknZF2qnzNtr6F8s0+IuptdlQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "^14.13.1 || >=16.0.0"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/punycode": {
      "version": "2.3.1",
      "resolved": "https://registry.npmjs.org/punycode/-/punycode-2.3.1.tgz",
      "integrity": "sha512-vYt7UD1U9Wg6138shLtLOvdAu+8DsC/ilFtEVHcH+wydcSpNE20AfSOduf6MkRFahL5FY7X1oU7nKVZFtfq8Fg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/react": {
      "version": "19.2.6",
      "resolved": "https://registry.npmjs.org/react/-/react-19.2.6.tgz",
      "integrity": "sha512-sfWGGfavi0xr8Pg0sVsyHMAOziVYKgPLNrS7ig+ivMNb3wbCBw3KxtflsGBAwD3gYQlE/AEZsTLgToRrSCjb0Q==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/react-dom": {
      "version": "19.2.6",
      "resolved": "https://registry.npmjs.org/react-dom/-/react-dom-19.2.6.tgz",
      "integrity": "sha512-0prMI+hvBbPjsWnxDLxlCGyM8PN6UuWjEUCYmZhO67xIV9Xasa/r/vDnq+Xyq4Lo27g8QSbO5YzARu0D1Sps3g==",
      "license": "MIT",
      "dependencies": {
        "scheduler": "^0.27.0"
      },
      "peerDependencies": {
        "react": "^19.2.6"
      }
    },
    "node_modules/react-is": {
      "version": "16.13.1",
      "resolved": "https://registry.npmjs.org/react-is/-/react-is-16.13.1.tgz",
      "integrity": "sha512-24e6ynE2H+OKt4kqsOvNd8kBpV65zoxbA4BVsEOB3ARVWQki/DHzaUoC5KuON/BiccDaCCTZBuOcfZs70kR8bQ==",
      "license": "MIT",
      "peer": true
    },
    "node_modules/react-redux": {
      "version": "9.3.0",
      "resolved": "https://registry.npmjs.org/react-redux/-/react-redux-9.3.0.tgz",
      "integrity": "sha512-KQopgqFo/p/fgmAs5qz6p5RWaNAzq40WAu7fJIXnQpYxFPbJYtsJPWvGeF2rOBaY/kEuV77AVsX8TsQzKm+A/g==",
      "license": "MIT",
      "dependencies": {
        "@types/use-sync-external-store": "^0.0.6",
        "use-sync-external-store": "^1.4.0"
      },
      "peerDependencies": {
        "@types/react": "^18.2.25 || ^19",
        "react": "^18.0 || ^19",
        "redux": "^5.0.0"
      },
      "peerDependenciesMeta": {
        "@types/react": {
          "optional": true
        },
        "redux": {
          "optional": true
        }
      }
    },
    "node_modules/recharts": {
      "version": "3.9.2",
      "resolved": "https://registry.npmjs.org/recharts/-/recharts-3.9.2.tgz",
      "integrity": "sha512-G4fy+Pk46RaXgwWMh+Nzhyo/lbFAVqXo9gtetlyehe6Ehge9CsgDuOTwQDD+i1+llaLktNBiNq4bhnGlDRXFtw==",
      "license": "MIT",
      "workspaces": [
        "www"
      ],
      "dependencies": {
        "@reduxjs/toolkit": "^1.9.0 || 2.x.x",
        "clsx": "^2.1.1",
        "decimal.js-light": "^2.5.1",
        "es-toolkit": "^1.39.3",
        "eventemitter3": "^5.0.1",
        "immer": "^11.1.8",
        "react-redux": "8.x.x || 9.x.x",
        "reselect": "5.2.0",
        "tiny-invariant": "^1.3.3",
        "use-sync-external-store": "^1.2.2",
        "victory-vendor": "^37.0.2"
      },
      "engines": {
        "node": ">=18"
      },
      "peerDependencies": {
        "react": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0",
        "react-dom": "^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0",
        "react-is": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0"
      }
    },
    "node_modules/redux": {
      "version": "5.0.1",
      "resolved": "https://registry.npmjs.org/redux/-/redux-5.0.1.tgz",
      "integrity": "sha512-M9/ELqF6fy8FwmkpnF0S3YKOqMyoWJ4+CS5Efg2ct3oY9daQvd/Pc71FpGZsVsbl3Cpb+IIcjBDUnnyBdQbq4w==",
      "license": "MIT"
    },
    "node_modules/redux-thunk": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/redux-thunk/-/redux-thunk-3.1.0.tgz",
      "integrity": "sha512-NW2r5T6ksUKXCabzhL9z+h206HQw/NJkcLm1GPImRQ8IzfXwRGqjVhKJGauHirT0DAuyy6hjdnMZaRoAcy0Klw==",
      "license": "MIT",
      "peerDependencies": {
        "redux": "^5.0.0"
      }
    },
    "node_modules/reflect.getprototypeof": {
      "version": "1.0.10",
      "resolved": "https://registry.npmjs.org/reflect.getprototypeof/-/reflect.getprototypeof-1.0.10.tgz",
      "integrity": "sha512-00o4I+DVrefhv+nX0ulyi3biSHCPDe+yLv5o/p6d/UVlirijB8E16FtfwSAi4g3tcqrQ4lRAqQSoFEZJehYEcw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "define-properties": "^1.2.1",
        "es-abstract": "^1.23.9",
        "es-errors": "^1.3.0",
        "es-object-atoms": "^1.0.0",
        "get-intrinsic": "^1.2.7",
        "get-proto": "^1.0.1",
        "which-builtin-type": "^1.2.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/regenerate": {
      "version": "1.4.2",
      "resolved": "https://registry.npmjs.org/regenerate/-/regenerate-1.4.2.tgz",
      "integrity": "sha512-zrceR/XhGYU/d/opr2EKO7aRHUeiBI8qjtfHqADTwZd6Szfy16la6kqD0MIUs5z5hx6AaKa+PixpPrR289+I0A==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/regenerate-unicode-properties": {
      "version": "10.2.2",
      "resolved": "https://registry.npmjs.org/regenerate-unicode-properties/-/regenerate-unicode-properties-10.2.2.tgz",
      "integrity": "sha512-m03P+zhBeQd1RGnYxrGyDAPpWX/epKirLrp8e3qevZdVkKtnCrjjWczIbYc8+xd6vcTStVlqfycTx1KR4LOr0g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "regenerate": "^1.4.2"
      },
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/regexp.prototype.flags": {
      "version": "1.5.4",
      "resolved": "https://registry.npmjs.org/regexp.prototype.flags/-/regexp.prototype.flags-1.5.4.tgz",
      "integrity": "sha512-dYqgNSZbDwkaJ2ceRd9ojCGjBq+mOm9LmtXnAnEGyHhN/5R7iDW2TRw3h+o/jCFxus3P2LfWIIiwowAjANm7IA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "define-properties": "^1.2.1",
        "es-errors": "^1.3.0",
        "get-proto": "^1.0.1",
        "gopd": "^1.2.0",
        "set-function-name": "^2.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/regexpu-core": {
      "version": "6.4.0",
      "resolved": "https://registry.npmjs.org/regexpu-core/-/regexpu-core-6.4.0.tgz",
      "integrity": "sha512-0ghuzq67LI9bLXpOX/ISfve/Mq33a4aFRzoQYhnnok1JOFpmE/A2TBGkNVenOGEeSBCjIiWcc6MVOG5HEQv0sA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "regenerate": "^1.4.2",
        "regenerate-unicode-properties": "^10.2.2",
        "regjsgen": "^0.8.0",
        "regjsparser": "^0.13.0",
        "unicode-match-property-ecmascript": "^2.0.0",
        "unicode-match-property-value-ecmascript": "^2.2.1"
      },
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/regjsgen": {
      "version": "0.8.0",
      "resolved": "https://registry.npmjs.org/regjsgen/-/regjsgen-0.8.0.tgz",
      "integrity": "sha512-RvwtGe3d7LvWiDQXeQw8p5asZUmfU1G/l6WbUXeHta7Y2PEIvBTwH6E2EfmYUK8pxcxEdEmaomqyp0vZZ7C+3Q==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/regjsparser": {
      "version": "0.13.2",
      "resolved": "https://registry.npmjs.org/regjsparser/-/regjsparser-0.13.2.tgz",
      "integrity": "sha512-NgRBy2Nx/bE+9F27nVHnqcN5HjyLmecqsqx2PJHu3/IEtADD4WuxuXIVExD5PoSDFVrl78dOonfcOe5O+5nbzQ==",
      "dev": true,
      "license": "BSD-2-Clause",
      "dependencies": {
        "jsesc": "~3.1.0"
      },
      "bin": {
        "regjsparser": "bin/parser"
      }
    },
    "node_modules/require-from-string": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/require-from-string/-/require-from-string-2.0.2.tgz",
      "integrity": "sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/reselect": {
      "version": "5.2.0",
      "resolved": "https://registry.npmjs.org/reselect/-/reselect-5.2.0.tgz",
      "integrity": "sha512-AgZ3UOZm3YndfrJ4OYjgrT7bmCm/1iqkjvEfH/oYjzh6PD2qw4QuT3jjnXIrpdt4MTpMXclMT3lXbmRY+XRakw==",
      "license": "MIT"
    },
    "node_modules/resolve-from": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/resolve-from/-/resolve-from-4.0.0.tgz",
      "integrity": "sha512-pb/MYmXstAkysRFx8piNI1tGFNQIFA3vkE3Gq4EuA1dF6gHp/+vgZqsCGJapvy8N3Q+4o7FwvquPJcnZ7RYy4g==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/rolldown": {
      "version": "1.2.12",
      "resolved": "https://registry.npmjs.org/rolldown/-/rolldown-1.2.12.tgz",
      "integrity": "sha512-8wafseiaG80xmXSfqidUNqZcylTlhmPZZt+za2m+js2sFZ8dTNlhIOV2WcbIPx2hgwPBJpEUGFAMZ9bgBBLTSQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@oxc-project/types": "=0.152.0",
        "@rolldown/pluginutils": "^1.0.0"
      },
      "bin": {
        "rolldown": "bin/cli.mjs"
      },
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      },
      "optionalDependencies": {
        "@rolldown/binding-android-arm-eabi": "1.2.12",
        "@rolldown/binding-android-arm64": "1.2.12",
        "@rolldown/binding-darwin-arm64": "1.2.12",
        "@rolldown/binding-darwin-x64": "1.2.12",
        "@rolldown/binding-freebsd-x64": "1.2.12",
        "@rolldown/binding-linux-arm-gnueabihf": "1.2.12",
        "@rolldown/binding-linux-arm64-gnu": "1.2.12",
        "@rolldown/binding-linux-arm64-musl": "1.2.12",
        "@rolldown/binding-linux-ppc64-gnu": "1.2.12",
        "@rolldown/binding-linux-s390x-gnu": "1.2.12",
        "@rolldown/binding-linux-x64-gnu": "1.2.12",
        "@rolldown/binding-linux-x64-musl": "1.2.12",
        "@rolldown/binding-openharmony-arm64": "1.2.12",
        "@rolldown/binding-win32-arm64-msvc": "1.2.12",
        "@rolldown/binding-win32-x64-msvc": "1.2.12"
      }
    },
    "node_modules/rollup": {
      "version": "4.62.2",
      "resolved": "https://registry.npmjs.org/rollup/-/rollup-4.62.2.tgz",
      "integrity": "sha512-RFnrW4lhXA3s3eqHDZvN654g8OTjzRfqpIRJYczCGB6HzphckVAi/Qh4tbPUbRuDi7s1Llv8g/NspLkttY3gTA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@types/estree": "1.0.9"
      },
      "bin": {
        "rollup": "dist/bin/rollup"
      },
      "engines": {
        "node": ">=18.0.0",
        "npm": ">=8.0.0"
      },
      "optionalDependencies": {
        "@rollup/rollup-android-arm-eabi": "4.62.2",
        "@rollup/rollup-android-arm64": "4.62.2",
        "@rollup/rollup-darwin-arm64": "4.62.2",
        "@rollup/rollup-darwin-x64": "4.62.2",
        "@rollup/rollup-freebsd-arm64": "4.62.2",
        "@rollup/rollup-freebsd-x64": "4.62.2",
        "@rollup/rollup-linux-arm-gnueabihf": "4.62.2",
        "@rollup/rollup-linux-arm-musleabihf": "4.62.2",
        "@rollup/rollup-linux-arm64-gnu": "4.62.2",
        "@rollup/rollup-linux-arm64-musl": "4.62.2",
        "@rollup/rollup-linux-loong64-gnu": "4.62.2",
        "@rollup/rollup-linux-loong64-musl": "4.62.2",
        "@rollup/rollup-linux-ppc64-gnu": "4.62.2",
        "@rollup/rollup-linux-ppc64-musl": "4.62.2",
        "@rollup/rollup-linux-riscv64-gnu": "4.62.2",
        "@rollup/rollup-linux-riscv64-musl": "4.62.2",
        "@rollup/rollup-linux-s390x-gnu": "4.62.2",
        "@rollup/rollup-linux-x64-gnu": "4.62.2",
        "@rollup/rollup-linux-x64-musl": "4.62.2",
        "@rollup/rollup-openbsd-x64": "4.62.2",
        "@rollup/rollup-openharmony-arm64": "4.62.2",
        "@rollup/rollup-win32-arm64-msvc": "4.62.2",
        "@rollup/rollup-win32-ia32-msvc": "4.62.2",
        "@rollup/rollup-win32-x64-gnu": "4.62.2",
        "@rollup/rollup-win32-x64-msvc": "4.62.2",
        "fsevents": "~2.3.2"
      }
    },
    "node_modules/safe-array-concat": {
      "version": "1.1.4",
      "resolved": "https://registry.npmjs.org/safe-array-concat/-/safe-array-concat-1.1.4.tgz",
      "integrity": "sha512-wtZlHyOje6OZTGqAoaDKxFkgRtkF9CnHAVnCHKfuj200wAgL+bSJhdsCD2l0Qx/2ekEXjPWcyKkfGb5CPboslg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.9",
        "call-bound": "^1.0.4",
        "get-intrinsic": "^1.3.0",
        "has-symbols": "^1.1.0",
        "isarray": "^2.0.5"
      },
      "engines": {
        "node": ">=0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/safe-push-apply": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/safe-push-apply/-/safe-push-apply-1.0.0.tgz",
      "integrity": "sha512-iKE9w/Z7xCzUMIZqdBsp6pEQvwuEebH4vdpjcDWnyzaI6yl6O9FHvVpmGelvEHNsoY6wGblkxR6Zty/h00WiSA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "isarray": "^2.0.5"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/safe-regex-test": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/safe-regex-test/-/safe-regex-test-1.1.0.tgz",
      "integrity": "sha512-x/+Cz4YrimQxQccJf5mKEbIa1NzeCRNI5Ecl/ekmlYaampdNLPalVyIcCZNNH3MvmqBugV5TMYZXv0ljslUlaw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "es-errors": "^1.3.0",
        "is-regex": "^1.2.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/scheduler": {
      "version": "0.27.0",
      "resolved": "https://registry.npmjs.org/scheduler/-/scheduler-0.27.0.tgz",
      "integrity": "sha512-eNv+WrVbKu1f3vbYJT/xtiF5syA5HPIMtf9IgY/nKg0sWqzAUEvqY/xm7OcZc/qafLx/iO9FgOmeSAp4v5ti/Q==",
      "license": "MIT"
    },
    "node_modules/semver": {
      "version": "6.3.1",
      "resolved": "https://registry.npmjs.org/semver/-/semver-6.3.1.tgz",
      "integrity": "sha512-BR7VvDCVHO+q2xBEWskxS6DJE1qRnb7DxzUrogb71CWoSficBxYsiAGd+Kl0mmq/MprG9yArRkyrQxTO6XjMzA==",
      "dev": true,
      "license": "ISC",
      "bin": {
        "semver": "bin/semver.js"
      }
    },
    "node_modules/serialize-javascript": {
      "version": "7.0.7",
      "resolved": "https://registry.npmjs.org/serialize-javascript/-/serialize-javascript-7.0.7.tgz",
      "integrity": "sha512-YAy8Od6KV+uuwUuU50np8fGB/Aues6Y0nAhA9y/hId74PlKUcme4pXcBD46NWKr1Q4osN/iseZ17YqO1XfmI8g==",
      "dev": true,
      "license": "BSD-3-Clause",
      "engines": {
        "node": ">=20.0.0"
      }
    },
    "node_modules/set-function-length": {
      "version": "1.2.2",
      "resolved": "https://registry.npmjs.org/set-function-length/-/set-function-length-1.2.2.tgz",
      "integrity": "sha512-pgRc4hJ4/sNjWCSS9AmnS40x3bNMDTknHgL5UaMBTMyJnU90EgWh1Rz+MC9eFu4BuN/UwZjKQuY/1v3rM7HMfg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "define-data-property": "^1.1.4",
        "es-errors": "^1.3.0",
        "function-bind": "^1.1.2",
        "get-intrinsic": "^1.2.4",
        "gopd": "^1.0.1",
        "has-property-descriptors": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/set-function-name": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/set-function-name/-/set-function-name-2.0.2.tgz",
      "integrity": "sha512-7PGFlmtwsEADb0WYyvCMa1t+yke6daIG4Wirafur5kcf+MhUnPms1UeR0CKQdTZD81yESwMHbtn+TR+dMviakQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "define-data-property": "^1.1.4",
        "es-errors": "^1.3.0",
        "functions-have-names": "^1.2.3",
        "has-property-descriptors": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/set-proto": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/set-proto/-/set-proto-1.0.0.tgz",
      "integrity": "sha512-RJRdvCo6IAnPdsvP/7m6bsQqNnn1FCBX5ZNtFL98MmFF/4xAIJTIg1YbHW5DC2W5SKZanrC6i4HsJqlajw/dZw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "dunder-proto": "^1.0.1",
        "es-errors": "^1.3.0",
        "es-object-atoms": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/shebang-command": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/shebang-command/-/shebang-command-2.0.0.tgz",
      "integrity": "sha512-kHxr2zZpYtdmrN1qDjrrX/Z1rR1kG8Dx+gkpK1G4eXmvXswmcE1hTWBWYUzlraYw1/yZp6YuDY77YtvbN0dmDA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "shebang-regex": "^3.0.0"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/shebang-regex": {
      "version": "3.0.0",
      "resolved": "https://registry.npmjs.org/shebang-regex/-/shebang-regex-3.0.0.tgz",
      "integrity": "sha512-7++dFhtcx3353uBaq8DDR4NuxBetBzC7ZQOhmTQInHEd6bSrXdiEyzCvG07Z44UYdLShWUyXt5M/yhz8ekcb1A==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/side-channel": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/side-channel/-/side-channel-1.1.0.tgz",
      "integrity": "sha512-ZX99e6tRweoUXqR+VBrslhda51Nh5MTQwou5tnUDgbtyM0dBgmhEDtWGP/xbKn6hqfPRHujUNwz5fy/wbbhnpw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "object-inspect": "^1.13.3",
        "side-channel-list": "^1.0.0",
        "side-channel-map": "^1.0.1",
        "side-channel-weakmap": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/side-channel-list": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/side-channel-list/-/side-channel-list-1.0.1.tgz",
      "integrity": "sha512-mjn/0bi/oUURjc5Xl7IaWi/OJJJumuoJFQJfDDyO46+hBWsfaVM65TBHq2eoZBhzl9EchxOijpkbRC8SVBQU0w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "object-inspect": "^1.13.4"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/side-channel-map": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/side-channel-map/-/side-channel-map-1.0.1.tgz",
      "integrity": "sha512-VCjCNfgMsby3tTdo02nbjtM/ewra6jPHmpThenkTYh8pG9ucZ/1P8So4u4FGBek/BjpOVsDCMoLA/iuBKIFXRA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.5",
        "object-inspect": "^1.13.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/side-channel-weakmap": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/side-channel-weakmap/-/side-channel-weakmap-1.0.2.tgz",
      "integrity": "sha512-WPS/HvHQTYnHisLo9McqBHOJk2FkHO/tlpvldyrnem4aeQp4hai3gythswg6p01oSoTl58rcpiFAjF2br2Ak2A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.5",
        "object-inspect": "^1.13.3",
        "side-channel-map": "^1.0.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/signal-exit": {
      "version": "4.1.0",
      "resolved": "https://registry.npmjs.org/signal-exit/-/signal-exit-4.1.0.tgz",
      "integrity": "sha512-bzyZ1e88w9O1iNJbKnOlvYTrWPDl46O1bG0D3XInv+9tkPrxrN8jUUTiFlDkkmKWgn1M6CfIA13SuGqOa9Korw==",
      "dev": true,
      "license": "ISC",
      "engines": {
        "node": ">=14"
      },
      "funding": {
        "url": "https://github.com/sponsors/isaacs"
      }
    },
    "node_modules/smob": {
      "version": "1.6.2",
      "resolved": "https://registry.npmjs.org/smob/-/smob-1.6.2.tgz",
      "integrity": "sha512-RQsvleCbF8cVHEv+xuDGaA4pOizFqJ0GgjtMSRo6oP8pnN7WsigHgVGey6aILRBKv4W2YOMHLqbKdnB6hpB9fw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=20.0.0"
      }
    },
    "node_modules/source-map": {
      "version": "0.6.1",
      "resolved": "https://registry.npmjs.org/source-map/-/source-map-0.6.1.tgz",
      "integrity": "sha512-UjgapumWlbMhkBgzT7Ykc5YXUT46F0iKu8SGXq0bcwP5dz/h0Plj6enJqjz1Zbq2l5WaqYnrVbwWOWMyF3F47g==",
      "dev": true,
      "license": "BSD-3-Clause",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/source-map-js": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.1.tgz",
      "integrity": "sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==",
      "dev": true,
      "license": "BSD-3-Clause",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/source-map-support": {
      "version": "0.5.21",
      "resolved": "https://registry.npmjs.org/source-map-support/-/source-map-support-0.5.21.tgz",
      "integrity": "sha512-uBHU3L3czsIyYXKX88fdrGovxdSCoTGDRZ6SYXtSRxLZUzHg5P/66Ht6uoUlHu9EZod+inXhKo3qQgwXUT/y1w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "buffer-from": "^1.0.0",
        "source-map": "^0.6.0"
      }
    },
    "node_modules/split2": {
      "version": "4.2.0",
      "resolved": "https://registry.npmjs.org/split2/-/split2-4.2.0.tgz",
      "integrity": "sha512-UcjcJOWknrNkF6PLX83qcHM6KHgVKNkV62Y8a5uYDVv9ydGQVwAHMKqHdJje1VTWpljG0WYpCDhrCdAOYH4TWg==",
      "dev": true,
      "license": "ISC",
      "engines": {
        "node": ">= 10.x"
      }
    },
    "node_modules/stop-iteration-iterator": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/stop-iteration-iterator/-/stop-iteration-iterator-1.1.0.tgz",
      "integrity": "sha512-eLoXW/DHyl62zxY4SCaIgnRhuMr6ri4juEYARS8E6sCEqzKpOiE521Ucofdx+KnDZl5xmvGYaaKCk5FEOxJCoQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "internal-slot": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/string.prototype.matchall": {
      "version": "4.0.12",
      "resolved": "https://registry.npmjs.org/string.prototype.matchall/-/string.prototype.matchall-4.0.12.tgz",
      "integrity": "sha512-6CC9uyBL+/48dYizRf7H7VAYCMCNTBeM78x/VTUe9bFEaxBepPJDa1Ow99LqI/1yF7kuy7Q3cQsYMrcjGUcskA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.3",
        "define-properties": "^1.2.1",
        "es-abstract": "^1.23.6",
        "es-errors": "^1.3.0",
        "es-object-atoms": "^1.0.0",
        "get-intrinsic": "^1.2.6",
        "gopd": "^1.2.0",
        "has-symbols": "^1.1.0",
        "internal-slot": "^1.1.0",
        "regexp.prototype.flags": "^1.5.3",
        "set-function-name": "^2.0.2",
        "side-channel": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/string.prototype.trim": {
      "version": "1.2.10",
      "resolved": "https://registry.npmjs.org/string.prototype.trim/-/string.prototype.trim-1.2.10.tgz",
      "integrity": "sha512-Rs66F0P/1kedk5lyYyH9uBzuiI/kNRmwJAR9quK6VOtIpZ2G+hMZd+HQbbv25MgCA6gEffoMZYxlTod4WcdrKA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.2",
        "define-data-property": "^1.1.4",
        "define-properties": "^1.2.1",
        "es-abstract": "^1.23.5",
        "es-object-atoms": "^1.0.0",
        "has-property-descriptors": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/string.prototype.trimend": {
      "version": "1.0.9",
      "resolved": "https://registry.npmjs.org/string.prototype.trimend/-/string.prototype.trimend-1.0.9.tgz",
      "integrity": "sha512-G7Ok5C6E/j4SGfyLCloXTrngQIQU3PWtXGst3yM7Bea9FRURf1S42ZHlZZtsNque2FN2PoUhfZXYLNWwEr4dLQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.2",
        "define-properties": "^1.2.1",
        "es-object-atoms": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/string.prototype.trimstart": {
      "version": "1.0.8",
      "resolved": "https://registry.npmjs.org/string.prototype.trimstart/-/string.prototype.trimstart-1.0.8.tgz",
      "integrity": "sha512-UXSH262CSZY1tfu3G3Secr6uGLCFVPMhIqHjlgCUtCCcgihYc/xKs9djMTMUOb2j1mVSeU8EU6NWc/iQKU6Gfg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.7",
        "define-properties": "^1.2.1",
        "es-object-atoms": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/stringify-object": {
      "version": "3.3.0",
      "resolved": "https://registry.npmjs.org/stringify-object/-/stringify-object-3.3.0.tgz",
      "integrity": "sha512-rHqiFh1elqCQ9WPLIC8I0Q/g/wj5J1eMkyoiD6eoQApWHP0FtlK7rqnhmabL5VUY9JQCcqwwvlOaSuutekgyrw==",
      "dev": true,
      "license": "BSD-2-Clause",
      "dependencies": {
        "get-own-enumerable-property-symbols": "^3.0.0",
        "is-obj": "^1.0.1",
        "is-regexp": "^1.0.0"
      },
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/strip-comments": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/strip-comments/-/strip-comments-2.0.1.tgz",
      "integrity": "sha512-ZprKx+bBLXv067WTCALv8SSz5l2+XhpYCsVtSqlMnkAXMWDq+/ekVbl1ghqP9rUHTzv6sm/DwCOiYutU/yp1fw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/strip-json-comments": {
      "version": "3.1.1",
      "resolved": "https://registry.npmjs.org/strip-json-comments/-/strip-json-comments-3.1.1.tgz",
      "integrity": "sha512-6fPc+R4ihwqP6N/aIv2f1gMH8lOVtWQHoqC4yK6oSDVVocumAsfCqjkXnqiYMhmMwS/mEHLp7Vehlt3ql6lEig==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/supports-color": {
      "version": "7.2.0",
      "resolved": "https://registry.npmjs.org/supports-color/-/supports-color-7.2.0.tgz",
      "integrity": "sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "has-flag": "^4.0.0"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/supports-preserve-symlinks-flag": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/supports-preserve-symlinks-flag/-/supports-preserve-symlinks-flag-1.0.0.tgz",
      "integrity": "sha512-ot0WnXS9fgdkgIcePe6RHNk1WA8+muPa6cSjeR3V8K27q9BB1rTE3R1p7Hv0z1ZyAc8s6Vvv8DIyWf681MAt0w==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/tailwindcss": {
      "version": "4.2.1",
      "resolved": "https://registry.npmjs.org/tailwindcss/-/tailwindcss-4.2.1.tgz",
      "integrity": "sha512-/tBrSQ36vCleJkAOsy9kbNTgaxvGbyOamC30PRePTQe/o1MFwEKHQk4Cn7BNGaPtjp+PuUrByJehM1hgxfq4sw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/tapable": {
      "version": "2.3.3",
      "resolved": "https://registry.npmjs.org/tapable/-/tapable-2.3.3.tgz",
      "integrity": "sha512-uxc/zpqFg6x7C8vOE7lh6Lbda8eEL9zmVm/PLeTPBRhh1xCgdWaQ+J1CUieGpIfm2HdtsUpRv+HshiasBMcc6A==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/webpack"
      }
    },
    "node_modules/temp-dir": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/temp-dir/-/temp-dir-2.0.0.tgz",
      "integrity": "sha512-aoBAniQmmwtcKp/7BzsH8Cxzv8OL736p7v1ihGb5e9DJ9kTwGWHrQrVB5+lfVDzfGrdRzXch+ig7LHaY1JTOrg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/tempy": {
      "version": "0.6.0",
      "resolved": "https://registry.npmjs.org/tempy/-/tempy-0.6.0.tgz",
      "integrity": "sha512-G13vtMYPT/J8A4X2SjdtBTphZlrp1gKv6hZiOjw14RCWg6GbHuQBGtjlx75xLbYV/wEc0D7G5K4rxKP/cXk8Bw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "is-stream": "^2.0.0",
        "temp-dir": "^2.0.0",
        "type-fest": "^0.16.0",
        "unique-string": "^2.0.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/terser": {
      "version": "5.47.1",
      "resolved": "https://registry.npmjs.org/terser/-/terser-5.47.1.tgz",
      "integrity": "sha512-tPbLXTI6ohPASb/1YViL428oEHu6/qv1OxqYnfaonVCFHqx4+wCd95pHrQWsL5X4pl90CTyW9piSAsS2L0VoMw==",
      "dev": true,
      "license": "BSD-2-Clause",
      "dependencies": {
        "@jridgewell/source-map": "^0.3.3",
        "acorn": "^8.15.0",
        "commander": "^2.20.0",
        "source-map-support": "~0.5.20"
      },
      "bin": {
        "terser": "bin/terser"
      },
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/tiny-invariant": {
      "version": "1.3.3",
      "resolved": "https://registry.npmjs.org/tiny-invariant/-/tiny-invariant-1.3.3.tgz",
      "integrity": "sha512-+FbBPE1o9QAYvviau/qC5SE3caw21q3xkvWKBtja5vgqOWIHHJ3ioaq1VPfn/Szqctz2bU/oYeKd9/z5BL+PVg==",
      "license": "MIT"
    },
    "node_modules/tinyglobby": {
      "version": "0.2.17",
      "resolved": "https://registry.npmjs.org/tinyglobby/-/tinyglobby-0.2.17.tgz",
      "integrity": "sha512-wXR/dYpcqKmfWpEdZjiKJOwCNFndD0DMnrW/cYjVGttEkBfVgcLFHoNrlj47mjOVic9yyNu65alsgF4NQyTa2g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "fdir": "^6.5.0",
        "picomatch": "^4.0.4"
      },
      "engines": {
        "node": ">=12.0.0"
      },
      "funding": {
        "url": "https://github.com/sponsors/SuperchupuDev"
      }
    },
    "node_modules/tinyglobby/node_modules/fdir": {
      "version": "6.5.0",
      "resolved": "https://registry.npmjs.org/fdir/-/fdir-6.5.0.tgz",
      "integrity": "sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=12.0.0"
      },
      "peerDependencies": {
        "picomatch": "^3 || ^4"
      },
      "peerDependenciesMeta": {
        "picomatch": {
          "optional": true
        }
      }
    },
    "node_modules/tr46": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/tr46/-/tr46-1.0.1.tgz",
      "integrity": "sha512-dTpowEjclQ7Kgx5SdBkqRzVhERQXov8/l9Ft9dVM9fmg0W0KQSVaXX9T4i6twCPNtYiZM53lpSSUAwJbFPOHxA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "punycode": "^2.1.0"
      }
    },
    "node_modules/ts-api-utils": {
      "version": "2.5.0",
      "resolved": "https://registry.npmjs.org/ts-api-utils/-/ts-api-utils-2.5.0.tgz",
      "integrity": "sha512-OJ/ibxhPlqrMM0UiNHJ/0CKQkoKF243/AEmplt3qpRgkW8VG7IfOS41h7V8TjITqdByHzrjcS/2si+y4lIh8NA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18.12"
      },
      "peerDependencies": {
        "typescript": ">=4.8.4"
      }
    },
    "node_modules/tslib": {
      "version": "2.8.1",
      "resolved": "https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz",
      "integrity": "sha512-oJFu94HQb+KVduSUQL7wnpmqnfmLsOA/nAh6b6EH0wCEoK0/mPeXU6c3wKDV83MkOuHPRHtSXKKU99IBazS/2w==",
      "license": "0BSD"
    },
    "node_modules/type-check": {
      "version": "0.4.0",
      "resolved": "https://registry.npmjs.org/type-check/-/type-check-0.4.0.tgz",
      "integrity": "sha512-XleUoc9uwGXqjWwXaUTZAmzMcFZ5858QA2vvx1Ur5xIcixXIP+8LnFDgRplU30us6teqdlskFfu+ae4K79Ooew==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "prelude-ls": "^1.2.1"
      },
      "engines": {
        "node": ">= 0.8.0"
      }
    },
    "node_modules/type-fest": {
      "version": "0.16.0",
      "resolved": "https://registry.npmjs.org/type-fest/-/type-fest-0.16.0.tgz",
      "integrity": "sha512-eaBzG6MxNzEn9kiwvtre90cXaNLkmadMWa1zQMs3XORCXNbsH/OewwbxC5ia9dCxIxnTAsSxXJaa/p5y8DlvJg==",
      "dev": true,
      "license": "(MIT OR CC0-1.0)",
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/typed-array-buffer": {
      "version": "1.0.3",
      "resolved": "https://registry.npmjs.org/typed-array-buffer/-/typed-array-buffer-1.0.3.tgz",
      "integrity": "sha512-nAYYwfY3qnzX30IkA6AQZjVbtK6duGontcQm1WSG1MD94YLqK0515GNApXkoxKOWMusVssAHWLh9SeaoefYFGw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "es-errors": "^1.3.0",
        "is-typed-array": "^1.1.14"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/typed-array-byte-length": {
      "version": "1.0.3",
      "resolved": "https://registry.npmjs.org/typed-array-byte-length/-/typed-array-byte-length-1.0.3.tgz",
      "integrity": "sha512-BaXgOuIxz8n8pIq3e7Atg/7s+DpiYrxn4vdot3w9KbnBhcRQq6o3xemQdIfynqSeXeDrF32x+WvfzmOjPiY9lg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.8",
        "for-each": "^0.3.3",
        "gopd": "^1.2.0",
        "has-proto": "^1.2.0",
        "is-typed-array": "^1.1.14"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/typed-array-byte-offset": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/typed-array-byte-offset/-/typed-array-byte-offset-1.0.4.tgz",
      "integrity": "sha512-bTlAFB/FBYMcuX81gbL4OcpH5PmlFHqlCCpAl8AlEzMz5k53oNDvN8p1PNOWLEmI2x4orp3raOFB51tv9X+MFQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "available-typed-arrays": "^1.0.7",
        "call-bind": "^1.0.8",
        "for-each": "^0.3.3",
        "gopd": "^1.2.0",
        "has-proto": "^1.2.0",
        "is-typed-array": "^1.1.15",
        "reflect.getprototypeof": "^1.0.9"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/typed-array-length": {
      "version": "1.0.7",
      "resolved": "https://registry.npmjs.org/typed-array-length/-/typed-array-length-1.0.7.tgz",
      "integrity": "sha512-3KS2b+kL7fsuk/eJZ7EQdnEmQoaho/r6KUef7hxvltNA5DR8NAUM+8wJMbJyZ4G9/7i3v5zPBIMN5aybAh2/Jg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bind": "^1.0.7",
        "for-each": "^0.3.3",
        "gopd": "^1.0.1",
        "is-typed-array": "^1.1.13",
        "possible-typed-array-names": "^1.0.0",
        "reflect.getprototypeof": "^1.0.6"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/typescript": {
      "version": "5.9.3",
      "resolved": "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz",
      "integrity": "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
      "dev": true,
      "license": "Apache-2.0",
      "bin": {
        "tsc": "bin/tsc",
        "tsserver": "bin/tsserver"
      },
      "engines": {
        "node": ">=14.17"
      }
    },
    "node_modules/typescript-eslint": {
      "version": "8.59.3",
      "resolved": "https://registry.npmjs.org/typescript-eslint/-/typescript-eslint-8.59.3.tgz",
      "integrity": "sha512-KgusgyDgG4LI8Ih/sWaCtZ06tckLAS5CvT5A4D1Q7bYVoAAyzwiZvE4BmwDHkhRVkvhRBepKeASoFzQetha7Fg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@typescript-eslint/eslint-plugin": "8.59.3",
        "@typescript-eslint/parser": "8.59.3",
        "@typescript-eslint/typescript-estree": "8.59.3",
        "@typescript-eslint/utils": "8.59.3"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/typescript-eslint"
      },
      "peerDependencies": {
        "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0",
        "typescript": ">=4.8.4 <6.1.0"
      }
    },
    "node_modules/unbox-primitive": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/unbox-primitive/-/unbox-primitive-1.1.0.tgz",
      "integrity": "sha512-nWJ91DjeOkej/TA8pXQ3myruKpKEYgqvpw9lz4OPHj/NWFNluYrjbz9j01CJ8yKQd2g4jFoOkINCTW2I5LEEyw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.3",
        "has-bigints": "^1.0.2",
        "has-symbols": "^1.1.0",
        "which-boxed-primitive": "^1.1.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/undici-types": {
      "version": "6.21.0",
      "resolved": "https://registry.npmjs.org/undici-types/-/undici-types-6.21.0.tgz",
      "integrity": "sha512-iwDZqg0QAGrg9Rav5H4n0M64c3mkR59cJ6wQp+7C4nI0gsmExaedaYLNO44eT4AtBBwjbTiGPMlt2Md0T9H9JQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/unicode-canonical-property-names-ecmascript": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/unicode-canonical-property-names-ecmascript/-/unicode-canonical-property-names-ecmascript-2.0.1.tgz",
      "integrity": "sha512-dA8WbNeb2a6oQzAQ55YlT5vQAWGV9WXOsi3SskE3bcCdM0P4SDd+24zS/OCacdRq5BkdsRj9q3Pg6YyQoxIGqg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/unicode-match-property-ecmascript": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/unicode-match-property-ecmascript/-/unicode-match-property-ecmascript-2.0.0.tgz",
      "integrity": "sha512-5kaZCrbp5mmbz5ulBkDkbY0SsPOjKqVS35VpL9ulMPfSl0J0Xsm+9Evphv9CoIZFwre7aJoa94AY6seMKGVN5Q==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "unicode-canonical-property-names-ecmascript": "^2.0.0",
        "unicode-property-aliases-ecmascript": "^2.0.0"
      },
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/unicode-match-property-value-ecmascript": {
      "version": "2.2.1",
      "resolved": "https://registry.npmjs.org/unicode-match-property-value-ecmascript/-/unicode-match-property-value-ecmascript-2.2.1.tgz",
      "integrity": "sha512-JQ84qTuMg4nVkx8ga4A16a1epI9H6uTXAknqxkGF/aFfRLw1xC/Bp24HNLaZhHSkWd3+84t8iXnp1J0kYcZHhg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/unicode-property-aliases-ecmascript": {
      "version": "2.2.0",
      "resolved": "https://registry.npmjs.org/unicode-property-aliases-ecmascript/-/unicode-property-aliases-ecmascript-2.2.0.tgz",
      "integrity": "sha512-hpbDzxUY9BFwX+UeBnxv3Sh1q7HFxj48DTmXchNgRa46lO8uj3/1iEn3MiNUYTg1g9ctIqXCCERn8gYZhHC5lQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/unique-string": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/unique-string/-/unique-string-2.0.0.tgz",
      "integrity": "sha512-uNaeirEPvpZWSgzwsPGtU2zVSTrn/8L5q/IexZmH0eH6SA73CmAA5U4GwORTxQAZs95TAXLNqeLoPPNO5gZfWg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "crypto-random-string": "^2.0.0"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/universalify": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/universalify/-/universalify-2.0.1.tgz",
      "integrity": "sha512-gptHNQghINnc/vTGIk0SOFGFNXw7JVrlRUtConJRlvaw6DuX0wO5Jeko9sWrMBhh+PsYAZ7oXAiOnf/UKogyiw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 10.0.0"
      }
    },
    "node_modules/upath": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/upath/-/upath-1.2.0.tgz",
      "integrity": "sha512-aZwGpamFO61g3OlfT7OQCHqhGnW43ieH9WZeP7QxN/G/jS4jfqUkZxoryvJgVPEcrl5NL/ggHsSmLMHuH64Lhg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=4",
        "yarn": "*"
      }
    },
    "node_modules/update-browserslist-db": {
      "version": "1.3.3",
      "resolved": "https://registry.npmjs.org/update-browserslist-db/-/update-browserslist-db-1.3.3.tgz",
      "integrity": "sha512-pJ2sYawQS0R/WI928Gj5GlPhTGzbMelq0+4INtSYNDV9ErKJcX6xjGWkoG/VnB3dpUm00zALaqkrUD77pO5TDQ==",
      "dev": true,
      "funding": [
        {
          "type": "opencollective",
          "url": "https://opencollective.com/browserslist"
        },
        {
          "type": "tidelift",
          "url": "https://tidelift.com/funding/github/npm/browserslist"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "escalade": "^3.2.0",
        "picocolors": "^1.1.1"
      },
      "bin": {
        "update-browserslist-db": "cli.js"
      },
      "peerDependencies": {
        "browserslist": ">= 4.21.0"
      }
    },
    "node_modules/uri-js": {
      "version": "4.4.1",
      "resolved": "https://registry.npmjs.org/uri-js/-/uri-js-4.4.1.tgz",
      "integrity": "sha512-7rKUyy33Q1yc98pQ1DAmLtwX109F7TIfWlW1Ydo8Wl1ii1SeHieeh0HHfPeL2fMXK6z0s8ecKs9frCuLJvndBg==",
      "dev": true,
      "license": "BSD-2-Clause",
      "dependencies": {
        "punycode": "^2.1.0"
      }
    },
    "node_modules/use-sync-external-store": {
      "version": "1.6.0",
      "resolved": "https://registry.npmjs.org/use-sync-external-store/-/use-sync-external-store-1.6.0.tgz",
      "integrity": "sha512-Pp6GSwGP/NrPIrxVFAIkOQeyw8lFenOHijQWkUTrDvrF4ALqylP2C/KCkeS9dpUM3KvYRQhna5vt7IL95+ZQ9w==",
      "license": "MIT",
      "peerDependencies": {
        "react": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0"
      }
    },
    "node_modules/victory-vendor": {
      "version": "37.3.6",
      "resolved": "https://registry.npmjs.org/victory-vendor/-/victory-vendor-37.3.6.tgz",
      "integrity": "sha512-SbPDPdDBYp+5MJHhBCAyI7wKM3d5ivekigc2Dk2s7pgbZ9wIgIBYGVw4zGHBml/qTFbexrofXW6Gu4noGxrOwQ==",
      "license": "MIT AND ISC",
      "dependencies": {
        "@types/d3-array": "^3.0.3",
        "@types/d3-ease": "^3.0.0",
        "@types/d3-interpolate": "^3.0.1",
        "@types/d3-scale": "^4.0.2",
        "@types/d3-shape": "^3.1.0",
        "@types/d3-time": "^3.0.0",
        "@types/d3-timer": "^3.0.0",
        "d3-array": "^3.1.6",
        "d3-ease": "^3.0.1",
        "d3-interpolate": "^3.0.1",
        "d3-scale": "^4.0.2",
        "d3-shape": "^3.1.0",
        "d3-time": "^3.0.0",
        "d3-timer": "^3.0.1"
      }
    },
    "node_modules/vite": {
      "version": "8.3.1",
      "resolved": "https://registry.npmjs.org/vite/-/vite-8.3.1.tgz",
      "integrity": "sha512-/bvH9E9tmCXRGp2uXY3WbOldqpTwFkbha/8ANaEQ6VkxhH60KyqLwgZq6lG2y+4uT55x9+9eUHMpQ7uGnOCKjA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "lightningcss": "^1.33.0",
        "picomatch": "^4.0.7",
        "postcss": "^8.5.28",
        "rolldown": "~1.2.9",
        "tinyglobby": "^0.2.17"
      },
      "bin": {
        "vite": "bin/vite.js"
      },
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      },
      "funding": {
        "url": "https://github.com/vitejs/vite?sponsor=1"
      },
      "optionalDependencies": {
        "fsevents": "~2.3.3"
      },
      "peerDependencies": {
        "@types/node": "^20.19.0 || >=22.12.0",
        "@vitejs/devtools": "^0.7.1",
        "esbuild": "^0.27.0 || ^0.28.0",
        "jiti": ">=1.21.0",
        "less": "^4.0.0",
        "sass": "^1.70.0",
        "sass-embedded": "^1.70.0",
        "stylus": ">=0.54.8",
        "sugarss": "^5.0.0",
        "terser": "^5.16.0",
        "tsx": "^4.8.1",
        "yaml": "^2.4.2"
      },
      "peerDependenciesMeta": {
        "@types/node": {
          "optional": true
        },
        "@vitejs/devtools": {
          "optional": true
        },
        "esbuild": {
          "optional": true
        },
        "jiti": {
          "optional": true
        },
        "less": {
          "optional": true
        },
        "sass": {
          "optional": true
        },
        "sass-embedded": {
          "optional": true
        },
        "stylus": {
          "optional": true
        },
        "sugarss": {
          "optional": true
        },
        "terser": {
          "optional": true
        },
        "tsx": {
          "optional": true
        },
        "yaml": {
          "optional": true
        }
      }
    },
    "node_modules/vite-plugin-pwa": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/vite-plugin-pwa/-/vite-plugin-pwa-1.3.0.tgz",
      "integrity": "sha512-c5kMgN+ITrOtHXp8PAtk2uOIEea6XjP/unCGxOWWBzQ6qa65qj/awHg0wf+QF9E/2u9vh86LqxPwzEPNbM2r5A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "debug": "^4.3.6",
        "pretty-bytes": "^6.1.1",
        "tinyglobby": "^0.2.10",
        "workbox-build": "^7.4.1",
        "workbox-window": "^7.4.1"
      },
      "engines": {
        "node": ">=16.0.0"
      },
      "funding": {
        "url": "https://github.com/sponsors/antfu"
      },
      "peerDependencies": {
        "@vite-pwa/assets-generator": "^1.0.0",
        "vite": "^3.1.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0",
        "workbox-build": "^7.4.1",
        "workbox-window": "^7.4.1"
      },
      "peerDependenciesMeta": {
        "@vite-pwa/assets-generator": {
          "optional": true
        }
      }
    },
    "node_modules/webidl-conversions": {
      "version": "4.0.2",
      "resolved": "https://registry.npmjs.org/webidl-conversions/-/webidl-conversions-4.0.2.tgz",
      "integrity": "sha512-YQ+BmxuTgd6UXZW3+ICGfyqRyHXVlD5GtQr5+qjiNW7bF0cqrzX500HVXPBOvgXb5YnzDd+h0zqyv61KUD7+Sg==",
      "dev": true,
      "license": "BSD-2-Clause"
    },
    "node_modules/whatwg-url": {
      "version": "7.1.0",
      "resolved": "https://registry.npmjs.org/whatwg-url/-/whatwg-url-7.1.0.tgz",
      "integrity": "sha512-WUu7Rg1DroM7oQvGWfOiAK21n74Gg+T4elXEQYkOhtyLeWiJFoOGLXPKI/9gzIie9CtwVLm8wtw6YJdKyxSjeg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "lodash.sortby": "^4.7.0",
        "tr46": "^1.0.1",
        "webidl-conversions": "^4.0.2"
      }
    },
    "node_modules/which": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/which/-/which-2.0.2.tgz",
      "integrity": "sha512-BLI3Tl1TW3Pvl70l3yq3Y64i+awpwXqsGBYWkkqMtnbXgrMD+yj7rhW0kuEDxzJaYXGjEW5ogapKNMEKNMjibA==",
      "dev": true,
      "license": "ISC",
      "dependencies": {
        "isexe": "^2.0.0"
      },
      "bin": {
        "node-which": "bin/node-which"
      },
      "engines": {
        "node": ">= 8"
      }
    },
    "node_modules/which-boxed-primitive": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/which-boxed-primitive/-/which-boxed-primitive-1.1.1.tgz",
      "integrity": "sha512-TbX3mj8n0odCBFVlY8AxkqcHASw3L60jIuF8jFP78az3C2YhmGvqbHBpAjTRH2/xqYunrJ9g1jSyjCjpoWzIAA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "is-bigint": "^1.1.0",
        "is-boolean-object": "^1.2.1",
        "is-number-object": "^1.1.1",
        "is-string": "^1.1.1",
        "is-symbol": "^1.1.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/which-builtin-type": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/which-builtin-type/-/which-builtin-type-1.2.1.tgz",
      "integrity": "sha512-6iBczoX+kDQ7a3+YJBnh3T+KZRxM/iYNPXicqk66/Qfm1b93iu+yOImkg0zHbj5LNOcNv1TEADiZ0xa34B4q6Q==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "function.prototype.name": "^1.1.6",
        "has-tostringtag": "^1.0.2",
        "is-async-function": "^2.0.0",
        "is-date-object": "^1.1.0",
        "is-finalizationregistry": "^1.1.0",
        "is-generator-function": "^1.0.10",
        "is-regex": "^1.2.1",
        "is-weakref": "^1.0.2",
        "isarray": "^2.0.5",
        "which-boxed-primitive": "^1.1.0",
        "which-collection": "^1.0.2",
        "which-typed-array": "^1.1.16"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/which-collection": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/which-collection/-/which-collection-1.0.2.tgz",
      "integrity": "sha512-K4jVyjnBdgvc86Y6BkaLZEN933SwYOuBFkdmBu9ZfkcAbdVbpITnDmjvZ/aQjRXQrv5EPkTnD1s39GiiqbngCw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "is-map": "^2.0.3",
        "is-set": "^2.0.3",
        "is-weakmap": "^2.0.2",
        "is-weakset": "^2.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/which-typed-array": {
      "version": "1.1.20",
      "resolved": "https://registry.npmjs.org/which-typed-array/-/which-typed-array-1.1.20.tgz",
      "integrity": "sha512-LYfpUkmqwl0h9A2HL09Mms427Q1RZWuOHsukfVcKRq9q95iQxdw0ix1JQrqbcDR9PH1QDwf5Qo8OZb5lksZ8Xg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "available-typed-arrays": "^1.0.7",
        "call-bind": "^1.0.8",
        "call-bound": "^1.0.4",
        "for-each": "^0.3.5",
        "get-proto": "^1.0.1",
        "gopd": "^1.2.0",
        "has-tostringtag": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/word-wrap": {
      "version": "1.2.5",
      "resolved": "https://registry.npmjs.org/word-wrap/-/word-wrap-1.2.5.tgz",
      "integrity": "sha512-BN22B5eaMMI9UMtjrGd5g5eCYPpCPDUy0FJXbYsaT5zYxjFOckS53SQDE3pWkVoWpHXVb3BrYcEN4Twa55B5cA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/workbox-background-sync": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-background-sync/-/workbox-background-sync-7.4.1.tgz",
      "integrity": "sha512-HhT7KE8tOWDm02wRNshXUnUPofMlhenF2DBdUnDPOubhizzPeItkYTmAB6td1Z2cjYPa98vzEiPLEuzn5hN66g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "idb": "^7.0.1",
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-background-sync/node_modules/idb": {
      "version": "7.1.1",
      "resolved": "https://registry.npmjs.org/idb/-/idb-7.1.1.tgz",
      "integrity": "sha512-gchesWBzyvGHRO9W8tzUWFDycow5gwjvFKfyV9FF32Y7F50yZMp7mP+T2mJIWFx49zicqyC4uefHM17o6xKIVQ==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/workbox-broadcast-update": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-broadcast-update/-/workbox-broadcast-update-7.4.1.tgz",
      "integrity": "sha512-uAlgslKLvbQY+suirIdnBCSYrcgBhjp81Nj4l1lj/Jmj0MJO2CJERnCJjT0GFVwmReV0N+zs78K6gqd5gr9/+A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-build": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-build/-/workbox-build-7.4.1.tgz",
      "integrity": "sha512-SDhxIvEAde9Gy/5w4Yo1Jh/M49Z0qE3q0oteyE8zGq0DScxFqVBcCtIXFuLtmtxRQZCMbf0prco4VyEu3KBQuw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@apideck/better-ajv-errors": "^0.3.1",
        "@babel/core": "^7.24.4",
        "@babel/preset-env": "^7.11.0",
        "@babel/runtime": "^7.11.2",
        "@rollup/plugin-babel": "^6.1.0",
        "@rollup/plugin-node-resolve": "^16.0.3",
        "@rollup/plugin-replace": "^6.0.3",
        "@rollup/plugin-terser": "^1.0.0",
        "@trickfilm400/rollup-plugin-off-main-thread": "^3.0.0-pre1",
        "ajv": "^8.6.0",
        "common-tags": "^1.8.0",
        "eta": "^4.5.1",
        "fast-json-stable-stringify": "^2.1.0",
        "fs-extra": "^9.0.1",
        "glob": "^11.0.1",
        "pretty-bytes": "^5.3.0",
        "rollup": "^4.53.3",
        "source-map": "^0.8.0-beta.0",
        "stringify-object": "^3.3.0",
        "strip-comments": "^2.0.1",
        "tempy": "^0.6.0",
        "upath": "^1.2.0",
        "workbox-background-sync": "7.4.1",
        "workbox-broadcast-update": "7.4.1",
        "workbox-cacheable-response": "7.4.1",
        "workbox-core": "7.4.1",
        "workbox-expiration": "7.4.1",
        "workbox-google-analytics": "7.4.1",
        "workbox-navigation-preload": "7.4.1",
        "workbox-precaching": "7.4.1",
        "workbox-range-requests": "7.4.1",
        "workbox-recipes": "7.4.1",
        "workbox-routing": "7.4.1",
        "workbox-strategies": "7.4.1",
        "workbox-streams": "7.4.1",
        "workbox-sw": "7.4.1",
        "workbox-window": "7.4.1"
      },
      "engines": {
        "node": ">=20.0.0"
      }
    },
    "node_modules/workbox-build/node_modules/@apideck/better-ajv-errors": {
      "version": "0.3.7",
      "resolved": "https://registry.npmjs.org/@apideck/better-ajv-errors/-/better-ajv-errors-0.3.7.tgz",
      "integrity": "sha512-TajUJwGWbDwkCx/CZi7tRE8PVB7simCvKJfHUsSdvps+aTM/PDPP4gkLmKnc+x3CE//y9i/nj74GqdL/hwk7Iw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "jsonpointer": "^5.0.1",
        "leven": "^3.1.0"
      },
      "engines": {
        "node": ">=10"
      },
      "peerDependencies": {
        "ajv": ">=8"
      }
    },
    "node_modules/workbox-build/node_modules/ajv": {
      "version": "8.20.0",
      "resolved": "https://registry.npmjs.org/ajv/-/ajv-8.20.0.tgz",
      "integrity": "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "fast-deep-equal": "^3.1.3",
        "fast-uri": "^3.0.1",
        "json-schema-traverse": "^1.0.0",
        "require-from-string": "^2.0.2"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/epoberezkin"
      }
    },
    "node_modules/workbox-build/node_modules/json-schema-traverse": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz",
      "integrity": "sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/workbox-build/node_modules/pretty-bytes": {
      "version": "5.6.0",
      "resolved": "https://registry.npmjs.org/pretty-bytes/-/pretty-bytes-5.6.0.tgz",
      "integrity": "sha512-FFw039TmrBqFK8ma/7OL3sDz/VytdtJr044/QUJtH0wK9lb9jLq9tJyIxUwtQJHwar2BqtiA4iCWSwo9JLkzFg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/workbox-build/node_modules/source-map": {
      "version": "0.8.0-beta.0",
      "resolved": "https://registry.npmjs.org/source-map/-/source-map-0.8.0-beta.0.tgz",
      "integrity": "sha512-2ymg6oRBpebeZi9UUNsgQ89bhx01TcTkmNTGnNO88imTmbSgy4nfujrgVEFKWpMTEGA11EDkTt7mqObTPdigIA==",
      "deprecated": "The work that was done in this beta branch won't be included in future versions",
      "dev": true,
      "license": "BSD-3-Clause",
      "dependencies": {
        "whatwg-url": "^7.0.0"
      },
      "engines": {
        "node": ">= 8"
      }
    },
    "node_modules/workbox-cacheable-response": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-cacheable-response/-/workbox-cacheable-response-7.4.1.tgz",
      "integrity": "sha512-8xaFoJdDc2OjrlbbL3gEeBO1WKcMwRqwLRupgqahYXu75yXajPLuwrbXMrIGZuWYXrQwk0xDjOxZ/ujCy/oJYw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-core": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-core/-/workbox-core-7.4.1.tgz",
      "integrity": "sha512-DT+vu46eh/2vRsSHTY4Xmc32Z1rr9PRlQUXr1Dx30ZuXRWwOsvZgGgcwxcasubQLQmbTNYZjv44LkBAQ4tT5tQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/workbox-expiration": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-expiration/-/workbox-expiration-7.4.1.tgz",
      "integrity": "sha512-lRKUF7b+OGbeXkQk1s6MHXOa3d7Xxf7Of31W6c6hCfipfIyrtdWZ89stq21AHZMaoG7VNFoHply4Ox+rU31TWg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "idb": "^7.0.1",
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-expiration/node_modules/idb": {
      "version": "7.1.1",
      "resolved": "https://registry.npmjs.org/idb/-/idb-7.1.1.tgz",
      "integrity": "sha512-gchesWBzyvGHRO9W8tzUWFDycow5gwjvFKfyV9FF32Y7F50yZMp7mP+T2mJIWFx49zicqyC4uefHM17o6xKIVQ==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/workbox-google-analytics": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-google-analytics/-/workbox-google-analytics-7.4.1.tgz",
      "integrity": "sha512-Mks1JwLEt++ZAkF6sS1OpSh9RtAMIsiDgRpK+codiHGIPXeaUOgi4cPc3GFadUl8V5QPeypEk8Oxgl3HlwVzHw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-background-sync": "7.4.1",
        "workbox-core": "7.4.1",
        "workbox-routing": "7.4.1",
        "workbox-strategies": "7.4.1"
      }
    },
    "node_modules/workbox-navigation-preload": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-navigation-preload/-/workbox-navigation-preload-7.4.1.tgz",
      "integrity": "sha512-C4KVsjPcYKJOhr631AxR9XoG2rLF3QiTk5aMv36MXOjtWvm8axwNFAtKUPGsWUwLXXAMgYM1En7fsvndaXeXRQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-precaching": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-precaching/-/workbox-precaching-7.4.1.tgz",
      "integrity": "sha512-cdr/9qByww7yzEp7zg/qI4ukUrrNjQLgN+ONQRpjy/VqGQXwkgHwr00KksGJK8v0VifwDXBb8a4cWNZH71jn3Q==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1",
        "workbox-routing": "7.4.1",
        "workbox-strategies": "7.4.1"
      }
    },
    "node_modules/workbox-range-requests": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-range-requests/-/workbox-range-requests-7.4.1.tgz",
      "integrity": "sha512-7i2oxAUE82gHdAJBCAQ04JzNOdRPqzuOzGfoUyJpFSmeqBNYGPrAH8GPoPjUQTfp+NycwrD2H68VtuF8qxv0vQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-recipes": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-recipes/-/workbox-recipes-7.4.1.tgz",
      "integrity": "sha512-gnbVfmV4/TtmQaM4x9AtuXhcdstJsep3XMVeztOrQVPT+R6+6DeBjGTCQ7fFCXm+4GEHUA5VEBTyi5+4gWGeog==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-cacheable-response": "7.4.1",
        "workbox-core": "7.4.1",
        "workbox-expiration": "7.4.1",
        "workbox-precaching": "7.4.1",
        "workbox-routing": "7.4.1",
        "workbox-strategies": "7.4.1"
      }
    },
    "node_modules/workbox-routing": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-routing/-/workbox-routing-7.4.1.tgz",
      "integrity": "sha512-yubJGErZOusuidAenaL5ypfhQOa7urxP/f8E0ws7FPb4039RiWXUWBAyUkmUoOL/BcQGen3h0J8872d51IYxtA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-strategies": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-strategies/-/workbox-strategies-7.4.1.tgz",
      "integrity": "sha512-GZxpaw9NbmOelj7667uZ2kpk5BFpOGbO4X0qjwh5ls8XQ8C+Lha5LQchTiUzsTFSS+NlUpftYAyOVXvQUrcqOQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/workbox-streams": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-streams/-/workbox-streams-7.4.1.tgz",
      "integrity": "sha512-HWWtraKUbJknd9kgqGcpQ3G114HOPYvqs8HaJMDs2ebLNAimDkVDaWfAXE6Ybl+m8U6KsCE6pWyLYuigWmnAXw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "workbox-core": "7.4.1",
        "workbox-routing": "7.4.1"
      }
    },
    "node_modules/workbox-sw": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-sw/-/workbox-sw-7.4.1.tgz",
      "integrity": "sha512-fez5f2DUlDJWTFYkCWQpY10N8gtztd849NswCbVFk0QlcSM4HT5A8x4g4ii650yem4I8tHY0R7JZahwp3ltIPw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/workbox-window": {
      "version": "7.4.1",
      "resolved": "https://registry.npmjs.org/workbox-window/-/workbox-window-7.4.1.tgz",
      "integrity": "sha512-notZDH2u8VXaqyuD7xaqIfEFi6SRM4SUSd7ewe9PDsVqADuepxX2ZMY3uvuZGxzY5ZOsGC/vD3A/3smFtJt4/A==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@types/trusted-types": "^2.0.2",
        "workbox-core": "7.4.1"
      }
    },
    "node_modules/xtend": {
      "version": "4.0.2",
      "resolved": "https://registry.npmjs.org/xtend/-/xtend-4.0.2.tgz",
      "integrity": "sha512-LKYU1iAXJXUgAXn9URjiu+MWhyUXHsvfp7mcuYm9dSUKK0/CjtrUwFAxD82/mCWbtLsGjFIad0wIsod4zrTAEQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=0.4"
      }
    },
    "node_modules/yallist": {
      "version": "3.1.1",
      "resolved": "https://registry.npmjs.org/yallist/-/yallist-3.1.1.tgz",
      "integrity": "sha512-a4UGQaWPH59mOXUYnAG2ewncQS4i4F43Tv3JoAM+s2VDAmS9NsK8GpDMLrCHPksFT7h3K6TOoUNn2pb7RoXx4g==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/yocto-queue": {
      "version": "0.1.0",
      "resolved": "https://registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz",
      "integrity": "sha512-rVksvsnNCdJ/ohGc6xgPwyN8eheCxsiLM8mxuE/t/mOVqJewPuO1miLpTHQiRgTKCLexL4MeAFVagts7HmNZ2Q==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/zod": {
      "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz",
      "integrity": "sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==",
      "dev": true,
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/colinhacks"
      }
    },
    "node_modules/zod-validation-error": {
      "version": "4.0.2",
      "resolved": "https://registry.npmjs.org/zod-validation-error/-/zod-validation-error-4.0.2.tgz",
      "integrity": "sha512-Q6/nZLe6jxuU80qb/4uJ4t5v2VEZ44lzQjPDhYJNztRQ4wyWc6VF3D3Kb/fAuPetZQnhS3hnajCf9CsWesghLQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18.0.0"
      },
      "peerDependencies": {
        "zod": "^3.25.0 || ^4.0.0"
      }
    }
  }
}

````

## index.html

<!-- source: index.html sha256: 7b2b1a35afe6155275345f90d0cd78bda362ef01fca05ac9370ed94348c40ec0 encoding: utf8 -->
````html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0A84FF" />
    <meta name="description" content="记录你的旅行、消费与日常瞬间" />
    <meta property="og:title" content="Life Tracker · 生活记录" />
    <meta property="og:description" content="把旅行、消费与日常片段，好好收在一起。" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://sherlockzang.github.io/life-tracker-pwa/" />
    <meta property="og:image" content="https://sherlockzang.github.io/life-tracker-pwa/life-tracker-logo-v112.png" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1024" />
    <meta property="og:image:height" content="1024" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="Life Tracker · 生活记录" />
    <meta name="twitter:description" content="把旅行、消费与日常片段，好好收在一起。" />
    <meta name="twitter:image" content="https://sherlockzang.github.io/life-tracker-pwa/life-tracker-logo-v112.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Life Tracker" />
    <link rel="icon" type="image/png" sizes="192x192" href="/life-tracker-pwa/pwa-192x192-v112.png" />
    <link rel="shortcut icon" type="image/png" href="/life-tracker-pwa/pwa-192x192-v112.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/life-tracker-pwa/apple-touch-icon-v112.png" />
    <link rel="apple-touch-icon-precomposed" sizes="180x180" href="/life-tracker-pwa/apple-touch-icon-v112.png" />
    <title>Life Tracker · 生活记录</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>

````

## vite.config.ts

<!-- source: vite.config.ts sha256: 3f7e1247e97b6359bbf9d180d00a78c519a8745f7fd354e71f5d96df971a1e29 encoding: utf8 -->
````typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/life-tracker-pwa/",
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["life-tracker-logo-v112.png", "apple-touch-icon-v112.png", "pwa-192x192-v112.png", "pwa-512x512-v112.png"],
      manifest: {
        name: "Life Tracker",
        short_name: "Life Tracker",
        description: "记录你的旅行、消费与日常瞬间",
        theme_color: "#0A84FF",
        background_color: "#F5F5F7",
        display: "standalone",
        start_url: "/life-tracker-pwa/",
        scope: "/life-tracker-pwa/",
        lang: "zh-CN",
        icons: [
          { src: "pwa-192x192-v112.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512-v112.png", sizes: "512x512", type: "image/png", purpose: "any" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,woff2}"],
        globIgnores: ["**/og.png"],
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.frankfurter\.dev\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "exchange-rates",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 30, maxAgeSeconds: 7 * 24 * 60 * 60 }
            }
          }
        ]
      }
    })
  ]
});

````

## eslint.config.mjs

<!-- source: eslint.config.mjs sha256: 2bf309618933d1e2065b345a2051427b30cf83e887b7d76529a2693bdd69c991 encoding: utf8 -->
````javascript
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "work", "outputs"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);

````

## tsconfig.json

<!-- source: tsconfig.json sha256: 770b4140bbb581e2dfd9ea9946ffc9c75a1d86ba7d2db5f77c83e37cbdf9d808 encoding: utf8 -->
````json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}

````

## tsconfig.app.json

<!-- source: tsconfig.app.json sha256: b3f6cfcf3345002bb46088fd4d2c6276cd465578cf7151e6910536646e0c7c88 encoding: utf8 -->
````json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vite/client", "vite-plugin-pwa/client"]
  },
  "include": ["src"]
}

````

## tsconfig.node.json

<!-- source: tsconfig.node.json sha256: 3dc28b63563e20fab0d9f652f3039ed50e6c46bbdec66631a14822e8309b230d encoding: utf8 -->
````json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}

````

## supabase/config.toml

<!-- source: supabase/config.toml sha256: cfef4cca22d498a4996c340d8da8235fb97334be0c4f105e242bdba9cea22d6b encoding: utf8 -->
````toml
project_id = "ihqkgtmikwdakhyglels"

[functions.query-transit-route]
verify_jwt = true

[functions.lookup-flight]
verify_jwt = true

[functions.deepseek-assist]
verify_jwt = false

[functions.start-demo-session]
verify_jwt = false

[functions.redeem-invite]
verify_jwt = true

[functions.get-api-quota]
verify_jwt = true

[functions.owner-admin]
verify_jwt = true

````

## supabase/.env.example

<!-- source: supabase/.env.example sha256: aa2ac735be18636e63e233e842676c5c13ee579b8f9393caf787e0469f5ffae7 encoding: utf8 -->
````text
# Server-side only. Never rename this to a VITE_* variable.
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
AVIATIONSTACK_API_KEY=your-aviationstack-api-key

````
