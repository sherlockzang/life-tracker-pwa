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
