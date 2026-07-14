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
