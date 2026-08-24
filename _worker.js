// 汇聚订阅 Worker
// 访问 /{TOKEN} 获取订阅,浏览器访问返回编辑页
// 订阅转换后端默认使用 sub-c.1231818.xyz

let mytoken = 'auto';                              // 订阅入口路径,建议改复杂
let MainData = '';                                 // 默认节点(绑定 KV 后失效)
let subConverter = 'sub-c.1231818.xyz';            // 订阅转换后端
let subConfig = 'https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini';
let subProtocol = 'https';
let FileName = 'sub';                              // 订阅文件名
let SUBUpdateTime = 6;                             // 订阅更新间隔(小时)

export default {
	async fetch(request, env) {
		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : 'null';
		const url = new URL(request.url);
		const token = url.searchParams.get('token');

		// 读取环境变量覆盖默认值
		mytoken = env.TOKEN || mytoken;
		subConverter = env.SUBAPI || subConverter;
		if (subConverter.includes('http://')) {
			subConverter = subConverter.split('//')[1];
			subProtocol = 'http';
		} else if (subConverter.includes('https://')) {
			subConverter = subConverter.split('//')[1];
			subProtocol = 'https';
		}
		subConfig = env.SUBCONFIG || subConfig;
		FileName = env.SUBNAME || FileName;
		SUBUpdateTime = env.SUBUPTIME || SUBUpdateTime;

		// fakeToken:基于 TOKEN + 当天日期,供订阅转换后端回调使用,每日变化
		const currentDate = new Date();
		currentDate.setHours(0, 0, 0, 0);
		const timeTemp = Math.ceil(currentDate.getTime() / 1000);
		const fakeToken = await MD5(`${mytoken}${timeTemp}`);

		// 判断是否为合法订阅入口
		const isTokenMatch = token === mytoken
			|| token === fakeToken
			|| url.pathname === '/' + mytoken
			|| url.pathname.includes('/' + mytoken + '?')
			|| url.pathname === '/' + fakeToken
			|| url.pathname.includes('/' + fakeToken + '?');

		if (!isTokenMatch) {
			// 非订阅入口,返回 nginx 伪装页
			if (url.pathname === '/' || url.pathname === '/favicon.ico') {
				return new Response(nginxHTML(), {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=UTF-8' }
				});
			}
			return new Response('Not Found', { status: 404 });
		}

		// fakeToken 回调:供订阅转换后端拉取节点,直接返回 base64
		if (token === fakeToken || url.pathname === '/' + fakeToken) {
			const data = env.KV ? (await env.KV.get('LINK.txt') || '') : (env.LINK || MainData);
			const links = await ADD(data);
			const [nodes] = await fetchAllSub(links, request, 'v2rayn', userAgentHeader);
			const merged = dedup(nodes.join('\n'));
			return new Response(base64Encode(merged), {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		// 真实 TOKEN 入口
		// 绑定 KV 时,浏览器访问返回编辑页
		if (env.KV && userAgent.includes('mozilla') && !url.search) {
			return editPage(request, env, url, mytoken);
		}

		// 读取主数据
		let MainList = '';
		if (env.KV) {
			MainList = await env.KV.get('LINK.txt') || '';
		} else {
			MainList = env.LINK || MainData;
		}

		// 分离自建节点与订阅链接
		const allLinks = await ADD(MainList);
		let 自建节点 = '';
		let 订阅链接 = '';
		for (const x of allLinks) {
			if (!x) continue;
			if (x.toLowerCase().startsWith('http')) 订阅链接 += x + '\n';
			else 自建节点 += x + '\n';
		}

		// 识别订阅格式(按 UA 或 query 参数)
		let 订阅格式 = 'base64';
		if (!userAgent.includes('mozilla') && !userAgent.includes('null')) {
			if (userAgent.includes('sing-box') || userAgent.includes('singbox') || url.searchParams.has('sb') || url.searchParams.has('singbox')) {
				订阅格式 = 'singbox';
			} else if (userAgent.includes('surge') || url.searchParams.has('surge')) {
				订阅格式 = 'surge';
			} else if (userAgent.includes('quantumult') || url.searchParams.has('quanx')) {
				订阅格式 = 'quanx';
			} else if (userAgent.includes('loon') || url.searchParams.has('loon')) {
				订阅格式 = 'loon';
			} else if (userAgent.includes('clash') || userAgent.includes('meta') || userAgent.includes('mihomo') || url.searchParams.has('clash')) {
				订阅格式 = 'clash';
			}
		}
		if (url.searchParams.has('b64') || url.searchParams.has('base64')) 订阅格式 = 'base64';

		// 拉取订阅链接
		const 订阅链接数组 = [...new Set((await ADD(订阅链接)).filter(item => item?.trim?.()))];
		let req_data = 自建节点;
		let 订阅转换URL = `${url.origin}/${fakeToken}?token=${fakeToken}`;

		if (订阅链接数组.length > 0) {
			const [nodes, subUrls] = await fetchAllSub(订阅链接数组, request, 'v2rayn', userAgentHeader);
			req_data += nodes.join('\n');
			if (subUrls) 订阅转换URL += '|' + subUrls;
		}

		// base64 直接返回
		if (订阅格式 === 'base64') {
			return new Response(base64Encode(dedup(req_data)), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'Profile-Update-Interval': `${SUBUpdateTime}`,
					'Profile-web-page-url': request.url.split('?')[0]
				}
			});
		}

		// 其他格式调用转换后端
		const target = 订阅格式;
		const extraParams = 订阅格式 === 'surge' ? '&ver=4' : (订阅格式 === 'quanx' ? '&udp=true' : '');
		const subConverterUrl = `${subProtocol}://${subConverter}/sub?target=${target}&url=${encodeURIComponent(订阅转换URL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true${extraParams}`;

		try {
			const resp = await fetch(subConverterUrl, { headers: { 'User-Agent': userAgentHeader || 'v2rayN' } });
			if (!resp.ok) {
				return new Response(base64Encode(dedup(req_data)), {
					headers: { 'content-type': 'text/plain; charset=utf-8' }
				});
			}
			const content = await resp.text();
			const ext = 订阅格式 === 'clash' ? 'yaml' : (订阅格式 === 'singbox' ? 'json' : 'conf');
			return new Response(content, {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'Profile-Update-Interval': `${SUBUpdateTime}`,
					'Content-Disposition': `attachment; filename*=utf-8''${encodeURIComponent(FileName)}.${ext}`
				}
			});
		} catch (e) {
			return new Response(base64Encode(dedup(req_data)), {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}
	}
};

// 字符串转数组(按换行分割,去空)
async function ADD(envadd) {
	if (!envadd) return [];
	let text = envadd.replace(/[ \t"'|\r\n]+/g, '\n').replace(/\n+/g, '\n').trim();
	if (!text) return [];
	return text.split('\n');
}

// 去重
function dedup(text) {
	const lines = new Set(text.split('\n'));
	return [...lines].filter(l => l?.trim()).join('\n');
}

// UTF-8 安全的 base64 编码
function base64Encode(str) {
	try {
		return btoa(str);
	} catch (e) {
		const bytes = new TextEncoder().encode(str);
		let binary = '';
		for (const b of bytes) binary += String.fromCharCode(b);
		return btoa(binary);
	}
}

// MD5(使用 Web Crypto,Cloudflare Workers 支持)
async function MD5(text) {
	const encoder = new TextEncoder();
	const data = await crypto.subtle.digest('MD5', encoder.encode(text));
	const arr = Array.from(new Uint8Array(data));
	return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 并发拉取多个订阅,2s 超时
async function fetchAllSub(apiList, request, appendUA, userAgentHeader) {
	if (!apiList || apiList.length === 0) return [[], ''];
	apiList = [...new Set(apiList)];
	const nodes = [];
	const subUrls = [];
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2000);
	try {
		const results = await Promise.allSettled(apiList.map(apiUrl => {
			return fetch(apiUrl, {
				headers: { 'User-Agent': userAgentHeader || appendUA },
				signal: controller.signal
			}).then(r => r.ok ? r.text() : Promise.reject(r));
		}));
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.status === 'fulfilled' && r.value) {
				const text = r.value.trim();
				// 尝试 base64 解码
				let decoded = text;
				try {
					if (!text.includes('://')) {
						decoded = atob(text);
					}
				} catch (e) {
					// 非 base64,直接用原文
				}
				nodes.push(decoded);
				subUrls.push(apiList[i]);
			}
		}
	} catch (e) {
		// 超时或异常,返回已获取的
	} finally {
		clearTimeout(timeout);
	}
	return [nodes, subUrls.join('|')];
}

// 编辑页(含密码保护)
async function editPage(request, env, url, token) {
	const currentData = env.KV ? (await env.KV.get('LINK.txt') || '') : (env.LINK || '');
	const hasPassword = env.ADMIN_PASSWORD ? 'true' : 'false';

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>订阅编辑</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	background: #f5f7fa;
	color: #2c3e50;
	padding: 20px;
	line-height: 1.6;
}
.container {
	max-width: 900px;
	margin: 0 auto;
	background: #fff;
	border-radius: 12px;
	box-shadow: 0 2px 12px rgba(0,0,0,0.08);
	overflow: hidden;
}
.header {
	background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
	color: #fff;
	padding: 20px 24px;
}
.header h1 { font-size: 20px; font-weight: 600; }
.header .sub { font-size: 13px; opacity: 0.9; margin-top: 4px; }
.content { padding: 24px; }
.section { margin-bottom: 24px; }
.section-title {
	font-size: 14px;
	font-weight: 600;
	color: #606266;
	margin-bottom: 12px;
	display: flex;
	justify-content: space-between;
	align-items: center;
}
textarea {
	width: 100%;
	min-height: 300px;
	padding: 12px;
	border: 1px solid #dcdfe6;
	border-radius: 8px;
	font-family: "SF Mono", Monaco, "Cascadia Code", Consolas, monospace;
	font-size: 13px;
	resize: vertical;
	background: #fafafa;
	color: #2c3e50;
}
textarea:focus { outline: none; border-color: #667eea; }
.btn-group { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
button {
	padding: 10px 20px;
	border: none;
	border-radius: 8px;
	font-size: 14px;
	cursor: pointer;
	transition: all 0.2s;
	font-weight: 500;
}
.btn-primary { background: #667eea; color: #fff; }
.btn-primary:hover { background: #5568d3; }
.btn-secondary { background: #f0f2f5; color: #606266; }
.btn-secondary:hover { background: #e4e7ed; }
.info {
	background: #ecf5ff;
	border: 1px solid #d9ecff;
	border-radius: 8px;
	padding: 12px 16px;
	font-size: 13px;
	color: #409eff;
	margin-bottom: 16px;
}
.link-box {
	background: #f0f9ff;
	padding: 10px 14px;
	border-radius: 8px;
	font-family: monospace;
	font-size: 12px;
	color: #1f2d3d;
	word-break: break-all;
	border: 1px solid #d9ecff;
}
/* 密码保护遮罩 */
.lock-overlay {
	position: absolute;
	top: 0; left: 0; right: 0; bottom: 0;
	backdrop-filter: blur(20px);
	-webkit-backdrop-filter: blur(20px);
	background: rgba(255,255,255,0.3);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10;
	border-radius: 12px;
}
.lock-box {
	background: #fff;
	padding: 28px 32px;
	border-radius: 12px;
	box-shadow: 0 8px 32px rgba(0,0,0,0.15);
	text-align: center;
	min-width: 280px;
}
.lock-box h3 { font-size: 16px; margin-bottom: 14px; color: #303133; }
.lock-box input {
	width: 100%;
	padding: 10px 12px;
	border: 1px solid #dcdfe6;
	border-radius: 6px;
	font-size: 14px;
	margin-bottom: 12px;
}
.lock-box input:focus { outline: none; border-color: #667eea; }
.lock-box .error { color: #f56c6c; font-size: 12px; margin-top: 8px; min-height: 16px; }
.relative { position: relative; }
.hidden { display: none; }
</style>
</head>
<body>
<div class="container">
	<div class="header">
		<h1>汇聚订阅管理</h1>
		<div class="sub">添加节点链接(vless/vmess/trojan/hysteria2 等)或订阅链接,每行一个</div>
	</div>
	<div class="content">
		<div class="info">
			订阅地址(填入客户端):
			<div class="link-box" id="subUrl"></div>
		</div>
		<div class="section relative" id="editSection">
			<div class="section-title">
				<span>节点与订阅列表</span>
				<span id="nodeCount" style="font-weight:400;color:#909399;font-size:12px"></span>
			</div>
			<textarea id="links" placeholder="vless://...
vmess://...
trojan://...
https://sub.example.com/auto"></textarea>
			<div class="btn-group">
				<button class="btn-primary" onclick="saveLinks()">保存</button>
				<button class="btn-secondary" onclick="clearLinks()">清空</button>
				<button class="btn-secondary" onclick="copySub()">复制订阅地址</button>
			</div>
			<div id="lockOverlay" class="lock-overlay hidden">
				<div class="lock-box">
					<h3>需要管理密码</h3>
					<input type="password" id="pwdInput" placeholder="输入管理密码" onkeydown="if(event.key==='Enter')unlock()">
					<button class="btn-primary" style="width:100%" onclick="unlock()">解锁</button>
					<div class="error" id="pwdError"></div>
				</div>
			</div>
		</div>
	</div>
</div>
<script>
const HAS_PASSWORD = ${hasPassword};
const TOKEN = ${JSON.stringify(token)};
const SUB_URL = location.origin + '/' + TOKEN;

document.getElementById('subUrl').textContent = SUB_URL;
document.getElementById('links').value = ${JSON.stringify(currentData)};
updateCount();

if (HAS_PASSWORD) {
	const unlocked = localStorage.getItem('sub_unlocked_' + TOKEN);
	if (unlocked === '1') {
		document.getElementById('lockOverlay').classList.add('hidden');
	} else {
		document.getElementById('lockOverlay').classList.remove('hidden');
	}
}

function updateCount() {
	const v = document.getElementById('links').value;
	const lines = v.split('\\n').filter(l => l.trim());
	document.getElementById('nodeCount').textContent = lines.length + ' 条';
}

document.getElementById('links').addEventListener('input', updateCount);

function unlock() {
	const pwd = document.getElementById('pwdInput').value;
	fetch('?action=verify', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({password: pwd})
	}).then(r => r.json()).then(data => {
		if (data.ok) {
			localStorage.setItem('sub_unlocked_' + TOKEN, '1');
			localStorage.setItem('sub_pwd_' + TOKEN, document.getElementById('pwdInput').value);
			document.getElementById('lockOverlay').classList.add('hidden');
		} else {
			document.getElementById('pwdError').textContent = '密码错误';
		}
	}).catch(() => {
		document.getElementById('pwdError').textContent = '验证失败,请重试';
	});
}

function saveLinks() {
	if (HAS_PASSWORD && !document.getElementById('lockOverlay').classList.contains('hidden')) {
		alert('请先解锁');
		return;
	}
	const data = document.getElementById('links').value;
	fetch('?action=save', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({links: data, password: localStorage.getItem('sub_pwd_' + TOKEN) || ''})
	}).then(r => r.json()).then(data => {
		alert(data.ok ? '保存成功' : '保存失败: ' + (data.msg || ''));
		if (data.ok) updateCount();
	}).catch(e => alert('保存失败: ' + e));
}

function clearLinks() {
	if (!confirm('确认清空所有节点?')) return;
	document.getElementById('links').value = '';
	updateCount();
}

function copySub() {
	navigator.clipboard.writeText(SUB_URL).then(() => alert('已复制: ' + SUB_URL));
}
</script>
</body>
</html>`;

	// 处理 POST 请求(保存/验证密码)
	if (request.method === 'POST') {
		const body = await request.json();
		const action = url.searchParams.get('action');

		if (action === 'verify') {
			const ok = env.ADMIN_PASSWORD && body.password === env.ADMIN_PASSWORD;
			if (ok) {
				// 记录密码用于后续保存校验
				return new Response(JSON.stringify({ ok: true }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response(JSON.stringify({ ok: false, msg: '密码错误' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (action === 'save') {
			// 启用密码时,后端二次校验
			if (env.ADMIN_PASSWORD) {
				if (body.password !== env.ADMIN_PASSWORD) {
					return new Response(JSON.stringify({ ok: false, msg: '密码错误或已过期,请重新解锁' }), {
						headers: { 'Content-Type': 'application/json' }
					});
				}
			}
			if (!env.KV) {
				return new Response(JSON.stringify({ ok: false, msg: '未绑定 KV 命名空间' }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			try {
				await env.KV.put('LINK.txt', body.links || '');
				return new Response(JSON.stringify({ ok: true }), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, msg: e.message }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}
	}

	return new Response(html, {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=UTF-8' }
	});
}

// nginx 伪装首页
function nginxHTML() {
	return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
	body {
		width: 35em;
		margin: 0 auto;
		font-family: Tahoma, Verdana, Arial, sans-serif;
	}
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}
