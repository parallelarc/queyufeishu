/**
 * 飞书文档上传工具 - 使用官方 SDK
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const lark = require('@larksuiteoapi/node-sdk');

// 配置
const CONFIG = {
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  wikiSpaceId: process.env.FEISHU_WIKI_SPACE_ID,
  wikiParentNodeToken: process.env.FEISHU_WIKI_PARENT_NODE_TOKEN || '',
  markdownDir: process.env.FEISHU_MARKDOWN_DIR || '../docs',
  userTokenFile: './user_token.json',
  imageAssetDir: '_images',
  reuploadExisting: process.argv.includes('--reupload-existing') || process.argv.includes('--overwrite'),
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[36m',
};

function log(color, prefix, message) {
  console.log(`${color}[${prefix}]${colors.reset} ${message}`);
}

function info(message) { log(colors.blue, 'INFO', message); }
function success(message) { log(colors.green, 'SUCCESS', message); }
function warn(message) { log(colors.yellow, 'WARN', message); }
function error(message) { log(colors.red, 'ERROR', message); }

function getApiErrorMessage(e) {
  const data = e.response?.data;
  const details = [];
  if (data?.field_violations) details.push({ field_violations: data.field_violations });
  if (data?.helps) details.push({ helps: data.helps });
  if (data?.error) details.push({ error: data.error });
  if (data?.log_id) details.push({ log_id: data.log_id });
  const detailText = details.length ? ` ${JSON.stringify(details)}` : '';
  return (data?.msg || e.message || 'unknown error') + detailText;
}

function isNodePermissionError(e) {
  return e.response?.data?.code === 131006 || getApiErrorMessage(e).includes('permission denied');
}

function isMissingAuthScopeError(e) {
  const message = getApiErrorMessage(e);
  return e.response?.data?.code === 99991679 ||
    message.includes('required one of these privileges') ||
    message.includes('应用未获取所需的用户授权');
}

function getMissingAuthScopeHint(e) {
  const message = getApiErrorMessage(e);
  if (message.includes('docs:document.media:upload')) {
    return '飞书用户授权缺少图片素材上传权限 docs:document.media:upload，请在开放平台开通后重新授权';
  }
  if (message.includes('docx:document.block:convert')) {
    return '飞书用户授权缺少 Markdown 转块权限 docx:document.block:convert，请在开放平台开通后重新授权';
  }
  return '飞书用户授权缺少必要权限，请在开放平台开通后重新授权';
}

/**
 * 飞书 API 客户端
 */
class FeishuApi {
  constructor(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.client = new lark.Client({
      appId: appId,
      appSecret: appSecret,
    });
    this.userToken = null;
    this.childrenCache = new Map();
  }

  setUserToken(token) {
    this.userToken = token;
  }

  getOptions() {
    if (this.userToken) {
      return lark.withUserAccessToken(this.userToken);
    }
    return undefined;
  }

  async getTenantAccessToken() {
    const res = await this.client.request({
      url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      data: {
        app_id: this.appId,
        app_secret: this.appSecret,
      },
    });
    return res.tenant_access_token;
  }

