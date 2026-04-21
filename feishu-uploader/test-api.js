/**
 * 测试飞书 API
 */
require('dotenv').config();
const axios = require('axios');

const CONFIG = {
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  wikiNodeToken: process.env.FEISHU_WIKI_PARENT_NODE_TOKEN,
};

if (!CONFIG.appId || !CONFIG.appSecret) {
  console.error('请在 .env 文件中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  process.exit(1);
}

async function main() {
  console.log('=== 测试飞书 API ===\n');

  // 获取 Token
  console.log('1. 获取 Access Token...');
  const tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: CONFIG.appId,
    app_secret: CONFIG.appSecret,
  });
  const token = tokenRes.data.tenant_access_token;
  console.log('   Token:', token ? '成功' : '失败');

  const headers = { Authorization: `Bearer ${token}` };

  // 测试创建文件夹
  console.log('\n2. 测试创建 Wiki 文件夹...');
  try {
    const createRes = await axios.post('https://open.feishu.cn/open-apis/wiki/v2/spaces/create_node', {
      obj_type: 'folder',
      parent_node_token: CONFIG.wikiNodeToken,
      node_type: 'folder',
      title: '测试文件夹-' + Date.now(),
    }, { headers });

    console.log('   创建成功!');
    console.log('   响应:', JSON.stringify(createRes.data, null, 2));

    const nodeToken = createRes.data.data?.node_token;
    console.log('   Node Token:', nodeToken);

    // 测试创建文档
    console.log('\n3. 测试创建 Wiki 文档...');
    const docRes = await axios.post('https://open.feishu.cn/open-apis/wiki/v2/spaces/create_node', {
      obj_type: 'doc',
      parent_node_token: nodeToken || CONFIG.wikiNodeToken,
      node_type: 'doc',
      title: '测试文档-' + Date.now(),
    }, { headers });

    console.log('   创建成功!');
    const docNodeToken = docRes.data.data?.node_token;
    console.log('   Doc Node Token:', docNodeToken);

    // 获取 document_token
    if (docNodeToken) {
      console.log('\n4. 获取 Document Token...');
      const nodeInfoRes = await axios.get(
        `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${docNodeToken}`,
        { headers }
      );
      const documentToken = nodeInfoRes.data.data?.document_token;
      console.log('   Document Token:', documentToken);

      // 写入内容
      if (documentToken) {
        console.log('\n5. 写入文档内容...');
        const blocks = [
          {
            block_type: 4,
            heading1: {
              elements: [{ text_run: { content: '测试标题' } }],
              style: {}
            }
          },
          {
            block_type: 2,
            text: {
              elements: [{ text_run: { content: '这是一段测试内容。' } }],
              style: {}
            }
          }
        ];

        const writeRes = await axios.post(
          `https://open.feishu.cn/open-apis/docx/v1/documents/${documentToken}/blocks/batch_create`,
          { children: blocks, index: 0 },
          { headers }
        );
        console.log('   写入成功!');
        console.log('   响应:', JSON.stringify(writeRes.data, null, 2));
      }
    }
  } catch (e) {
    console.error('   失败:', e.message);
    if (e.response) {
      console.error('   响应:', JSON.stringify(e.response.data, null, 2));
    }
  }

  console.log('\n=== 测试完成 ===');
}

main().catch(e => {
  console.error('异常:', e.message);
  if (e.response) console.error('响应:', JSON.stringify(e.response.data, null, 2));
});
