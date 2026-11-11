/**
 * TASK-01C 图标生成脚本
 *
 * 从 public/icons/icon.svg 派生各尺寸 PNG（Manifest / Apple Touch 用）：
 *   - icon-192.png / icon-512.png：圆角品牌方块（purpose: any）
 *   - maskable-512.png：全幅底色 + 内容缩至 64%（Android 自适应图标安全区）
 *   - apple-touch-180.png：全幅直角（iOS 会自行施加圆角遮罩）
 *
 * 渲染：playwright-core + 系统 Edge（channel: "msedge"），不下载浏览器。
 * 生成结果提交入库；本脚本可重复运行保证可复现。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconSvgPath = join(webRoot, "public", "icons", "icon.svg");
const outputDir = join(webRoot, "public", "icons");

const source = readFileSync(iconSvgPath, "utf8");

/** 从源 SVG 中取出品牌底 rect 之后的图形内容（雷达网格 + 折线 + 信号点） */
function innerGraphics(svg) {
  const match = svg.match(
    /<rect width="512" height="512" rx="96" fill="#14253d" \/>([\s\S]*?)<\/svg>/,
  );
  if (!match) {
    throw new Error("icon.svg 结构与脚本预期不符：找不到品牌底 rect");
  }
  return match[1];
}

/** 任意用途图标：保留源 SVG（圆角 rx=96） */
const iconAny = source;

/** maskable：底色铺满全幅（安全区会被圆形遮罩裁切，底色必须出血）+ 内容缩放至 64% */
const iconMaskable = source.replace(
  /<rect width="512" height="512" rx="96" fill="#14253d" \/>([\s\S]*?)<\/svg>/,
  '<rect width="512" height="512" fill="#14253d" />' +
    '<g transform="translate(256 256) scale(0.64) translate(-256 -256)">$1</g>' +
    "</svg>",
);

/** Apple Touch：全幅直角（iOS 自行施加圆角），内容保持原比例 */
const iconApple = source.replace(
  '<rect width="512" height="512" rx="96" fill="#14253d" />',
  '<rect width="512" height="512" fill="#14253d" />',
);

const variants = [
  { file: "icon-192.png", size: 192, svg: iconAny },
  { file: "icon-512.png", size: 512, svg: iconAny },
  { file: "maskable-512.png", size: 512, svg: iconMaskable },
  { file: "apple-touch-180.png", size: 180, svg: iconApple },
];

// sanity：innerGraphics 至少被解析过一次（防止源文件结构漂移后静默出错）
innerGraphics(source);

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const variant of variants) {
    const page = await browser.newPage({
      viewport: { width: variant.size, height: variant.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>*{margin:0;padding:0}html,body{width:${variant.size}px;height:${variant.size}px;overflow:hidden}svg{display:block;width:${variant.size}px;height:${variant.size}px}</style>${variant.svg}`,
    );
    await page.screenshot({
      path: join(outputDir, variant.file),
      clip: { x: 0, y: 0, width: variant.size, height: variant.size },
    });
    await page.close();
    process.stdout.write(`generated ${variant.file} (${variant.size}px)\n`);
  }
} finally {
  await browser.close();
}

// 校验输出均为非空 PNG（文件头 89 50 4E 47）
for (const variant of variants) {
  const buf = readFileSync(join(outputDir, variant.file));
  if (buf.length < 500 || buf.subarray(0, 4).toString("hex") !== "89504e47") {
    throw new Error(`${variant.file} 不是有效的 PNG`);
  }
}