  async getUserAccessToken(code) {
    const tenantToken = await this.getTenantAccessToken();
    const res = await axios.post('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
      grant_type: 'authorization_code',
      code: code,
    }, {
      headers: {
        'Authorization': 'Bearer ' + tenantToken,
        'Content-Type': 'application/json',
      }
    });
    return res.data.data;
  }

  saveUserToken(data) {
    fs.writeFileSync(CONFIG.userTokenFile, JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 7200) * 1000,
    }, null, 2));
  }

  loadUserToken() {
    if (fs.existsSync(CONFIG.userTokenFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.userTokenFile, 'utf-8'));
      if (data.access_token && data.expires_at > Date.now()) {
        this.userToken = data.access_token;
        return true;
      }
    }
    return false;
  }

  /**
   * 生成 OAuth 授权 URL
   */
  getAuthUrl(state = 'uploader') {
    const redirectUri = encodeURIComponent('https://open.feishu.cn/connect/landing/component/callback');
    const scope = encodeURIComponent([
      'docx:document',
      'docx:document:create',
      'docx:document:write_only',
      'docx:document:readonly',
      'docx:document.block:convert',
      'docs:document.media:upload',
      'drive:file:upload',
      'wiki:node:create',
      'wiki:node:read',
      'wiki:node:retrieve',
      'wiki:wiki',
      'wiki:wiki:readonly',
      'wiki:space:retrieve',
    ].join(' '));
    return `https://open.feishu.cn/open-apis/authen/v1/authorize?redirect_uri=${redirectUri}&state=${state}&app_id=${this.appId}&scope=${scope}`;
  }

  /**
   * 创建 Wiki 节点
   */
  async createWikiNode(title, parentToken, spaceId) {
    return this.client.wiki.spaceNode.create({
      path: { space_id: spaceId },
      data: {
        obj_type: 'docx',
        parent_node_token: parentToken || '',
        node_type: 'origin',
        title: title,
      },
    }, this.getOptions());
  }

  /**
   * 创建文档并获取 token
   */
  async createDoc(title, parentToken, spaceId) {
    const wikiResult = await this.createWikiNode(title, parentToken, spaceId);
    const nodeToken = wikiResult.data.node.node_token;
    const objToken = wikiResult.data.node.obj_token;
    return { nodeToken, documentToken: objToken };
  }

  getChildrenCacheKey(spaceId, parentToken) {
    return `${spaceId}:${parentToken || ''}`;
  }

  async listWikiChildren(parentToken, spaceId) {
    const cacheKey = this.getChildrenCacheKey(spaceId, parentToken);
    if (this.childrenCache.has(cacheKey)) {
      return this.childrenCache.get(cacheKey);
    }

    const items = [];
    let pageToken = undefined;
    do {
      const params = { page_size: 50 };
      if (pageToken) params.page_token = pageToken;
      if (parentToken) params.parent_node_token = parentToken;

      const res = await this.client.wiki.spaceNode.list({
        path: { space_id: spaceId },
        params,
      }, this.getOptions());

      const data = res.data || {};
      items.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);

    this.childrenCache.set(cacheKey, items);
    return items;
  }

  addChildToCache(parentToken, spaceId, node) {
    const cacheKey = this.getChildrenCacheKey(spaceId, parentToken);
    if (this.childrenCache.has(cacheKey)) {
      this.childrenCache.get(cacheKey).push(node);
    }
  }

  async findWikiNodeByTitle(title, parentToken, spaceId) {
    const children = await this.listWikiChildren(parentToken, spaceId);
    return children.find((node) => node.title === title && node.obj_type === 'docx');
  }

  async getOrCreateWikiNode(title, parentToken, spaceId) {
    const existing = await this.findWikiNodeByTitle(title, parentToken, spaceId);
    if (existing) {
      return { node: existing, reused: true };
    }

    const result = await this.createWikiNode(title, parentToken, spaceId);
    const node = result.data.node;
    this.addChildToCache(parentToken, spaceId, node);
    return { node, reused: false };
  }

  async getOrCreateDoc(title, parentToken, spaceId) {
    const { node, reused } = await this.getOrCreateWikiNode(title, parentToken, spaceId);
    return { nodeToken: node.node_token, documentToken: node.obj_token, reused };
  }

  /**
   * 获取文档块列表
   */
  async getDocBlocks(documentId) {
    const res = await this.client.docx.documentBlock.list({
      path: { document_id: documentId },
    }, this.getOptions());
    return res.data.items || [];
  }

  async getRootBlock(documentId) {
    const rootBlocks = await this.getDocBlocks(documentId);
    if (rootBlocks.length === 0) {
      throw new Error('无法获取文档根块');
    }
    return rootBlocks[0];
  }

  async getBlockChildren(documentId, blockId) {
    const items = [];
    let pageToken = undefined;
    do {
      const params = { page_size: 500 };
      if (pageToken) params.page_token = pageToken;
      const res = await this.client.docx.documentBlockChildren.get({
        path: { document_id: documentId, block_id: blockId },
        params,
      }, this.getOptions());
      const data = res.data || {};
      items.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  async clearDocument(documentId) {
    const rootBlock = await this.getRootBlock(documentId);
    const rootBlockId = rootBlock.block_id;
    while (true) {
      const children = await this.getBlockChildren(documentId, rootBlockId);
      if (children.length === 0) return;
      await this.client.docx.documentBlockChildren.batchDelete({
        path: { document_id: documentId, block_id: rootBlockId },
        data: { start_index: 0, end_index: Math.min(children.length, 100) },
      }, this.getOptions());
    }
  }

  async deleteRootChildrenPrefix(documentId, rootBlockId, count) {
    let remaining = count;
    while (remaining > 0) {
      const batchSize = Math.min(remaining, 100);
      await this.client.docx.documentBlockChildren.batchDelete({
        path: { document_id: documentId, block_id: rootBlockId },
        data: { start_index: 0, end_index: batchSize },
      }, this.getOptions());
      remaining -= batchSize;
    }
  }

  async convertMarkdownToBlocks(markdown, baseDir) {
    const content = normalizeMarkdownForConvert(markdown);
    const res = await this.client.docx.document.convert({
      data: {
        content_type: 'markdown',
        content,
      },
    }, this.getOptions());

    const data = res.data || {};
    const imageRefs = extractMarkdownImages(content, baseDir);
    let imageIndex = 0;
    const imageByBlockId = new Map();
    const blocks = (data.blocks || [])
      .filter((block) => block.block_type !== 1)
      .map((block) => {
        const convertedBlock = normalizeConvertedBlock(block);
        if (convertedBlock.block_type === 27 && convertedBlock.block_id) {
          const image = imageRefs[imageIndex++];
          if (image) imageByBlockId.set(convertedBlock.block_id, image);
        }
        return convertedBlock;
      });

    return {
      blocks,
      imageByBlockId,
      firstLevelBlockIds: data.first_level_block_ids || [],
    };
  }

  async writeMarkdownContent(documentId, markdown, options = {}) {
    const converted = await this.convertMarkdownToBlocks(markdown, options.baseDir || process.cwd());
    await this.createConvertedBlocks(documentId, converted, options);
  }

  async replaceMarkdownContent(documentId, markdown, options = {}) {
    const rootBlock = await this.getRootBlock(documentId);
    const oldChildren = await this.getBlockChildren(documentId, rootBlock.block_id);
    await this.writeMarkdownContent(documentId, markdown, { ...options, index: -1 });
    if (oldChildren.length > 0) {
      await this.deleteRootChildrenPrefix(documentId, rootBlock.block_id, oldChildren.length);
    }
  }

  async createConvertedBlocks(documentId, converted, options = {}) {
    if (!converted.blocks.length) return;
    const rootBlock = await this.getRootBlock(documentId);
    const firstLevelBlockIds = converted.firstLevelBlockIds.length
      ? converted.firstLevelBlockIds
      : converted.blocks.filter((block) => !block.parent_id).map((block) => block.block_id).filter(Boolean);
    const chunkResults = [];
    const chunks = chunkConvertedBlocks(firstLevelBlockIds, converted.blocks);
    for (const chunk of chunks) {
      const res = await this.client.docx.documentBlockDescendant.create({
        path: { document_id: documentId, block_id: rootBlock.block_id },
        data: {
          children_id: chunk.childrenId,
          descendants: chunk.descendants,
          index: options.index ?? -1,
        },
      }, this.getOptions());
      chunkResults.push(res);
    }

    const blockIdRelations = chunkResults.flatMap((res) => res.data?.block_id_relations || []);
    const realBlockByTemporaryId = new Map();
    for (const relation of blockIdRelations) {
      if (relation.temporary_block_id && relation.block_id) {
        realBlockByTemporaryId.set(relation.temporary_block_id, relation.block_id);
      }
    }

    const createdImageBlocks = [];
    for (const res of chunkResults) {
      for (const block of res.data?.children || []) {
        if (block.block_type === 27 && block.block_id) {
          createdImageBlocks.push(block.block_id);
        }
      }
    }

    let fallbackImageIndex = 0;
    for (const [temporaryBlockId, image] of converted.imageByBlockId.entries()) {
      const realBlockId = realBlockByTemporaryId.get(temporaryBlockId) || createdImageBlocks[fallbackImageIndex++];
      if (!realBlockId) {
        throw new Error('图片块创建成功但未返回 block_id: ' + image.url);
      }
      await this.uploadAndBindImage(documentId, realBlockId, image);
    }
  }

  async uploadAndBindImage(documentId, imageBlockId, image) {
    const payload = await loadImagePayload(image.url, image.baseDir);
    if (payload.size > 20 * 1024 * 1024) {
      throw new Error('图片超过 20MB，跳过: ' + payload.fileName);
    }

    const uploadRes = await this.client.drive.media.uploadAll({
      data: {
        file_name: payload.fileName,
        parent_type: 'docx_image',
        parent_node: imageBlockId,
        size: payload.size,
        file: payload.buffer,
      },
    }, this.getOptions());

    const fileToken = uploadRes?.file_token;
    if (!fileToken) {
      throw new Error('图片素材上传未返回 file_token');
    }

    const replaceImage = { token: fileToken };
    if (image.alt) {
      replaceImage.caption = { content: image.alt };
    }

    await this.client.docx.documentBlock.batchUpdate({
      path: { document_id: documentId },
      data: {
        requests: [{
          block_id: imageBlockId,
          replace_image: replaceImage,
        }],
      },
    }, this.getOptions());
  }
}

function normalizeMarkdownForConvert(markdown) {
  return String(markdown || '')
    .replace(/<\/?font[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ');
}

function normalizeConvertedBlock(block) {
  const normalized = JSON.parse(JSON.stringify(block));
  delete normalized.page;

  if (normalized.table?.property?.merge_info) {
    delete normalized.table.property.merge_info;
  }

  if (normalized.block_type === 27) {
    const caption = normalized.image?.caption;
    normalized.image = caption ? { caption } : {};
  }

  return normalized;
}

function chunkConvertedBlocks(firstLevelBlockIds, blocks) {
  const maxDescendantsPerRequest = 1000;
  const blockById = new Map(blocks.map((block) => [block.block_id, block]).filter(([id]) => id));
  const chunks = [];
  let currentChildren = [];
  let currentIds = new Set();

  const flush = () => {
    if (!currentChildren.length) return;
    chunks.push({
      childrenId: currentChildren,
      descendants: blocks.filter((block) => currentIds.has(block.block_id)),
    });
    currentChildren = [];
    currentIds = new Set();
  };

  for (const blockId of firstLevelBlockIds) {
    const subtreeIds = collectConvertedSubtreeIds(blockId, blockById);
    if (currentIds.size > 0 && currentIds.size + subtreeIds.length > maxDescendantsPerRequest) {
      flush();
    }

    if (subtreeIds.length > maxDescendantsPerRequest) {
      warn('单个顶层块超过飞书单次写入限制，尝试单独写入: ' + blockId + ' (' + subtreeIds.length + ' blocks)');
    }

    currentChildren.push(blockId);
    for (const id of subtreeIds) currentIds.add(id);
  }

  flush();
  return chunks;
}

function collectConvertedSubtreeIds(blockId, blockById, visited = new Set()) {
  if (!blockId || visited.has(blockId)) return [];
  visited.add(blockId);

  const block = blockById.get(blockId);
  if (!block) return [];

  const ids = [blockId];
  for (const childId of block.children || []) {
    ids.push(...collectConvertedSubtreeIds(childId, blockById, visited));
  }
  return ids;
}

function extractMarkdownImages(markdown, baseDir) {
  const images = [];
  const parts = String(markdown || '').split(/(\r?\n)/);
  let inCodeBlock = false;

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const imageRegex = markdownImageRegex();
    let match;
    while ((match = imageRegex.exec(line)) !== null) {
      images.push({
        url: parseMarkdownImageTarget(match[2]),
        alt: match[1].trim(),
        baseDir,
      });
    }
  }

  return images;
}

/**
 * 获取目录结构
 */
function isSupportedFile(fileName) {
  return fileName.endsWith('.md') || fileName.endsWith('.csv');
}

function csvToMarkdownTable(csv) {
  const lines = csv.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return '';

  const parseCsvLine = (line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cells.push(current.replace(/\n/g, ' ').trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.replace(/\n/g, ' ').trim());
    return cells;
  };

  const rows = lines.map(parseCsvLine);
  const colCount = Math.max(...rows.map(r => r.length));
  for (const row of rows) {
    while (row.length < colCount) row.push('');
  }

  const mdLines = [];
  mdLines.push('| ' + rows[0].join(' | ') + ' |');
  mdLines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
  for (let i = 1; i < rows.length; i++) {
    mdLines.push('| ' + rows[i].join(' | ') + ' |');
  }
  return mdLines.join('\n');
}

async function getDirectoryStructure(dirPath) {
  const items = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name.startsWith('node_modules')) continue;

      const children = await getDirectoryStructure(fullPath);
      if (children.length > 0) {
        items.push({
          type: 'folder',
          name: entry.name,
          fullPath: fullPath,
          children: children,
        });
      }
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      items.push({
        type: 'file',
        name: entry.name,
        fullPath: fullPath,
      });
    }
  }

  return items;
}

