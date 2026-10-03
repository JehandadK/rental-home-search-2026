import { describe, expect, it } from "vitest";
import { collectPhotos, MAX_PHOTOS, photoKind } from "./photos";

describe("collectPhotos", () => {
  it("resolves relative URLs, upgrades http and drops duplicates", () => {
    expect(collectPhotos([
      { url: "/image_files/a.jpg", kind: "exterior" },
      { url: "http://x.example/image_files/a.jpg", kind: "photo" },
      { url: "https://x.example/image_files/a.jpg", kind: "photo" },
    ], "test", "https://x.example/list/")).toEqual([
      { url: "https://x.example/image_files/a.jpg", kind: "exterior", source: "test" },
    ]);
  });
  it("drops spinners, transparent pixels, no-image art and data URIs", () => {
    expect(collectPhotos([
      { url: "/static_app_contents/x/assets/common/loading_g.gif", kind: "photo" },
      { url: "/rent/assets/pc/img/lazy-load-pc.gif", kind: "photo" },
      { url: "/rent/assets/pc/img/noimage-photo-pc.png", kind: "floorPlan" },
      { url: "https://www.roomspot.net/app/images/transparent.gif", kind: "photo" },
      { url: "/assets/common/icon_new.svg", kind: "photo" },
      { url: "data:image/gif;base64,R0lGOD", kind: "photo" },
      { url: "", kind: "photo" },
      { url: null, kind: "photo" },
    ], "test", "https://x.example/")).toBeUndefined();
  });
  it("asks athome.jp for a gallery-sized image instead of its 100px thumbnail", () => {
    const [photo] = collectPhotos([{ url: "https://img4.athome.jp/image_files/index/bukken/1/2.jpeg?height=100&width=100&stno10105", kind: "exterior" }], "nifty", "https://myhome.nifty.com/")!;
    expect(photo.url).toBe("https://img4.athome.jp/image_files/index/bukken/1/2.jpeg?height=360&width=480&stno10105=");
  });
  it("drops athome.co.jp's size query to get its full-size original", () => {
    expect(collectPhotos([{ url: "https://www.athome.co.jp/image_files/path/5YUi==?width=120&height=120&margin=true", kind: "floorPlan" }], "athome", "https://www.athome.co.jp/")![0].url)
      .toBe("https://www.athome.co.jp/image_files/path/5YUi==");
  });
  it(`keeps at most ${MAX_PHOTOS}`, () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://x.example/${i}.jpg`, kind: "photo" as const }));
    expect(collectPhotos(many, "test", "https://x.example/")).toHaveLength(MAX_PHOTOS);
  });
});

describe("photoKind", () => {
  it("reads the kind from Japanese alt text", () => {
    expect(photoKind("プラザ天神(賃貸アパートの外観)")).toBe("exterior");
    expect(photoKind("建物画像")).toBe("exterior");
    expect(photoKind("香山コーポ(賃貸アパート101の間取り)")).toBe("floorPlan");
    expect(photoKind("ザ・レジデンス １０２ ２LDKの間取り図")).toBe("floorPlan");
    expect(photoKind("物件画像")).toBe("photo");
    expect(photoKind(undefined, "exterior")).toBe("exterior");
  });
});
