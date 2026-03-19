# 🚀 RomanceSpace-Backend (VPS 小白保姆级部署指南)

本项目为 RomanceSpace 架构中的**核心后台**。以下步骤专为 Ubuntu 24 (2核2G) VPS 编写，全程通过 SSH 命令行终端操作，直接从 GitHub 拉取代码并运行。

---

## 🟢 第一阶段：VPS 环境准备 (安装 Node.js 和 Git)

打开您的电脑终端（Windows 按 `Win+R` 输入 `cmd`，Mac 打开“终端”），通过 SSH 连接到您的 VPS：
```bash
ssh root@您的VPS公网IP
```
*(输入密码时屏幕不会显示字符，输完按回车即可)*

连接成功后，依次复制以下命令并按回车执行（每行执行完等它跑完再执行下一行）：

```bash
# 1. 更新系统软件库
sudo apt update && sudo apt upgrade -y

# 2. 安装必备工具 (Git, curl)
sudo apt install -y git curl build-essential

# 3. 下载并安装 Node.js (推荐稳定版 20.x，完美兼容 Ubuntu 24)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 4. 验证是否安装成功 (应该会打印出版号，如 v20.x.x)
node -v
npm -v

# 5. 全局安装 PM2 (守护进程工具，让后台哪怕你关了电脑也能一直跑)
sudo npm install -g pm2
```

---

## 🟡 第二阶段：从 GitHub 拉取代码并配置密钥

我们将把代码存放在 `/opt/RomanceSpace-Backend` 目录中。

```bash
# 1. 进入 /opt 目录
cd /opt

# 2. 从 GitHub 克隆您的仓库代码
# (请把下面的网址换成您真实的 RomanceSpace-Backend GitHub 仓库地址)
git clone https://github.com/您的用户名/RomanceSpace-Backend.git

# 3. 进入刚刚下载好的代码文件夹
cd RomanceSpace-Backend

# 4. 安装项目依赖包 (这一步可能需要几十秒)
npm install

# 5. 创建真实的配置文件 (这一步不需要用到 Git 里的 example，直接在这里新建最稳妥)
nano .env
```

**⚠️ Nano 编辑器小白操作指南：**
1. 此时屏幕会变成一个全黑的文本编辑器。
2. 请在您的电脑上，复制下方我帮您整理好的**终极模板代码**。
3. 把这些内容**直接粘贴**（在黑框里点击鼠标右键即可粘贴）进入黑框中，并把带有 `[填写...]` 的中文字眼替换成您真实的密钥。

**👇 您需要粘贴进黑框的 .env 完整底稿：**
```ini
# ── Server ──────────────────────────────────────────────────────────────
PORT=3000

# ── Admin Auth ──────────────────────────────────────────────────────────
# 保护你的后台不被陌生人乱传模板（请自己填一个复杂的密码，只有你能用）
ADMIN_KEY=[填写一个您自己想好的密码，比如 MY_SEC_123]

# ── Cloudflare Account ──────────────────────────────────────────────────
# 这两个用来在用户修改网页后，去CF刷新边缘CDN全球缓存
CF_ACCOUNT_ID=05a5c87d8fc5a9ccfa0dfa0600ea06cc
CF_API_TOKEN=[填写 CF API 令牌，就是那个 o11 开头的长串]
CF_ZONE_ID=[填写刚才在 CF 主页面右下角找到的 32 位区域 ID]

# ── Cloudflare KV ───────────────────────────────────────────────────────
# 存放路标（告诉你哪个域名前缀存活）
CF_KV_NAMESPACE_ID=726287eac5274a80b9df18217d43b0f0

# ── Cloudflare R2 (S3-compatible) ───────────────────────────────────────
# 把 html 和你的模板骨架全存在这里
CF_R2_BUCKET=romancespace-templates
CF_R2_ACCESS_KEY_ID=[填写刚刚新建的 R2 访问密钥 ID]
CF_R2_SECRET_ACCESS_KEY=[填写刚刚新建的 R2 机密访问密钥]
CF_R2_ENDPOINT=https://<新 CF Account ID>.r2.cloudflarestorage.com

# ── Supabase (防白嫖、计次扣费、抢注隔离墙) ─────────────────────
SUPABASE_URL=https://djcfqtrbfjaykdyperpf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=[填写刚刚在 Supabase 找到的那一长串以 eyJh 开头的密钥]
```

