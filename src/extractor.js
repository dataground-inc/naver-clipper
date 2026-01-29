import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const STORAGE_PATH = path.resolve("storage/naver-state.json");

function toMobileCafeUrl(url) {
  // https://cafe.naver.com/{cafe}/{articleId} -> https://m.cafe.naver.com/{cafe}/{articleId}
  try {
    const u = new URL(url);
    if (u.hostname === "cafe.naver.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      // e.g. ["physicalclinic", "297893"]
      if (parts.length >= 2) {
        return `https://m.cafe.naver.com/${parts[0]}/${parts[1]}`;
      }
    }
  } catch {}
  return null;
}

async function extractFromFrame(frame) {
  // 본문/제목 셀렉터 후보
  const contentSelectors = [
    "div.article_viewer", // 확인한 진짜 본문 컨테이너
    "div.se-main-container",
    "div#postViewArea",
    "div.ArticleContentBox",
    "div.ContentRenderer",
  ];

  const titleSelectors = [
    "h3.title_text",
    "h2.title_text",
    "div.title_text",
    "h1",
  ];

  const dateSelectors = ["span.date", "span.article_info_date", "div.date"];

  const imageSelectors = [
    "div.article_viewer img",
    "div.se-main-container img",
    "div#postViewArea img",
    "div.ArticleContentBox img",
    "div.ContentRenderer img",
  ];

  // body가 생길 때까지 기다림
  await frame.waitForSelector("body", { timeout: 8000 });

  // 제목
  let title = "";
  for (const sel of titleSelectors) {
    try {
      const el = await frame.$(sel);
      if (el) {
        const t = (await el.innerText()).trim();
        if (t) {
          title = t;
          break;
        }
      }
    } catch {}
  }

  // 본문
  let contentText = "";
  for (const sel of contentSelectors) {
    try {
      const el = await frame.$(sel);
      if (el) {
        const t = (await el.innerText()).trim();
        if (t && t.length >= 20) {
          contentText = t;
          break;
        }
      }
    } catch {}
  }

  // 작성일
  let dateText = "";
  for (const sel of dateSelectors) {
    try {
      const el = await frame.$(sel);
      if (el) {
        const t = (await el.innerText()).trim();
        if (t) {
          dateText = t;
          break;
        }
      }
    } catch {}
  }

  // 이미지
  let imageUrls = [];
  for (const sel of imageSelectors) {
    try {
      const urls = await frame.$$eval(sel, (imgs) =>
        imgs
          .map((img) =>
            (img.getAttribute("data-src") ||
              img.getAttribute("data-lazy-src") ||
              img.getAttribute("data-original") ||
              img.getAttribute("src") ||
              "")
              .trim(),
          )
          .filter(Boolean),
      );
      if (urls && urls.length) {
        imageUrls = urls;
        break;
      }
    } catch {}
  }

  if (imageUrls.length) {
    imageUrls = Array.from(new Set(imageUrls));
  }

  return { title, contentText, dateText, imageUrls };
}

export async function extractNaverCafePost(url) {
  if (!fs.existsSync(STORAGE_PATH)) {
    const err = new Error(
      "storage/naver-state.json 파일이 없습니다. 먼저 세션을 저장하세요.",
    );
    err.code = "STORAGE_STATE_NOT_FOUND";
    throw err;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_PATH });
  const page = await context.newPage();

  try {
    // 1) PC URL 시도
    await page.goto(url, { waitUntil: "domcontentloaded" });
    console.log("=== FRAME URLS ===");
    for (const f of page.frames()) {
      try {
        const has = await f.$("div.article_viewer");
        console.log(has ? "[HIT]" : "[   ]", f.url());
      } catch {
        console.log("[ERR]", f.url());
      }
    }

    // ✅ article_viewer가 존재하는 프레임을 우선 탐색
    let viewerFrame = null;
    for (const f of page.frames()) {
      const fu = f.url() || "";
      if (!fu || fu === "about:blank") continue;

      try {
        const hasViewer = await f.$("div.article_viewer");
        if (hasViewer) {
          viewerFrame = f;
          break;
        }
      } catch {}
    }

    console.log("FRAMES:");
    page.frames().forEach((f) => console.log(" -", f.url()));

    await page
      .waitForSelector(
        "iframe#iframe, iframe#cafe_main, iframe[name='cafe_main']",
        { timeout: 15000 },
      )
      .catch(() => {});
    await page.waitForTimeout(800); // 프레임 내부 렌더링 텀(매우 중요)

    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});

    const frames = page.frames().filter((f) => {
      const fu = f.url() || "";
      return fu && fu !== "about:blank";
    });

    // 1) 게시글 프레임(ArticleRead / articleid) 최우선
    const articleFrames = frames.filter((f) => {
      const fu = f.url();
      return /ArticleRead|articleid|Article/i.test(fu);
    });

    // 2) 그 다음 cafe_main
    const cafeMain = page.frame({ name: "cafe_main" });
    const framesToTry = [];

    // articleFrames 먼저
    for (const f of articleFrames) framesToTry.push(f);

    // cafe_main이 있고 중복 아니면 추가
    if (cafeMain && !framesToTry.includes(cafeMain)) framesToTry.push(cafeMain);

    // 나머지 프레임들 마지막에
    for (const f of frames) {
      if (!framesToTry.includes(f)) framesToTry.push(f);
    }

    let best = { title: "", contentText: "", dateText: "", imageUrls: [] };
    for (const f of framesToTry) {
      const res = await extractFromFrame(f);
      if (
        res.contentText &&
        res.contentText.length > (best.contentText?.length || 0)
      ) {
        best = res;
      }
    }

    // 2) PC에서 실패하면 모바일 URL로 재시도
    if (!best.contentText) {
      const mUrl = toMobileCafeUrl(url);
      if (mUrl) {
        await page.goto(mUrl, { waitUntil: "domcontentloaded" });
        await page
          .waitForLoadState("networkidle", { timeout: 15000 })
          .catch(() => {});

        // 모바일은 보통 mainFrame에 바로 뜨는 편
      const res = await extractFromFrame(page.mainFrame());
      best = res;
    }
    }

    if (!best.contentText) {
      const err = new Error("본문을 찾을 수 없습니다. 셀렉터/iframe 확인 필요");
      err.code = "CONTENT_NOT_FOUND";
      throw err;
    }

    return {
      url,
      title: best.title || "",
      contentText: best.contentText,
      dateText: best.dateText || "",
      imageUrls: best.imageUrls || [],
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function downloadImagesWithPlaywright(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  if (!fs.existsSync(STORAGE_PATH)) {
    const err = new Error(
      "storage/naver-state.json 파일이 없습니다. 먼저 세션을 저장하세요.",
    );
    err.code = "STORAGE_STATE_NOT_FOUND";
    throw err;
  }

  const unique = Array.from(new Set(urls)).slice(0, 10);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_PATH });

  try {
    const results = [];
    for (const url of unique) {
      try {
        const response = await context.request.get(url);
        if (!response.ok()) continue;
        const buffer = await response.body();
        if (!buffer || buffer.length === 0) continue;
        if (buffer.length > 20 * 1024 * 1024) continue;

        const headers = response.headers();
        const contentType = headers["content-type"] || "application/octet-stream";
        const name = `image-${Date.now()}-${results.length + 1}`;
        results.push({ buffer, contentType, filename: name });
      } catch {}
    }
    return results;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
