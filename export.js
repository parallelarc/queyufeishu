#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Configuration ───────────────────────────────────────────
const CONFIG = {
  host: process.env.YUQUE_HOST || 'https://xxx.yuque.com',
  cookieFile: process.env.YUQUE_COOKIE_FILE || path.join(__dirname, 'cookies.json'),
  outputDir: path.join(__dirname, 'docs'),
  requestDelay: 500,
  latexcode: false,
  linebreak: false,
};
// ─────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCookieString() {
  const cookies = JSON.parse(fs.readFileSync(CONFIG.cookieFile, 'utf8'));
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function httpGet(url, asText = false) {
  const res = await fetch(url, {
    headers: {
      cookie: loadCookieString(),
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return asText ? res.text() : res.json();
}

// Extract window.appData from HTML (Yuque uses JSON.parse(decodeURIComponent("...")))
function extractAppData(html) {
  const marker = 'window.appData = JSON.parse(decodeURIComponent("';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  const start = idx + marker.length;
  // Find the closing ")"
  const end = html.indexOf('"))', start);
  if (end === -1) return null;

  try {
    const encoded = html.substring(start, end);
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

async function getBooks() {
  const [stacksRes, collabRes] = await Promise.all([
    httpGet(`${CONFIG.host}/api/mine/book_stacks`),
    httpGet(`${CONFIG.host}/api/mine/raw_collab_books`),
  ]);
  // book_stacks: { data: [{ name, books: [...] }] }
  const stackBooks = (stacksRes.data || []).flatMap((s) => s.books || []);
  // collab_books: { data: [{ id, slug, name, user: {login} }] }
  const collabBooks = collabRes.data || [];
  const all = [...stackBooks, ...collabBooks];
  const seen = new Set();
  return all.filter((b) => {
    if (seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });
}

async function getBookToc(user, slug) {
  const html = await httpGet(`${CONFIG.host}/${user}/${slug}`, true);
  const appData = extractAppData(html);
  return appData?.book?.toc || [];
}

function buildTree(items, parentId, parentPath, bookUser, bookSlug) {
  return items
    .filter((item) => {
      if (!parentId) return !item.parent_uuid;
      return item.parent_uuid === parentId;
    })
    .map((item) => {
      const safeTitle = item.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
      const fullPath = parentPath + '/' + safeTitle;
      if (item.type === 'TITLE' || item.child_uuid) {
        fs.mkdirSync(path.join(CONFIG.outputDir, fullPath), { recursive: true });
      }
      return {
        ...item,
        user: bookUser,
        pslug: bookSlug,
        fullPath,
        children: buildTree(items, item.uuid, fullPath, bookUser, bookSlug),
      };
    });
}

function flattenDocs(trees) {
  const docs = [];
  const seen = new Set();

  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === 'DOC' && node.visible === 1) {
        if (seen.has(node.url)) {
          console.warn(`  ⚠ 重复跳过: ${node.title} (${node.url})`);
        } else {
          seen.add(node.url);
          docs.push(node);
        }
      }
      if (node.children?.length) walk(node.children);
    }
  }

  for (const tree of trees) walk(tree);
  return docs;
}

async function getMarkdown(user, bookSlug, docSlug) {
  const url = `${CONFIG.host}/${user}/${bookSlug}/${docSlug}/markdown?attachment=true&latexcode=${CONFIG.latexcode}&anchor=false&linebreak=${CONFIG.linebreak}`;
  return httpGet(url, true);
}

// Export lakesheet as CSV
function exportLakesheetCsv(content, filePath) {
  const contentObj = JSON.parse(content);
  const buf = Buffer.from(contentObj.sheet, 'binary');
  const inflated = zlib.inflateSync(buf);
  const parsed = JSON.parse(inflated.toString('utf8'));
  const sheet = Object.values(parsed)[0];

  const maxRow = +sheet.rowCount || 0;
  const maxCol = +sheet.colCount || 0;
  const data = sheet.data || {};

  function cellValue(row, col) {
    const cell = data[row]?.[col];
    if (!cell) return '';
    const v = cell.v;
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    // Select/dropdown: { class: "select", value: ["已迁移"], ... }
    if (v.class === 'select' && Array.isArray(v.value)) return v.value.join(', ');
    if (v.m != null) return v.m;
    return '';
  }

  const lines = [];
  for (let r = 0; r < maxRow; r++) {
    const vals = [];
    let hasContent = false;
    for (let c = 0; c < maxCol; c++) {
      const v = cellValue(r, c);
      if (v) hasContent = true;
      vals.push(v);
    }
    if (hasContent || r < 2) lines.push(vals.map(csvEscape).join(','));
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function csvEscape(val) {
  // Replace newlines with space for CSV compatibility
  const v = val.replace(/\n/g, ' ');
  if (/[,"\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

async function main() {
  const filter = process.argv[2]; // e.g. node export.js zxgogk
  console.log('🔑 Cookie loaded');
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  console.log('📚 Fetching book list...');
  let books = await getBooks();
  if (filter) {
    books = books.filter((b) => b.slug === filter || b.name.includes(filter));
    if (books.length === 0) {
      console.error(`No book matching "${filter}"`);
      console.log('Available:', (await getBooks()).map((b) => `${b.name} (${b.slug})`).join(', '));
      process.exit(1);
    }
  }
  console.log(`   Found ${books.length} books`);

  let totalExported = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const book of books) {
    const { name, slug, user } = book;
    const userLogin = user?.login || user?.name;
    console.log(`\n📖 ${name} (${userLogin}/${slug})`);

    fs.mkdirSync(path.join(CONFIG.outputDir, name), { recursive: true });

    console.log('   Fetching TOC...');
    const toc = await getBookToc(userLogin, slug);
    console.log(`   TOC: ${toc.length} items`);

    const tree = buildTree(toc, null, name, userLogin, slug);
    const docs = flattenDocs([tree]);
    console.log(`   Documents: ${docs.length}`);

    if (docs.length === 0) continue;

    let exported = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const filePath = path.join(CONFIG.outputDir, doc.fullPath + '.md');

      if (fs.existsSync(filePath)) {
        skipped++;
        continue;
      }

      try {
        const md = await getMarkdown(doc.user, doc.pslug, doc.url);
        if (md) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, md, 'utf8');
          exported++;
          console.log(`   ✅ [${i + 1}/${docs.length}] ${doc.title}`);
        } else {
          // Markdown empty — try lakesheet export via doc API
          const csvPath = path.join(CONFIG.outputDir, doc.fullPath + '.csv');
          try {
            const docRes = await httpGet(`${CONFIG.host}/api/docs/${doc.url}?book_id=${book.id}`);
            const docData = docRes.data;
            if (docData?.format === 'lakesheet' && docData?.content) {
              exportLakesheetCsv(docData.content, csvPath);
              exported++;
              console.log(`   ✅ [${i + 1}/${docs.length}] ${doc.title} (lakesheet → CSV)`);
            } else {
              failed++;
              console.log(`   ❌ [${i + 1}/${docs.length}] ${doc.title} — empty`);
            }
          } catch {
            failed++;
            console.log(`   ❌ [${i + 1}/${docs.length}] ${doc.title} — empty`);
          }
        }
      } catch (e) {
        // HTTP error — try lakesheet for 404s too
        const csvPath = path.join(CONFIG.outputDir, doc.fullPath + '.csv');
        try {
          const docRes = await httpGet(`${CONFIG.host}/api/docs/${doc.url}?book_id=${book.id}`);
          const docData = docRes.data;
          if (docData?.format === 'lakesheet' && docData?.content) {
            exportLakesheetCsv(docData.content, csvPath);
            exported++;
            console.log(`   ✅ [${i + 1}/${docs.length}] ${doc.title} (lakesheet → CSV)`);
          } else {
            failed++;
            console.log(`   ❌ [${i + 1}/${docs.length}] ${doc.title} — ${e.message}`);
          }
        } catch {
          failed++;
          console.log(`   ❌ [${i + 1}/${docs.length}] ${doc.title} — ${e.message}`);
        }
      }

      if (i < docs.length - 1) await delay(CONFIG.requestDelay);
    }

    console.log(`   📊 Exported: ${exported}, Skipped: ${skipped}, Failed: ${failed}`);
    totalExported += exported;
    totalFailed += failed;
    totalSkipped += skipped;
  }

  console.log(`\n✅ Done! Exported: ${totalExported}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
