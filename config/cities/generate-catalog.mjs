// 城市目录种子生成器（TASK-00B）
// 输入：modood/Administrative-divisions-of-China 的 dist/cities.json（GB/T 2260 地级行政区划，仅元数据）
// 输出：city-catalog.json —— 仅供 D1 cities 表播种；不含任何房价/小区数据
// 用法：node generate-catalog.mjs <输入文件路径>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('用法: node generate-catalog.mjs <cities.json>');
  process.exit(1);
}

const PROVINCES = {
  11: '北京市', 12: '天津市', 13: '河北省', 14: '山西省', 15: '内蒙古自治区',
  21: '辽宁省', 22: '吉林省', 23: '黑龙江省', 31: '上海市', 32: '江苏省',
  33: '浙江省', 34: '安徽省', 35: '福建省', 36: '江西省', 37: '山东省',
  41: '河南省', 42: '湖北省', 43: '湖南省', 44: '广东省', 45: '广西壮族自治区',
  46: '海南省', 50: '重庆市', 51: '四川省', 52: '贵州省', 53: '云南省',
  54: '西藏自治区', 61: '陕西省', 62: '甘肃省', 63: '青海省', 64: '宁夏回族自治区',
  65: '新疆维吾尔自治区',
};

// 直辖市在源数据中为"市辖区"占位条目，替换为标准城市名
const MUNICIPALITIES = {
  1101: '北京市', 1201: '天津市', 3101: '上海市', 5001: '重庆市',
};

const raw = JSON.parse(readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
// 4190/4290/4690/6590 为"省直辖县级行政区划"占位条目，非具体城市名，不进入城市目录
const PLACEHOLDER_CODES = new Set(['4190', '4290', '4690', '6590']);
const cities = [];
for (const item of raw) {
  // 5002（重庆"县"）与 5001 同属重庆市，合并为一个城市条目
  if (item.code === '5002') continue;
  if (PLACEHOLDER_CODES.has(item.code)) continue;
  const name = MUNICIPALITIES[item.code] ?? item.name;
  const provinceName = PROVINCES[item.provinceCode];
  if (!provinceName) {
    console.error(`未知省级代码: ${item.provinceCode} (${item.code} ${item.name})`);
    process.exit(1);
  }
  cities.push({
    city_code: item.code,
    name,
    province_code: item.provinceCode,
    province_name: provinceName,
    timezone: 'Asia/Shanghai',
    catalog_status: 'active', // 可被用户搜索
    status: 'requestable', // 房价数据覆盖状态：默认未开通，可提交覆盖申请
  });
}
cities.sort((a, b) => a.city_code.localeCompare(b.city_code));

const out = {
  meta: {
    purpose: 'D1 cities 表播种种子；仅城市基础元数据，不含房价与小区数据',
    source: 'modood/Administrative-divisions-of-China (dist/cities.json)，基于 GB/T 2260 行政区划代码',
    source_url: 'https://github.com/modood/Administrative-divisions-of-China',
    fetched_at: '2026-11-11',
    exclusions: '重庆 5002（县）并入 5001；4190/4290/4690/6590 省直辖县级占位条目已排除，相关区县可走城市目录补录申请',
    rule: '城市可选择 ≠ 已接入房价数据；status 仅由数据源验证结果修改',
  },
  count: cities.length,
  cities,
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'city-catalog.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`已生成 ${outPath}: ${cities.length} 个城市`);
