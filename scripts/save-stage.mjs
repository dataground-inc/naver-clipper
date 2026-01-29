import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const outPath = path.resolve("storage/naver-state.json");

(async () => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://nid.naver.com/nidlogin.login");

  console.log("네이버 로그인을 완료한 다음, 이 터미널에서 Enter를 누르세요.");
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  await new Promise((res) => process.stdin.once("data", res));

  await context.storageState({ path: outPath });
  console.log("✅ 세션 저장 완료:", outPath);

  await browser.close();
})();