function getMarkdownFiles(dirPath, skipDirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const resolvedSkipDir = skipDirPath ? path.resolve(skipDirPath) : '';

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const resolvedPath = path.resolve(fullPath);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name.startsWith('node_modules')) continue;
      if (resolvedSkipDir && resolvedPath === resolvedSkipDir) continue;
      files.push(...getMarkdownFiles(fullPath, skipDirPath));
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function localizeMarkdownImages(markdownRoot, imageAssetDir) {
  const assetRoot = path.resolve(markdownRoot, imageAssetDir);
  fs.mkdirSync(assetRoot, { recursive: true });

  const stats = {
    filesScanned: 0,
    filesUpdated: 0,
    imagesFound: 0,
    remoteImages: 0,
    localImages: 0,
    imagesDownloaded: 0,
    imagesReused: 0,
    imagesCached: 0,
  };
  const cache = new Map();
  const files = getMarkdownFiles(markdownRoot, assetRoot);

  for (const filePath of files) {
    stats.filesScanned++;
    const original = fs.readFileSync(filePath, 'utf-8');
    const rewritten = await rewriteMarkdownImageLinks(original, filePath, assetRoot, cache, stats);

    if (rewritten !== original) {
      fs.writeFileSync(filePath, rewritten);
      stats.filesUpdated++;
    }
  }

  return { ...stats, assetRoot };
}

