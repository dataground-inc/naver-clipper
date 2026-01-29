import dotenv from "dotenv";
import express from "express";
import {
  extractNaverCafePost,
  downloadImagesWithPlaywright,
} from "./extractor.js";
import { createPage, getNotionEnv } from "./notion.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

function isValidHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function mapError(err) {
  if (err?.code === "STORAGE_STATE_NOT_FOUND") {
    return { status: 400, code: err.code, message: err.message };
  }
  if (err?.code === "CONTENT_NOT_FOUND") {
    return { status: 500, code: err.code, message: err.message };
  }
  if (err?.code === "NOTION_ENV_MISSING") {
    return { status: 500, code: err.code, message: err.message };
  }
  if (err?.code && err?.status) {
    return { status: err.status, code: err.code, message: err.message };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Server error occurred.",
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/extract", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidHttpUrl(url)) {
    return res.status(400).json({
      ok: false,
      error: {
        code: "INVALID_URL",
        message: "url이 정확하지 않거나 or not http(s)로 시작되지 않아요.",
      },
    });
  }

  try {
    const data = await extractNaverCafePost(url);
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("[/extract] error:", err); // ✅ 이 줄 추가
    const mapped = mapError(err);
    return res.status(mapped.status).json({
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
      },
    });
  }
});

app.post("/notion/save", async (req, res) => {
  const { title, contentText, url, dateText, imageUrls } = req.body || {};

  try {
    getNotionEnv();
    let imageFiles = [];
    if (Array.isArray(imageUrls) && imageUrls.length) {
      imageFiles = await downloadImagesWithPlaywright(imageUrls);
    }

    const page = await createPage({
      title,
      contentText,
      url,
      dateText,
      imageUrls,
      imageFiles,
    });
    return res.json({
      ok: true,
      notionPageId: page.id,
      notionUrl: page.url,
    });
  } catch (err) {
    const mapped = mapError(err);
    return res.status(mapped.status).json({
      ok: false,
      error: { code: mapped.code, message: mapped.message },
    });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
