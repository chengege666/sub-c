// 汇聚订阅 Worker
// 访问 /{TOKEN} 获取订阅,浏览器访问返回编辑页
// 订阅转换后端默认使用 sub-c.1231818.xyz

let mytoken = 'auto';                              // 订阅入口路径,建议改复杂
let MainData = '';                                 // 默认节点(绑定 KV 后失效)
let subConverter = 'sub-c.1231818.xyz';            // 订阅转换后端
let subConfig = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_MultiCountry.ini';
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

		// ---- 统一加载主数据(自建节点 + 订阅链接)----
		let MainList = '';
		if (env.KV) {
			MainList = await env.KV.get('LINK.txt') || '';
		} else {
			MainList = env.LINK || MainData;
		}
		const allLinks = await ADD(MainList);
		let 自建节点 = '';
		let 订阅链接 = '';
		for (const x of allLinks) {
			if (!x) continue;
			if (x.toLowerCase().startsWith('http')) 订阅链接 += x + '\n';
			else 自建节点 += x + '\n';
		}
		const 订阅链接数组 = [...new Set((await ADD(订阅链接)).filter(item => item?.trim?.()))];
		let 外部订阅节点 = [];
		let 外部订阅URLs = '';
		if (订阅链接数组.length > 0) {
			const [nodes, subUrls] = await fetchAllSub(订阅链接数组, request, 'v2rayn', userAgentHeader);
			外部订阅节点 = nodes;
			外部订阅URLs = subUrls;
		}
		// 所有明文节点(自建 + 外部订阅明文/base64 解码)统一合并去重
		const 所有明文节点 = dedup(自建节点 + '\n' + 外部订阅节点.join('\n'));

		// ---- 识别是否为订阅转换后端的回调请求:强制返回 base64(避免递归)----
		const isSubConverterRequest =
			request.headers.get('subconverter-request')
			|| request.headers.get('subconverter-version')
			|| userAgent.includes('subconverter');

		// fakeToken 回调(订阅转换后端回调):返回 base64 合并的明文节点
		// 注意:token == fakeToken 时也要覆盖 subconverter 回调判断
		const isFakeTokenRequest = token === fakeToken || url.pathname === '/' + fakeToken;
		if (isFakeTokenRequest || isSubConverterRequest) {
			return new Response(base64Encode(所有明文节点), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'Profile-Update-Interval': `${SUBUpdateTime}`
				}
			});
		}

		// 真实 TOKEN 入口
		// 绑定 KV 时,浏览器访问返回编辑页(含 POST 请求的密码校验/保存)
		if (env.KV && userAgent.includes('mozilla')) {
			return editPage(request, env, url, mytoken);
		}

		// 识别订阅格式(按 UA 或 query 参数)
		// 默认返回 Clash YAML(90%+ 客户端支持),仅明确命中通用客户端时才 base64
		let 订阅格式 = 'clash';
		if (!userAgent.includes('mozilla') && !userAgent.includes('null')) {
			const ual = userAgent.toLowerCase();
			// ---- 明确要求 base64 的通用客户端(放前面,避免被 clash UA 误匹配)----
			if (
				ual.includes('v2rayn') ||
				ual.includes('v2rayng') ||
				ual.includes('nekobox') ||
				ual.includes('nekoray') ||
				ual.includes('shadowrocket') ||
				ual.includes('shadowsocks') ||
				ual.includes('ssray') ||
				ual.includes('ssr') ||
				ual.includes('v2box') ||
				ual.includes('sagernet') ||
				url.searchParams.has('b64') ||
				url.searchParams.has('base64')
			) {
				订阅格式 = 'base64';
			// ---- SingBox ----
			} else if (ual.includes('sing-box') || ual.includes('singbox') || url.searchParams.has('sb') || url.searchParams.has('singbox')) {
				订阅格式 = 'singbox';
			// ---- Surge / Surfboard ----
			} else if (ual.includes('surge') || ual.includes('surfboard') || url.searchParams.has('surge')) {
				订阅格式 = 'surge';
			// ---- Quantumult X ----
			} else if (ual.includes('quantumult') || url.searchParams.has('quanx')) {
				订阅格式 = 'quanx';
			// ---- Loon ----
			} else if (ual.includes('loon') || url.searchParams.has('loon')) {
				订阅格式 = 'loon';
			// ---- Clash / Mihomo 系 ----
			} else if (
				ual.includes('clash') ||
				ual.includes('meta') ||
				ual.includes('mihomo') ||
				ual.includes('clashforwindows') ||
				ual.includes('clash for windows') ||
				ual.includes('clashverge') ||
				ual.includes('clash-verge') ||
				ual.includes('mihomo-party') ||
				ual.includes('stash') ||
				ual.includes('karing') ||
				ual.includes('hiddify') ||
				ual.includes('dlercloud') ||
				ual.includes('cfa') ||
				url.searchParams.has('clash')
			) {
				订阅格式 = 'clash';
			}
			// 其他未识别 UA → 保持默认 clash
		}
		// query 参数强制覆盖
		if (url.searchParams.has('b64') || url.searchParams.has('base64')) 订阅格式 = 'base64';

		// base64 直接返回(含 自建节点 + 外部订阅明文/base64 解码结果)
		if (订阅格式 === 'base64') {
			return new Response(base64Encode(所有明文节点), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'Profile-Update-Interval': `${SUBUpdateTime}`,
					'Profile-web-page-url': request.url.split('?')[0]
				}
			});
		}

		// 构造给 subconverter 的 url 参数:
		//   1. fakeToken 回调 URL(拉取自建节点 + 外部订阅明文)
		//   2. 外部 Clash/Singbox 结构化订阅原始 URL(用 | 分隔)
		let 订阅转换URL = `${url.origin}/${fakeToken}?token=${fakeToken}`;
		if (外部订阅URLs) 订阅转换URL += '|' + 外部订阅URLs;

		// 其他格式调用转换后端
		const target = 订阅格式;
		const extraParams = 订阅格式 === 'surge' ? '&ver=4' : (订阅格式 === 'quanx' ? '&udp=true' : '');
		const subConverterUrl = `${subProtocol}://${subConverter}/sub?target=${target}&url=${encodeURIComponent(订阅转换URL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true${extraParams}`;

		try {
			const resp = await fetch(subConverterUrl, { headers: { 'User-Agent': userAgentHeader || 'v2rayN' } });
			if (!resp.ok) throw new Error('subconverter http ' + resp.status);
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
			// 结构化格式客户端:转换失败时返回对应格式的最小可用配置(含错误注释),防止 parse 错
			const nodes = dedup(req_data);
			const fallback = buildFallbackConfig(订阅格式, nodes, String(e.message || e));
			return new Response(fallback.body, { headers: fallback.headers });
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

// UTF-8 安全的 base64 解码
function base64Decode(str) {
	try {
		const bytes = new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
		return new TextDecoder('utf-8').decode(bytes);
	} catch (e) {
		return atob(str);
	}
}

// 判断是否为合法 base64(忽略空白字符)
function isValidBase64(str) {
	if (!str) return false;
	const clean = str.replace(/\s/g, '');
	if (clean.length === 0 || clean.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/=]+$/.test(clean);
}

// MD5(使用 Web Crypto,Cloudflare Workers 支持)
async function MD5(text) {
	const encoder = new TextEncoder();
	const data = await crypto.subtle.digest('MD5', encoder.encode(text));
	const arr = Array.from(new Uint8Array(data));
	return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 订阅转换后端失败时:构造结构化格式的最小可用配置(防止客户端 parse 崩)
function buildFallbackConfig(format, nodesRaw, errMsg) {
	const errLine = `ERROR: subconverter failed: ${errMsg}`;
	const b64 = base64Encode(dedup(nodesRaw || ''));
	const commonHeaders = {
		'content-type': 'text/plain; charset=utf-8',
		'Profile-Update-Interval': `${SUBUpdateTime}`
	};
	if (format === 'clash') {
		const yaml = `# ${errLine}
# 订阅转换后端不可用,以下为降级配置(不含分流规则,节点全局代理)
mixed-port: 7890
external-controller: 127.0.0.1:9090
allow-lan: false
mode: rule
log-level: info
ipv6: true
proxies: []
proxy-groups:
  - name: PROXY
    type: select
    proxies: [DIRECT]
rules:
  - MATCH,DIRECT
`;
		return { body: yaml, headers: { ...commonHeaders, 'Content-Disposition': `attachment; filename*=utf-8''${encodeURIComponent(FileName)}.yaml` } };
	}
	if (format === 'singbox') {
		const json = JSON.stringify({
			_comment: errLine + ' / 转换后端不可用,请改用 base64 订阅或修复转换后端',
			log: { level: 'info' },
			dns: { servers: [{ tag: 'local', address: '223.5.5.5' }] },
			inbounds: [],
			outbounds: [{ type: 'direct', tag: 'direct' }],
			routes: [{ action: 'direct', final: 'direct' }]
		}, null, 2);
		return { body: json, headers: { ...commonHeaders, 'Content-Disposition': `attachment; filename*=utf-8''${encodeURIComponent(FileName)}.json` } };
	}
	// surge / quanx / loon: 统一返回简单 conf,客户端至少能打开
	const conf = `# ${errMsg}\n# 订阅转换后端不可用,请改用 base64 订阅或修复转换后端\n[General]\nloglevel = notify\n`;
	return { body: conf, headers: { ...commonHeaders, 'Content-Disposition': `attachment; filename*=utf-8''${encodeURIComponent(FileName)}.conf` } };
}

// 并发拉取多个订阅,2s 超时
// 返回 [nodesPlain(明文节点行数组), subConverterUrls(给 subconverter 直接转发的 URL 字符串,用 | 连接)]
// 分类处理:
//   - 含 proxies: → Clash 订阅 → 只记录 URL(给 subconverter 自己解析)
//   - 含 outbounds" + inbounds" → Singbox 订阅 → 只记录 URL
//   - 含 :// → 明文(vmess/vless/trojan/ss 等) → 直接追加节点
//   - 合法 base64 → base64 解码后追加
//   - 其他无法识别 → 异常占位节点(便于用户发现)
async function fetchAllSub(apiList, request, appendUA, userAgentHeader) {
	if (!apiList || apiList.length === 0) return [[], ''];
	apiList = [...new Set(apiList)];
	let newapi = '';
	let 订阅转换URLs = '';
	let 异常订阅 = '';
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2000);

	try {
		const results = await Promise.allSettled(apiList.map(apiUrl =>
			fetch(apiUrl, {
				headers: { 'User-Agent': userAgentHeader || appendUA },
				signal: controller.signal
			}).then(r => r.ok ? r.text() : Promise.reject(r))
		));

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			let content = null;
			let apiUrl = apiList[i];
			if (r.status === 'fulfilled') {
				content = r.value;
			} else {
				const reason = r.reason;
				if (reason && reason.name === 'AbortError') {
					content = '超时';
				} else {
					const status = reason && reason.status ? reason.status : '请求失败';
					console.error(`请求失败: ${apiUrl}, 错误信息: ${status}`);
					content = null;
				}
			}

			if (!content) continue;
			if (content === '超时') continue;

			// ---- 分类 ----
			if (content.includes('proxies:')) {
				// Clash YAML 订阅 → 交给 subconverter
				订阅转换URLs += '|' + apiUrl;
			} else if (content.includes('outbounds"') && content.includes('inbounds"')) {
				// Singbox JSON 订阅 → 交给 subconverter
				订阅转换URLs += '|' + apiUrl;
			} else if (content.includes('://')) {
				// 明文节点/订阅 → 直接拼接
				newapi += content + '\n';
			} else if (isValidBase64(content)) {
				// base64 订阅 → 解码后拼接
				try {
					newapi += base64Decode(content) + '\n';
				} catch (e) {
					const 异常订阅LINK = `trojan://subc@127.0.0.1:8888?security=tls&allowInsecure=1&type=tcp&headerType=none#Base64解码失败_${apiUrl.split('://')[1]?.split('/')[0] || apiUrl}`;
					异常订阅 += `${异常订阅LINK}\n`;
				}
			} else {
				// 异常订阅 → 占位节点
				const host = apiUrl.split('://')[1]?.split('/')[0] || apiUrl;
				const 异常订阅LINK = `trojan://subc@127.0.0.1:8888?security=tls&allowInsecure=1&type=tcp&headerType=none#异常订阅_${host}`;
				异常订阅 += `${异常订阅LINK}\n`;
			}
		}
	} catch (e) {
		console.error('fetchAllSub 总异常:', e);
	} finally {
		clearTimeout(timeout);
	}

	const 订阅内容 = await ADD(newapi + 异常订阅);
	return [订阅内容, 订阅转换URLs];
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
	background: #0d1117;
	color: #c9d1d9;
	padding: 20px;
	line-height: 1.6;
}
.container {
	max-width: 900px;
	margin: 0 auto;
	background: #161b22;
	border-radius: 12px;
	box-shadow: 0 2px 12px rgba(0,0,0,0.5);
	overflow: hidden;
}
.header {
	background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
	color: #e6edf3;
	padding: 20px 24px;
	border-bottom: 1px solid #30363d;
}
.header h1 { font-size: 20px; font-weight: 600; color: #e6edf3; }
.header .sub { font-size: 13px; opacity: 0.85; margin-top: 4px; color: #8b949e; }
.content { padding: 24px; }
.section { margin-bottom: 24px; }
.section-title {
	font-size: 14px;
	font-weight: 600;
	color: #c9d1d9;
	margin-bottom: 12px;
	display: flex;
	justify-content: space-between;
	align-items: center;
}
textarea {
	width: 100%;
	min-height: 300px;
	padding: 12px;
	border: 1px solid #30363d;
	border-radius: 8px;
	font-family: "SF Mono", Monaco, "Cascadia Code", Consolas, monospace;
	font-size: 13px;
	resize: vertical;
	background: #0d1117;
	color: #c9d1d9;
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
.btn-secondary { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
.btn-secondary:hover { background: #30363d; }
.info {
	background: #161b22;
	border: 1px solid #30363d;
	border-radius: 8px;
	padding: 12px 16px;
	font-size: 13px;
	color: #58a6ff;
	margin-bottom: 16px;
}
.link-box {
	background: #0d1117;
	padding: 10px 14px;
	border-radius: 8px;
	font-family: monospace;
	font-size: 12px;
	color: #c9d1d9;
	word-break: break-all;
	border: 1px solid #30363d;
}
/* 密码保护遮罩 */
.lock-overlay {
	position: absolute;
	top: 0; left: 0; right: 0; bottom: 0;
	backdrop-filter: blur(20px);
	-webkit-backdrop-filter: blur(20px);
	background: rgba(13,17,23,0.6);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10;
	border-radius: 12px;
}
.lock-box {
	background: #161b22;
	padding: 28px 32px;
	border-radius: 12px;
	box-shadow: 0 8px 32px rgba(0,0,0,0.5);
	text-align: center;
	min-width: 280px;
	border: 1px solid #30363d;
}
.lock-box h3 { font-size: 16px; margin-bottom: 14px; color: #e6edf3; }
.lock-box input {
	width: 100%;
	padding: 10px 12px;
	border: 1px solid #30363d;
	border-radius: 6px;
	font-size: 14px;
	background: #0d1117;
	color: #c9d1d9;
	margin-bottom: 12px;
}
.lock-box input:focus { outline: none; border-color: #667eea; }
.lock-box .error { color: #f85149; font-size: 12px; margin-top: 8px; min-height: 16px; }
.relative { position: relative; }
.hidden { display: none; }
</style>
</head>
<body>
<div class="container">
	<div class="header">
		<h1>订阅管理</h1>
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
	// 每次访问都要求输入密码,不缓存解锁状态
	document.getElementById('lockOverlay').classList.remove('hidden');
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