async function rewriteMarkdownImageLinks(markdown, filePath, assetRoot, cache, stats) {
  const parts = markdown.split(/(\r?\n)/);
  let inCodeBlock = false;
  let output = '';

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const newline = parts[i + 1] || '';
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('```')) {
      output += line + newline;
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      output += line + newline;
      continue;
    }

    output += await rewriteMarkdownImageLine(line, filePath, assetRoot, cache, stats);
    output += newline;
  }

  return output;
}

async function rewriteMarkdownImageLine(line, filePath, assetRoot, cache, stats) {
  const imageRegex = markdownImageRegex();
  let result = '';
  let lastIndex = 0;
  let changed = false;
  let match;

  while ((match = imageRegex.exec(line)) !== null) {
    stats.imagesFound++;

    const rawTarget = match[2].trim();
    const imageUrl = parseMarkdownImageTarget(rawTarget);
    if (!isRemoteUrl(imageUrl)) {
      stats.localImages++;
      continue;
    }

    stats.remoteImages++;
    const localImagePath = await getLocalImageForUrl(imageUrl, assetRoot, cache, stats);
    const relativePath = toMarkdownPath(path.relative(path.dirname(filePath), localImagePath));
    const replacement = `![${match[1]}](${relativePath})`;

    result += line.slice(lastIndex, match.index) + replacement;
    lastIndex = match.index + match[0].length;
    changed = true;
  }

  if (!changed) return line;

  result += line.slice(lastIndex);
  return result;
}