4. 粘贴并修改完属于您的那 6 个中文字段后：
   - 按 `Ctrl + O` (字母O)，然后按 `回车(Enter)` 确认保存。
   - 按 `Ctrl + X` 退出编辑器回到命令行主界面。

---

## 🟠 第三阶段：一键点火启动后台服务

此时您仍在 `/opt/RomanceSpace-Backend` 目录下：

```bash
# 1. 启动服务，并给它起个名字叫 romancespace-api
pm2 start src/app.js --name romancespace-api

# 2. 保存当前运行的列表，开机自启
pm2 save
pm2 startup
```

**测试一下是否活了：**
输入下面这行命令：
```bash
curl http://127.0.0.1:3000/health
```
如果屏幕打印出类似 `{"ok":true,"service":"romancespace-backend"}` 的字样，恭喜你，后端的代码已经跑通了！

---

## � 第四阶段：配置 Nginx 域名绑定与 HTTPS 绿锁

为了让前端能够通过域名 `https://api.885201314.xyz` 安全地访问到你 VPS 里的 3000 端口，我们需要安装 Nginx。

*(前提：请确保您已经在 Cloudflare 的 DNS 解析里，把 `api.885201314.xyz` 的 A 记录指向了这台 VPS 的公网 IP！并且在此步骤中先把云朵点灰，即仅限 DNS)*

```bash
# 1. 安装 Nginx 和申请 HTTPS 证书的机器人工具
sudo apt install -y nginx certbot python3-certbot-nginx

# 2. 自动申请 HTTPS 证书并绑定域名！
# (运行后会问你邮箱地址填一下，然后问你是否同意协议按 Y，问是否分享邮箱按 N)
sudo certbot --nginx -d api.885201314.xyz
```

`certbot` 会自动改写 Nginx 的配置文件，非常智能。但是我们还需要最后微调一下，把流量转发给 3000 端口：

```bash
# 使用 nano 打开 Nginx 配置文件
sudo nano /etc/nginx/sites-available/default
```

用方向键一直往下拉，找到写着 `server_name api.885201314.xyz;` 的那个 `server { ... }` 块。
找到里面的 `location / { ... }` 这一段，把它修改成下面这样：

```nginx
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
```

保存退出 (`Ctrl+O` -> `回车` -> `Ctrl+X`)。

最后，重启 Nginx 让配置生效：
```bash
sudo systemctl restart nginx
```

🎉 **大功告成！全剧终！**
现在，在您的电脑浏览器里输入 `https://api.885201314.xyz/health`，如果能看到内容，说明所有的网络、端口、后台代码都完美串联工作了！

---

## 🔗 前后端联动配置 (重要)

当您的后端 API 域名 `https://api.885201314.xyz` 部署成功后，您需要去 **RomanceSpace-Frontend** 项目中做一次最后的对齐：

1.  如果您是在 **Cloudflare Pages** 托管前端：
    -   去 Pages 控制台 -> `设置` -> `环境变量`。
    -   添加一个变量：`VITE_API_BASE_URL`，值填入 `https://api.885201314.xyz`。
    -   重新触发一次部署。
2.  如果不配置这个变量，前端默认会去请求 `localhost:3000`，这会导致浏览器报错。

如果您后续在本地改了代码推送到 GitHub，只需要在 VPS 里输 `cd /opt/RomanceSpace-Backend` 然后 `git pull` 然后 `pm2 restart romancespace-api` 就更新好了。
