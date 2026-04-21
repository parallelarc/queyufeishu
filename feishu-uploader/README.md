# 飞书文档上传工具

将语雀导出的 Markdown / CSV 文档批量上传到飞书知识库。

## 配置步骤

### 1. 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 点击「创建企业自建应用」
3. 获取 **App ID** 和 **App Secret**

### 2. 配置应用权限

在应用详情页 → 「权限管理」中开通以下权限：

| 权限 | 用途 |
|------|------|
| `docx:document:readonly` | 读取文档 |
| `docx:document:create` | 创建文档 |
| `docx:document:write_only` | 写入文档 |
| `docx:document.block:convert` | 将 Markdown 转换为飞书原生块 |
| `docs:document.media:upload` | 上传文档图片素材 |
| `drive:file:upload` | 上传文档图片素材 |
| `wiki:node:create` | 创建 Wiki 节点 |
| `wiki:node:read` | 读取 Wiki 节点 |
| `wiki:node:retrieve` | 查询 Wiki 节点 |
| `wiki:wiki` / `wiki:wiki:readonly` | 读写 Wiki |
| `wiki:space:retrieve` | 读取 Wiki 空间信息 |

### 3. 获取目标 Wiki 信息

需要配置两个值：**Space ID**（必填）和 **Parent Node Token**（可选）。

**获取 Space ID：**
1. 打开飞书，进入目标知识库
2. 点击右上角「设置」→「基本设置」
3. 找到「空间 ID」，复制填入 `FEISHU_WIKI_SPACE_ID`

**获取 Parent Node Token（可选）：**
1. 打开目标父页面（文档或文件夹）
2. 从 URL 中提取 token：
   - `https://xxx.feishu.cn/wiki/ABC123` → token 是 `ABC123`
   - `https://xxx.feishu.cn/docx/ABC123` → token 是 `ABC123`
3. 留空则上传到知识库根部

### 4. 编辑配置

复制示例文件并填写：

```bash
cp .env.example .env
```

`.env` 中所有配置项：

```bash
# 飞书应用凭证（必填）
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxx

# 飞书 Wiki 配置（FEISHU_WIKI_SPACE_ID 必填）
FEISHU_WIKI_SPACE_ID=xxxxxxxxxx
FEISHU_WIKI_PARENT_NODE_TOKEN=       # 留空则上传到知识库根部

# 待上传的文档目录（默认 ../docs）
FEISHU_MARKDOWN_DIR=../docs/你的知识库名称
```

### 5. 首次运行与授权

首次运行时会触发飞书 OAuth 授权流程：

```bash
cd feishu-uploader
node upload.js
```

程序会打印一个授权链接，按以下步骤操作：

1. 复制终端中的链接，在浏览器中打开
2. 登录飞书并点击「授权」
3. 授权后页面会跳转，浏览器地址栏变为：
   `https://open.feishu.cn/connect/landing/component/callback?code=XXXXXX&state=uploader`
4. 复制 `code=` 后面的值（或直接复制整个 URL），粘贴到终端中

授权成功后 token 会缓存在 `user_token.json` 中，后续运行无需重复授权。

### 6. 日常使用

```bash
cd feishu-uploader
node upload.js                        # 增量上传（跳过已有文档）
node upload.js --reupload-existing    # 覆盖重传已有文档
```

## 支持的文件类型

| 类型 | 处理方式 |
|------|---------|
| `.md` | 通过飞书 convert API 转为原生块 |
| `.csv` | 转为 Markdown 表格后走 convert API |

## 工作流程

1. **图片本地化** — 扫描所有文件，将远程图片下载到 `_images/` 目录，改写链接为本地路径
2. **创建 Wiki 节点** — 按本地目录结构在飞书知识库中创建对应的文件夹和文档
3. **内容写入** — 通过飞书官方 convert API 将 Markdown 转为飞书原生块并写入文档
4. **图片上传** — 将本地图片上传为飞书图片块并绑定到文档

## 项目结构

```
feishu-uploader/
├── upload.js          # 主程序
├── user_token.json    # 缓存的 OAuth 用户令牌（自动生成）
├── package.json       # 依赖配置
└── .env               # 本地配置（需自行创建）
```

## 常见问题

**Q: 报错「应用未获取所需的用户授权」**
检查飞书应用是否已发布（版本管理 → 创建版本 → 发布），并确认权限全部开通。

**Q: 报错「目标 Wiki 节点权限不足」**
确保授权的飞书用户对目标知识库拥有编辑权限。

**Q: 如何更换授权账号？**
删除 `user_token.json`，重新运行即可触发授权流程。
