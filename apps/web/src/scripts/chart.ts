/**
 * 内联 SVG 折线图绘制工具（无第三方图表库、无外链资源）。
 * 页面把演示序列以 JSON 埋入 DOM，切换周期/口径时重新计算 path。
 */

export interface ChartSeriesMap {
  [objectKey: string]: {
    [metricKey: string]: {
      [periodKey: string]: number[];
    };
  };
}

/** 周期 key → 展示文案 */
export const PERIOD_LABELS: Record<string, string> = {
  "7": "近 7 日",
  "30": "近 30 日",
  "90": "近 90 日",
  "180": "近 180 日",
  "360": "近 1 年",
};

export function parseChartData(raw: string): ChartSeriesMap {
  try {
    return JSON.parse(raw) as ChartSeriesMap;
  } catch {
    return {};
  }
}

/** 根据数据点数组重绘指定 svg 内的 [data-chart-path] / [data-chart-dot] */
export function drawChart(svg: SVGSVGElement, points: number[]): void {
  const pathEl = svg.querySelector<SVGPathElement>("[data-chart-path]");
  const dotEl = svg.querySelector<SVGCircleElement>("[data-chart-dot]");
  if (!pathEl) return;

  const width = svg.viewBox.baseVal.width || 100;
  const height = svg.viewBox.baseVal.height || 72;

  if (points.length < 2) {
    pathEl.setAttribute("d", "");
    dotEl?.setAttribute("r", "0");
    return;
  }

  const pad = 4;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((point, index) => {
    const x = pad + (index / (points.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (point - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });

  pathEl.setAttribute(
    "d",
    coords
      .map(
        ([x, y], index) =>
          `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`,
      )
      .join(" "),
  );

  const last = coords[coords.length - 1];
  if (dotEl && last) {
    dotEl.setAttribute("cx", String(last[0]));
    dotEl.setAttribute("cy", String(last[1]));
    dotEl.setAttribute("r", "2.5");
  }
}