async function getLocalImageForUrl(imageUrl, assetRoot, cache, stats) {
  if (cache.has(imageUrl)) {
    stats.imagesCached++;
    return cache.get(imageUrl);
  }

  const payload = await loadRemoteImagePayload(imageUrl);
  const localPath = buildLocalImagePath(imageUrl, payload, assetRoot);

  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
    stats.imagesReused++;
  } else {
    fs.writeFileSync(localPath, payload.buffer);
    stats.imagesDownloaded++;
  }

  cache.set(imageUrl, localPath);
  return localPath;
}

function buildLocalImagePath(imageUrl, payload, assetRoot) {
  const sourceName = fileNameFromUrl(imageUrl, payload.contentType);
  const ext = path.extname(sourceName) || '.png';
  const stem = sanitizeFileName(path.basename(sourceName, ext)).slice(0, 80) || 'image';
  const hash = crypto.createHash('sha1').update(imageUrl).digest('hex').slice(0, 12);
  return path.join(assetRoot, `${stem}-${hash}${ext}`);
}

function parseMarkdownImageTarget(rawTarget) {
  let target = String(rawTarget || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }

  const titleMatch = target.match(/^(\S+)\s+["'][^"']*["']$/);
  return titleMatch ? titleMatch[1] : target;
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value);
}

function toMarkdownPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function markdownImageRegex() {
  return /!\[([^\]]*)\]\(([^)]+)\)/g;
}

async function loadImagePayload(imageUrl, baseDir) {
  if (isRemoteUrl(imageUrl)) {
    return loadRemoteImagePayload(imageUrl);
  }

  const imagePath = path.isAbsolute(imageUrl)
    ? imageUrl
    : path.resolve(baseDir, decodeURIComponent(imageUrl));

  const buffer = fs.readFileSync(imagePath);
  return {
    buffer,
    size: buffer.length,
    fileName: sanitizeFileName(path.basename(imagePath)) || 'image.png',
  };
}

async function loadRemoteImagePayload(imageUrl) {
  const res = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 20 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 yuque-exporter-feishu-uploader',
      'Referer': 'https://www.yuque.com/',
    },
  });
  const buffer = Buffer.from(res.data);
  return {
    buffer,
    size: buffer.length,
    fileName: fileNameFromUrl(imageUrl, res.headers['content-type']),
    contentType: res.headers['content-type'],
  };
}

function fileNameFromUrl(imageUrl, contentType) {
  let parsedName = '';
  try {
    parsedName = path.basename(new URL(imageUrl).pathname);
  } catch (e) {
    parsedName = '';
  }

  parsedName = sanitizeFileName(decodeURIComponent(parsedName || ''));
  if (path.extname(parsedName)) return parsedName;

  const extByType = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
  };
  return (parsedName || 'image') + (extByType[String(contentType || '').split(';')[0]] || '.png');
}

