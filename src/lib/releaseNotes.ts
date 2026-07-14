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

const BUNDLED_RELEASES: Changelog[] = [
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
