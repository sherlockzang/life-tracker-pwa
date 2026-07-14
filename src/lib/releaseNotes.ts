import type { Changelog } from "../types";

const RELEASE_1_2_0_SUMMARY = [
  "行程规划新增飞机、铁路和市内交通三类结构化模板。飞机可记录航司、航班号、出发与到达日期时间、机场、航站楼、登机口、座位和机型；铁路可记录铁路系统、车次、车站与座席；市内交通可记录起终点、预计时间和路线说明。",
  "交通计划拥有更清晰的智能摘要：时间线会自动提炼航班号、车次、站点与时间；保存后仍可快速更新登机口，也可以在抵达后补记实际乘车路线。",
  "DeepSeek API 配置完成后，可在“行程规划 → 市内交通”中填写起点、终点和预计时间，再点击“AI 查询路线”。检查并编辑返回的线路、换乘、预计用时与票价参考后，点击“填入路线”并保存；AI 结果不会自动写入记录，查询不可用时仍可手动填写。",
  "设置页新增永久“使用说明”，并新增长期保留的致谢栏目。",
  "优化 iPhone 17 Pro 灵动岛安全区域、桌面 PWA 显示与部分移动端交互。"
];

export function mergeBundledReleaseNotes(changelogs: Changelog[]) {
  return changelogs.map((release) => release.version === "1.2.0"
    ? { ...release, summary: RELEASE_1_2_0_SUMMARY }
    : release);
}
