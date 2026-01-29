# naver-cafe-extractor

MVP API that extracts title/content from Naver Cafe posts and saves to a fixed Notion database.

## Requirements
- Node.js 18+
- Playwright browsers installed
- `storage/naver-state.json` created once (see below)

## Install
```bash
npm install
npx playwright install --with-deps
```

## Run
```bash
npm run dev
```
Default port: `3000`

## API
### Health
```bash
curl http://localhost:3000/health
```

### Extract post
```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url":"https://cafe.naver.com/physicalclinic/297893"}'
```

### Save to Notion (Internal Integration)
```bash
curl -X POST http://localhost:3000/notion/save \
  -H "Content-Type: application/json" \
  -d '{"title":"Sample","contentText":"Hello","url":"https://example.com"}'
```

## First-time session save (Naver)
Run once to create `storage/naver-state.json`.
```bash
node -e "import { chromium } from 'playwright';(async()=>{const browser=await chromium.launch({headless:false});const context=await browser.newContext();const page=await context.newPage();await page.goto('https://cafe.naver.com');console.log('Login to Naver, then press Enter here.');process.stdin.once('data', async ()=>{await context.storageState({ path: 'storage/naver-state.json' });await browser.close();console.log('Saved: storage/naver-state.json');process.exit(0);});})();"
```

## Notion integration (Internal Integration)
1) Create an **Internal Integration** in Notion and copy the secret token.
2) Open your target Database (or its parent page), click **Share**, and add the integration as a connection.
3) Find the database ID (from the Notion URL) and set environment variables below.

Create `.env` with:
```
NOTION_TOKEN=secret_xxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxx
NOTION_VERSION=2022-06-28
```

Notes:
- The integration must be explicitly connected to the database/page, or API calls will fail.
- `NOTION_VERSION` can stay as `2022-06-28` unless you need a newer version.

## UI
Open `http://localhost:3000` and click **Save to Notion** after entering a URL.

## Notes
- `storage/naver-state.json` is gitignored.
- `.env` is gitignored.
- Do not log or expose session cookies or tokens.
