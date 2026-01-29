import fetch from 'node-fetch';

const NOTION_PAGES_URL = 'https://api.notion.com/v1/pages';
const NOTION_DATABASES_URL = 'https://api.notion.com/v1/databases';
const NOTION_FILE_UPLOADS_URL = 'https://api.notion.com/v1/file_uploads';

function createError(code, message, status = 500, details = null) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (details) err.details = details;
  return err;
}

export function getNotionEnv() {
  const required = ['NOTION_TOKEN', 'NOTION_DATABASE_ID'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw createError(
      'NOTION_ENV_MISSING',
      `Missing env: ${missing.join(', ')}`,
      500
    );
  }
  return {
    token: process.env.NOTION_TOKEN,
    databaseId: process.env.NOTION_DATABASE_ID,
    notionVersion: process.env.NOTION_VERSION || '2022-06-28'
  };
}

async function parseNotionError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const message = payload?.message || 'Notion API error';
  const code = payload?.code || 'NOTION_API_ERROR';
  return createError(code, message, response.status, payload);
}

function notionHeaders() {
  const { token, notionVersion } = getNotionEnv();
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': notionVersion,
    'Content-Type': 'application/json'
  };
}

function notionAuthHeaders() {
  const { token, notionVersion } = getNotionEnv();
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': notionVersion
  };
}

export async function getDatabase(databaseId) {
  const response = await fetch(`${NOTION_DATABASES_URL}/${databaseId}`, {
    method: 'GET',
    headers: notionHeaders()
  });

  if (!response.ok) {
    throw await parseNotionError(response);
  }

  return response.json();
}

function findTitlePropertyName(database) {
  const properties = database?.properties || {};
  for (const [name, prop] of Object.entries(properties)) {
    if (prop?.type === 'title') return name;
  }
  return null;
}

function findPropertyByName(database, name, type) {
  const properties = database?.properties || {};
  if (properties[name] && (!type || properties[name]?.type === type)) {
    return name;
  }
  const target = name.trim().toLowerCase();
  for (const [key, prop] of Object.entries(properties)) {
    if (key.trim().toLowerCase() === target && (!type || prop?.type === type)) {
      return key;
    }
  }
  return null;
}

function chunkText(text, size = 1800) {
  const chunks = [];
  let index = 0;
  const safeText = text ?? '';
  while (index < safeText.length) {
    chunks.push(safeText.slice(index, index + size));
    index += size;
  }
  return chunks;
}

function buildParagraphBlocks(lines) {
  return lines
    .filter((line) => line && line.trim().length > 0)
    .map((line) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: line } }]
      }
    }));
}

function buildImageBlocks(urls) {
  return (urls || [])
    .filter((u) => /^https?:\/\//i.test(u))
    .map((u) => ({
      object: 'block',
      type: 'image',
      image: {
        type: 'external',
        external: { url: u }
      }
    }));
}

async function createFileUpload() {
  const response = await fetch(NOTION_FILE_UPLOADS_URL, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify({})
  });

  if (!response.ok) {
    throw await parseNotionError(response);
  }

  return response.json();
}

async function uploadFileToNotion({ buffer, filename, contentType }) {
  const init = await createFileUpload();
  const uploadUrl = init?.upload_url;
  const fileId = init?.id;
  if (!uploadUrl || !fileId) {
    throw createError('FILE_UPLOAD_INIT_FAILED', 'Failed to init file upload', 500);
  }

  const form = new FormData();
  const blob = new Blob([buffer], { type: contentType || 'application/octet-stream' });
  form.append('file', blob, filename || 'image');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: notionAuthHeaders(),
    body: form
  });

  if (!uploadRes.ok) {
    throw await parseNotionError(uploadRes);
  }

  return fileId;
}

function buildUploadedImageBlocks(fileIds) {
  return (fileIds || []).map((id) => ({
    object: 'block',
    type: 'image',
    image: {
      type: 'file_upload',
      file_upload: { id }
    }
  }));
}

function parseDateToNotion(dateText) {
  if (!dateText) return null;
  const text = dateText.trim();
  const match = text.match(
    /(\d{4})\.(\d{1,2})\.(\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2})?:?(\d{2})?/
  );
  if (!match) return null;
  const [, y, m, d, ampm, hhRaw, mmRaw] = match;
  const pad = (v) => String(v).padStart(2, '0');
  if (!hhRaw) {
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  let hh = Number(hhRaw);
  const mm = mmRaw ? Number(mmRaw) : 0;
  if (ampm === '오후' && hh < 12) hh += 12;
  if (ampm === '오전' && hh === 12) hh = 0;
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+09:00`;
}

export async function createPage({
  title,
  contentText,
  url,
  dateText,
  imageUrls,
  imageFiles
}) {
  const { databaseId } = getNotionEnv();

  const database = await getDatabase(databaseId);
  const titleProperty = findTitlePropertyName(database);
  if (!titleProperty) {
    throw createError(
      'TITLE_PROPERTY_NOT_FOUND',
      'No title property found on database',
      400
    );
  }

  const properties = {
    [titleProperty]: {
      title: [{ type: 'text', text: { content: title || 'Untitled' } }]
    }
  };

  const urlProperty = findPropertyByName(database, '원문 링크', 'url');
  const dateProperty = findPropertyByName(database, '후기 작성일', 'date');

  if (url && urlProperty) {
    properties[urlProperty] = { url };
  }

  const parsedDate = parseDateToNotion(dateText);
  if (parsedDate && dateProperty) {
    properties[dateProperty] = { date: { start: parsedDate } };
  }

  const blocks = [];
  if (url && !urlProperty) {
    blocks.push(...buildParagraphBlocks([url]));
  }

  const fileIds = [];
  if (imageFiles && imageFiles.length) {
    for (const file of imageFiles) {
      try {
        const id = await uploadFileToNotion(file);
        fileIds.push(id);
      } catch {}
    }
  }

  const imageBlocks =
    fileIds.length > 0 ? buildUploadedImageBlocks(fileIds) : buildImageBlocks(imageUrls);
  if (imageBlocks.length) blocks.push(...imageBlocks);

  const chunks = chunkText(contentText || '', 1800);
  blocks.push(...buildParagraphBlocks(chunks));

  const response = await fetch(NOTION_PAGES_URL, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children: blocks
    })
  });

  if (!response.ok) {
    throw await parseNotionError(response);
  }

  return response.json();
}
