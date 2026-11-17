// TASK-08C T1：城市范围纯函数测试（localStorage 用内存假实现，不依赖浏览器）。
import { describe, expect, it } from "vitest";
import {
  CITY_STORAGE_KEY,
  applyCity,
  cityStatusBadge,
  isCityCovered,
  parseCityScope,
  pickDefaultCity,
  readStoredCity,
  resolveCityScope,
  writeStoredCity,
  type CityScope,
} from "./city";

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const qingdao: CityScope = {
  city_code: "370200",
  name: "青岛市",
  status: "active",
};

describe("parseCityScope", () => {
  it("合法形态通过校验", () => {
    expect(parseCityScope(qingdao)).toEqual(qingdao);
  });

  it("缺失/空字段/非对象一律 null", () => {
    expect(parseCityScope(null)).toBeNull();
    expect(parseCityScope("370200")).toBeNull();
    expect(
      parseCityScope({ city_code: "", name: "x", status: "active" }),
    ).toBeNull();
    expect(parseCityScope({ city_code: "370200" })).toBeNull();
  });
});

describe("readStoredCity / writeStoredCity", () => {
  it("写入后可读回（键名 pr_city）", () => {
    const storage = fakeStorage();
    writeStoredCity(qingdao, storage);
    expect(storage.getItem(CITY_STORAGE_KEY)).toContain("370200");
    expect(readStoredCity(storage)).toEqual(qingdao);
  });

  it("损坏 JSON / 非法形态 → null（不抛错）", () => {
    const storage = fakeStorage();
    storage.setItem(CITY_STORAGE_KEY, "{not-json");
    expect(readStoredCity(storage)).toBeNull();
    storage.setItem(CITY_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    expect(readStoredCity(storage)).toBeNull();
  });

  it("未选择城市 → null", () => {
    expect(readStoredCity(fakeStorage())).toBeNull();
  });
});

describe("pickDefaultCity", () => {
  it("取第一个 active 城市", () => {
    const cities: CityScope[] = [
      { city_code: "110100", name: "北京市", status: "requestable" },
      qingdao,
      { city_code: "370202", name: "其他市", status: "active" },
    ];
    expect(pickDefaultCity(cities)).toEqual(qingdao);
  });

  it("无 active（含只有 limited）→ null：全站诚实空态", () => {
    const cities: CityScope[] = [
      { city_code: "110100", name: "北京市", status: "requestable" },
      { city_code: "320100", name: "南京市", status: "limited" },
    ];
    expect(pickDefaultCity(cities)).toBeNull();
  });
});

describe("isCityCovered / cityStatusBadge", () => {
  it("active/limited 已覆盖，requestable 未覆盖", () => {
    expect(isCityCovered("active")).toBe(true);
    expect(isCityCovered("limited")).toBe(true);
    expect(isCityCovered("requestable")).toBe(false);
  });

  it("徽章文案三态（limited 用警示色，不冒充全量）", () => {
    expect(cityStatusBadge("active").tone).toBe("badge--primary");
    expect(cityStatusBadge("limited").tone).toBe("badge--warning");
    expect(cityStatusBadge("requestable").text).toBe("未覆盖 · 可申请");
  });
});

describe("resolveCityScope", () => {
  it("无存储值时回退第一个 active 并持久化", () => {
    const storage = fakeStorage();
    const scope = resolveCityScope([qingdao], storage);
    expect(scope).toEqual(qingdao);
    expect(readStoredCity(storage)).toEqual(qingdao);
  });

  it("存储值优先于默认城市", () => {
    const storage = fakeStorage();
    const nanjing: CityScope = {
      city_code: "320100",
      name: "南京市",
      status: "limited",
    };
    writeStoredCity(nanjing, storage);
    expect(resolveCityScope([qingdao], storage)).toEqual(nanjing);
  });

  it("目录仍含已选城市时同步最新 status（目录改状态不陈旧）", () => {
    const storage = fakeStorage();
    writeStoredCity(
      { city_code: "320100", name: "南京市", status: "requestable" },
      storage,
    );
    const scope = resolveCityScope(
      [{ city_code: "320100", name: "南京市", status: "active" }],
      storage,
    );
    expect(scope?.status).toBe("active");
  });

  it("目录无 active 且无存储 → null", () => {
    expect(resolveCityScope([], fakeStorage())).toBeNull();
  });
});

describe("applyCity", () => {
  it("Node 环境（无 window）写入不抛错", () => {
    expect(() => applyCity(qingdao)).not.toThrow();
  });
});
