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
