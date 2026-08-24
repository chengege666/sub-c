# sub-c 汇聚订阅

将多个节点和订阅合并为单一订阅链接,部署到 Cloudflare Pages。

## 部署

1. Fork 或推本仓库到 GitHub
2. Cloudflare Pages → 创建项目 → 连接 Git → 选仓库
3. 框架预设:留空;构建命令:留空;输出目录:留空
4. 部署后,进入项目设置:
   - **函数 → KV 命名空间绑定**:变量名 `KV`,选择你的 KV 命名空间(如未创建,先在 Workers & Pages → KV 中创建)
   - **环境变量**:添加下列变量
5. 绑定自定义域后访问 `https://你的域名/auto` 进入编辑页

## 变量

| 变量名 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `TOKEN` | 是 | `auto` | 订阅入口路径,如 `/auto` |
| `KV` | 是 | - | KV 命名空间绑定,存储节点 |
| `SUBAPI` | 否 | `sub-c.1231818.xyz` | 订阅转换后端 |
| `SUBCONFIG` | 否 | ACL4SSR_Online_MultiCountry.ini | 订阅转换配置 |
| `SUBNAME` | 否 | `sub` | 订阅文件名 |
| `SUBUPTIME` | 否 | `6` | 订阅更新间隔(小时) |
| `ADMIN_PASSWORD` | 否 | - | 编辑页密码,不配置则不启用 |
| `LINK` | 否 | - | 节点列表(绑定 KV 后失效) |