function sanitizeFileName(fileName) {
  return String(fileName || '').replace(/[\\/:*?"<>|]/g, '_');
}

function extractAuthCode(input) {
  const value = String(input || '').trim();
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.searchParams.get('code') || value;
  } catch (e) {
    return value;
  }
}

/**
 * 主函数
 */
async function main() {
  info('=== 飞书文档上传工具 (SDK 版本) ===\n');

  const markdownPath = path.resolve(__dirname, CONFIG.markdownDir);
  if (!fs.existsSync(markdownPath)) {
    error('目录不存在: ' + markdownPath);
    return;
  }

  info('本地化 Markdown 图片: ' + markdownPath);
  const imageStats = await localizeMarkdownImages(markdownPath, CONFIG.imageAssetDir);
  info('本地图片目录: ' + imageStats.assetRoot);
  success(
    '图片本地化完成：扫描 ' + imageStats.filesScanned +
    ' 个 Markdown，发现 ' + imageStats.imagesFound +
    ' 张图片，下载 ' + imageStats.imagesDownloaded +
    ' 张，复用 ' + imageStats.imagesReused +
    ' 张，缓存命中 ' + imageStats.imagesCached +
    ' 次，已是本地路径 ' + imageStats.localImages +
    ' 张，更新 ' + imageStats.filesUpdated + ' 个 Markdown'
  );

  if (!CONFIG.appId || !CONFIG.appSecret) {
    error('请在 .env 文件中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
    return;
  }

  if (!CONFIG.wikiSpaceId) {
    error('请在 .env 文件中配置 FEISHU_WIKI_SPACE_ID');
    return;
  }

  if (CONFIG.wikiParentNodeToken) {
    info('目标父节点: ' + CONFIG.wikiParentNodeToken);
  } else {
    warn('未配置 FEISHU_WIKI_PARENT_NODE_TOKEN，将上传到知识库根部');
  }

  const api = new FeishuApi(CONFIG.appId, CONFIG.appSecret);

  if (api.loadUserToken()) {
    info('已加载保存的 user_access_token');
  } else {
    console.log('\n' + colors.yellow + '========================================');
    console.log('需要飞书账号授权，请按以下步骤操作：');
    console.log('========================================' + colors.reset);
    console.log('\n1. 点击下面的链接完成授权：\n');
    console.log(colors.green + api.getAuthUrl() + colors.reset + '\n');
    console.log('2. 授权后，把跳转 URL 中 code= 后面的内容粘贴过来\n');

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise(resolve => rl.question('请输入授权码: ', resolve));
    rl.close();

    if (!code) {
      error('未提供授权码，退出');
      return;
    }

    try {
      const tokenData = await api.getUserAccessToken(extractAuthCode(code));
      api.setUserToken(tokenData.access_token);
      api.saveUserToken(tokenData);
      success('user_access_token 获取成功');
    } catch (e) {
      error('获取 token 失败: ' + (e.response?.data?.msg || e.message));
      return;
    }
  }

  // 测试连接
  try {
    await api.getTenantAccessToken();
    success('飞书连接成功');
  } catch (e) {
    error('飞书连接失败');
    return;
  }

  // 获取目录结构
  info('扫描目录: ' + markdownPath);
  const structure = await getDirectoryStructure(markdownPath);

  let totalFiles = 0;
  function countFiles(items) {
    for (const item of items) {
      if (item.type === 'file') totalFiles++;
      else if (item.children) countFiles(item.children);
    }
  }
  countFiles(structure);
  info('共 ' + totalFiles + ' 个文件\n');
  if (CONFIG.reuploadExisting) {
    warn('已开启覆盖重传：复用已有文档时会先写入新内容，成功后删除旧内容');
  }
  const stats = { foldersCreated: 0, foldersReused: 0, filesUploaded: 0, filesReuploaded: 0, filesSkipped: 0, failed: 0 };

  // 上传文件
  async function uploadItems(items, parentToken, depth = 0) {
    for (const item of items) {
      if (item.type === 'folder') {
        const hasFiles = (items) => {
          for (const i of items) {
            if (i.type === 'file') return true;
            if (i.type === 'folder' && i.children && hasFiles(i.children)) return true;
          }
          return false;
        };

        if (!hasFiles(item.children || [])) {
          info('跳过空文件夹: ' + item.name);
          continue;
        }

        const folderTitle = item.name;
        info('准备目录节点: ' + folderTitle);
        let newNodeToken = parentToken;

        try {
          const result = await api.getOrCreateWikiNode(folderTitle, parentToken, CONFIG.wikiSpaceId);
          newNodeToken = result.node.node_token;
          if (result.reused) {
            stats.foldersReused++;
            info('复用目录节点: ' + folderTitle);
          } else {
            stats.foldersCreated++;
            success('创建成功: ' + folderTitle);
          }
        } catch (e) {
          stats.failed++;
          if (isMissingAuthScopeError(e)) {
            throw new Error(getMissingAuthScopeHint(e));
          }
          if (isNodePermissionError(e)) {
            throw new Error('目标 Wiki 节点权限不足，需要当前飞书授权用户拥有编辑权限');
          }
          warn('创建文件夹失败，将在当前目录创建: ' + getApiErrorMessage(e));
        }

        if (item.children) {
          await uploadItems(item.children, newNodeToken, depth + 1);
        }
      } else {
        const title = item.name.replace(/\.(md|csv)$/, '');
        const prefix = '  '.repeat(depth);
        info(prefix + '上传: ' + title);

        try {
          let content = fs.readFileSync(item.fullPath, 'utf-8');
          if (item.name.endsWith('.csv')) {
            content = csvToMarkdownTable(content);
          }
          const markdownOptions = {
            baseDir: path.dirname(item.fullPath),
          };

          const doc = await api.getOrCreateDoc(title, parentToken, CONFIG.wikiSpaceId);
          if (doc.reused) {
            const existingBlocks = await api.getDocBlocks(doc.documentToken);
            if (existingBlocks.length > 1) {
              if (CONFIG.reuploadExisting) {
                info(prefix + '覆盖已有内容: ' + title);
                await api.replaceMarkdownContent(doc.documentToken, content, markdownOptions);
                stats.filesReuploaded++;
                stats.filesUploaded++;
                success(prefix + '上传成功: ' + title);
                continue;
              } else {
                stats.filesSkipped++;
                info(prefix + '跳过已有内容: ' + title);
                continue;
              }
            }
          }

          await api.writeMarkdownContent(doc.documentToken, content, markdownOptions);

          stats.filesUploaded++;
          success(prefix + '上传成功: ' + title);
        } catch (e) {
          stats.failed++;
          if (isMissingAuthScopeError(e)) {
            throw new Error(getMissingAuthScopeHint(e));
          }
          if (isNodePermissionError(e)) {
            throw new Error('目标 Wiki 节点权限不足，需要当前飞书授权用户拥有编辑权限');
          }
          error(prefix + '上传失败 ' + title + ': ' + getApiErrorMessage(e));
        }
      }
    }
  }

  await uploadItems(structure, CONFIG.wikiParentNodeToken);

  if (stats.failed > 0) {
    error('上传结束，但有 ' + stats.failed + ' 个失败');
    process.exitCode = 1;
    return;
  }

  success(
    '上传完成：创建 ' + stats.foldersCreated +
    ' 个目录节点，复用 ' + stats.foldersReused +
    ' 个目录节点，上传 ' + stats.filesUploaded +
    ' 个文档，覆盖重传 ' + stats.filesReuploaded +
    ' 个文档，跳过 ' + stats.filesSkipped + ' 个已有文档'
  );
}

main().catch(e => {
  error('程序异常: ' + e.message);
  console.error(e);
  process.exitCode = 1;
});
