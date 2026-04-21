# 飞书文档上传工具

将语雀导出的 Markdown / CSV 文档批量上传到飞书知识库。

## 配置步骤

### 1. 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 点击「创建企业自建应用」
3. 获取 **App ID** 和 **App Secret**

### 2. 配置应用权限

在应用详情页 → 「权限管理」中开通以下权限：
- `docx:document:readonly` - 读取文档
- `docx:document:create` - 创建文档
- `docx:document:write_only` - 写入文档
- `docx:document.block:convert` - 将 Markdown 转换为飞书原生块
- `docs:document.media:upload` - 上传文档图片素材
- `drive:file:upload` - 上传文档图片素材
- `wiki:node:create` - 创建 Wiki 节点
- `wiki:node:read` - 读取 Wiki 节点
- `wiki:node:retrieve` - 查询 Wiki 节点
- `wiki:wiki` / `wiki:wiki:readonly` - 读写 Wiki
- `wiki:space:retrieve` - 读取 Wiki 空间信息

### 3. 获取目标 Wiki 信息

1. 打开飞书，进入目标知识库或目标父页面
2. 点击「复制链接」
3. URL 格式：`https://example.feishu.cn/wiki/xxxxxx`
4. `xxxxxx` 就是 `FEISHU_WIKI_PARENT_NODE_TOKEN`
5. 还需要在 `.env` 中配置目标知识库的 `FEISHU_WIKI_SPACE_ID`

### 4. 编辑配置

在 `feishu-uploader/.env` 中配置：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxx
FEISHU_WIKI_SPACE_ID=xxxxxxxxxx
FEISHU_WIKI_PARENT_NODE_TOKEN=xxxxxx
FEISHU_MARKDOWN_DIR=../docs/你的知识库名称
FEISHU_DOWNLOAD_IMAGES=true
FEISHU_IMAGE_ASSET_DIR=_images
FEISHU_UPLOAD_IMAGES=true
FEISHU_USE_CONVERT_API=true
FEISHU_REUPLOAD_EXISTING=false
```

### 5. 运行

```bash
cd feishu-uploader
node upload.js
```

覆盖重传已有文档：

```bash
node upload.js --reupload-existing
```

覆盖重传会先写入新内容，成功后再删除旧内容，避免写入失败时把已有文档清空。

只测试飞书 Markdown 转换权限和基础块类型，不上传文档：

```bash
node upload.js --test-convert
```

只下载图片并改写本地 Markdown，不上传飞书：

```bash
node upload.js --download-images-only
```

## 支持的文件类型

| 类型 | 处理方式 |
|------|---------|
| `.md` | 直接通过飞书 convert API 转为原生块 |
| `.csv` | 转为 Markdown 表格后走 convert API |

## 项目结构

```
feishu-uploader/
├── upload.js          # 主程序
├── test-api.js        # API 连通性测试
├── user_token.json    # 缓存的 OAuth 用户令牌
├── package.json       # 依赖配置
└── README.md          # 说明文档
```

## 注意事项

- 支持 Markdown 基本格式：标题、列表、代码块、引用、链接、加粗、斜体、表格
- 默认使用飞书官方 Markdown 转块接口，标题、列表、代码块、引用、分割线、表格等会尽量转成飞书原生结构
- 官方转换结果会按父子块关系写入，超过飞书单次 1000 descendants 限制时会自动分批
- 默认先把远程 Markdown 图片下载到 Markdown 根目录的 `_images`，再把 md 图片链接改成相对本地路径
- Markdown 本地图片会上传为飞书图片块；设置 `FEISHU_UPLOAD_IMAGES=false` 可退回为图片链接文本
- 代码块支持常用语言高亮

## 获取帮助

如遇问题，请检查：
1. 飞书应用是否已发布
2. 权限是否都已开通
3. folderToken 是否正确
