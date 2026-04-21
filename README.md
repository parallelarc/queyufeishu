# Yuque Exporter

语雀知识库导出 + 飞书上传工具集。

## 项目结构

```
yuque_exporter/
├── export.js              # 语雀知识库导出脚本
├── feishu-uploader/       # 飞书文档上传工具
│   ├── upload.js
│   ├── package.json
│   └── .env.example
└── docs/                  # 导出输出目录（git 已忽略）
```

---

## 一、导出语雀文档

### 前置条件

- Node.js >= 18（使用原生 `fetch`）
- 语雀账号的浏览器 Cookie

### 操作步骤

**1. 获取 Cookie 文件**

1. 浏览器登录语雀：`https://tsingroc.yuque.com`
2. 打开浏览器开发者工具 → Network 面板
3. 刷新页面，找到任意请求，复制 `Cookie` 请求头的值
4. 使用 [Cookie Exporter](https://chromewebstore.google.com/detail/cookie-exporter/fhnmmidekmgocpjdceeffppcodigillk) 扩展导出 Cookie 为 JSON 数组格式：

   ```json
   [
     { "name": "_yuque_session", "value": "xxx", ... },
     { "name": "cookie1", "value": "yyy", ... }
   ]
   ```

5. 将 JSON 保存为项目根目录下的 `tsingroc_yuque_com_cookies.json`

> 此文件已在 `.gitignore` 中忽略，不会被提交到 Git。

**2. 运行导出**

```bash
# 导出所有知识库
node export.js

# 只导出指定知识库（按 slug 或名称模糊匹配）
node export.js <slug 或名称关键字>
```

**3. 查看结果**

导出的文档保存在 `docs/` 目录下，按知识库 → 目录结构组织：

```
docs/
└── 知识库名称/
    ├── 章节目录/
    │   ├── 文档1.md
    │   └── 表格数据.csv
    └── 文档2.md
```

- Markdown 文档 → `.md` 文件
- 语雀表格（lakesheet）→ `.csv` 文件
- 已存在的文件会自动跳过（支持断点续传）

**4. Cookie 过期处理**

如果运行报错 `HTTP 401/403`，说明 Cookie 已过期，重新执行步骤 1 获取新的 Cookie 文件即可。

---

## 二、上传到飞书

### 前置条件

- Node.js >= 18
- 飞书开放平台应用（需开通 Wiki 读写权限）

### 操作步骤

**1. 安装依赖**

```bash
cd feishu-uploader
npm install
```

**2. 配置环境变量**

```bash
cp .env.example .env
```

编辑 `.env`，填入飞书应用凭证：

```
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_WIKI_SPACE_ID=your_wiki_space_id
FEISHU_WIKI_PARENT_NODE_TOKEN=your_parent_node_token
```

**3. 获取 user_token（首次使用）**

首次运行会引导 OAuth 授权流程，按提示在浏览器中授权即可。Token 保存到 `user_token.json`。

**4. 运行上传**

```bash
npm run upload
# 或
node upload.js
```

可选参数：

- `--reupload-existing` / `--overwrite`：重新上传已存在的文档
- `--test-convert`：仅测试格式转换，不实际上传

---

## 常见问题

**Q: Cookie 文件从哪来？**
浏览器安装 Cookie 导出扩展（如 EditThisCookie），登录语雀后导出为 JSON，保存到项目根目录。

**Q: 导出失败提示 HTTP 403？**
Cookie 已过期，重新获取即可。

**Q: 导出中断了怎么办？**
直接重新运行，已导出的文件会自动跳过。

**Q: 飞书上传提示权限不足？**
检查飞书应用是否开通了 Wiki 相关权限（`wiki:wiki:read`、`wiki:wiki:write`），并确认 user_token 未过期。
