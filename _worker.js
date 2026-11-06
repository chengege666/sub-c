// 汇聚订阅 Worker
// 访问 /{TOKEN} 获取订阅,浏览器访问返回编辑页
// 所有配置请通过 Cloudflare Pages 环境变量设置

// ================= 默认配置(常量) =================
// 说明:原实现把 TOKEN / SUBAPI / SUBCONFIG / SUBNAME / SUBUPTIME 放在模块级 let 变量里,
// 每个请求都改写一次。同一个 isolate 并发处理多个请求时会互相污染
// (例如 http 协议的转换后端与 https 协议的转换后端串台、TOKEN 串台)。
// 这里改为不可变默认值 + 请求级 cfg 对象,业务函数不再读写模块级可变状态。
const DEFAULT_MAIN_DATA = '';                 // 默认节点(绑定 KV 后失效)
const DEFAULT_SUB_CONFIG = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Full_MultiMode.ini';
const DEFAULT_SUB_PROTOCOL = 'https';
const DEFAULT_FILE_NAME = 'sub';              // 订阅文件名,可留空使用默认
const DEFAULT_SUB_UPDATE_TIME = 6;            // 订阅更新间隔(小时),可留空使用默认

const SUB_FETCH_TIMEOUT = 10000;              // 单个外部订阅抓取超时(毫秒)
const SUB_CONVERT_TIMEOUT = 15000;            // 订阅转换后端超时(毫秒)
const AUTH_TTL = 12 * 60 * 60 * 1000;         // 编辑页登录态有效期(毫秒)
const MAX_EDIT_BYTES = 512 * 1024;            // 编辑页最大提交体积

export default {
	async fetch(request, env) {
		// 每个请求独立配置,避免并发污染
		const cfg = buildRequestConfig(env);
		const url = new URL(request.url);
		const userAgentHeader = request.headers.get('User-Agent') || '';
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : 'null';
		const token = url.searchParams.get('token');

		// 必填变量未配置时返回错误提示
		if (!cfg.token || !cfg.subConverter) {
			if (url.pathname === '/' || url.pathname === '/favicon.ico') {
				return htmlResponse(nginxHTML());
			}
			const missing = [];
			if (!cfg.token) missing.push('TOKEN');
			if (!cfg.subConverter) missing.push('SUBAPI');
			return new Response('Error: Missing required environment variable(s): ' + missing.join(', ') + '. Please configure them in Cloudflare Pages settings.', { status: 500 });
		}

		// fakeToken:基于 TOKEN + 当天日期,供订阅转换后端回调使用,每日变化
		// 同时保留昨天与今天的值,避免跨零点时后端缓存的回调地址失效
		const fake = await buildFakeTokens(cfg.token);
		const fakeToken = fake.today;

		// 判断是否为合法订阅入口
		const isFakeTokenRequest =
			token === fake.today ||
			token === fake.yesterday ||
			url.pathname === '/' + fake.today ||
			url.pathname === '/' + fake.yesterday;
		const isTokenMatch = token === cfg.token || isFakeTokenRequest || url.pathname === '/' + cfg.token;

		if (!isTokenMatch) {
			// 非订阅入口,返回 nginx 伪装页
			if (url.pathname === '/' || url.pathname === '/favicon.ico') {
				return htmlResponse(nginxHTML());
			}
			return new Response('Not Found', { status: 404 });
		}

		// ---- 统一加载主数据(自建节点 + 订阅链接)----
		const loaded = await loadMainList(cfg);
		const MainList = loaded.text;
		// KV 读取失败且没有可回退的 LINK 时明确报错,避免返回"空订阅"让客户端静默失效
		if (loaded.error && !String(MainList || '').trim()) {
			return new Response('Error: KV 读取失败且 LINK 为空: ' + loaded.error, { status: 500 });
		}
		const allLinks = await ADD(MainList);
		let 自建节点 = '';
		let 订阅链接文本 = '';
		for (const x of allLinks) {
			if (!x) continue;
			if (/^https?:\/\//i.test(x)) 订阅链接文本 += x + '\n';
			else 自建节点 += x + '\n';
		}
		const 订阅链接数组 = [...new Set((await ADD(订阅链接文本)).filter(item => item && item.trim()))];
		let 外部订阅节点 = [];
		let 结构化订阅URLs = [];
		if (订阅链接数组.length > 0) {
			const fetched = await fetchAllSub(cfg, 订阅链接数组, userAgentHeader, 'v2rayn');
			外部订阅节点 = fetched.nodes;
			结构化订阅URLs = fetched.structuredUrls;
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
		if (isFakeTokenRequest || isSubConverterRequest) {
			return new Response(base64Encode(所有明文节点), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'Profile-Update-Interval': `${cfg.subUpdateTime}`
				}
			});
		}

		// 真实 TOKEN 入口
		// 绑定 KV 时,浏览器访问返回编辑页(含 POST 请求的密码校验/保存)
		// 但显式的格式参数(?clash=1 / ?b64=1 等)优先,方便在浏览器中直接预览订阅
		const queryFormat = detectQueryFormat(url);
		if (cfg.kv && userAgent.includes('mozilla') && (request.method === 'POST' || !queryFormat)) {
			return editPage(request, cfg, url);
		}

		// 识别订阅格式:URL query 参数 > User-Agent > 默认 Clash YAML
		let 订阅格式 = queryFormat || detectUAFormat(userAgent) || 'clash';

		// base64 直接返回(含 自建节点 + 外部订阅明文/base64 解码结果)
		// 结构化订阅(Clash YAML / Sing-box JSON)在 base64 模式下不能丢弃,
		// 这里用转换后端把它们转成明文节点后再合并。
		if (订阅格式 === 'base64') {
			let merged = 所有明文节点;
			if (结构化订阅URLs.length > 0) {
				const converted = await convertStructuredSubs(cfg, 结构化订阅URLs, userAgentHeader);
				merged = dedup([merged, converted.links].filter(Boolean).join('\n'));
			}
			return new Response(base64Encode(merged), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'Profile-Update-Interval': `${cfg.subUpdateTime}`,
					'Profile-web-page-url': request.url.split('?')[0]
				}
			});
		}

		// 构造给 subconverter 的 url 参数:
		//   1. fakeToken 回调 URL(拉取自建节点 + 外部订阅明文)
		//   2. 外部 Clash/Singbox 结构化订阅原始 URL(用 | 分隔)
		const 订阅转换URL = buildSourceUrl(url.origin, fakeToken, 结构化订阅URLs);

		// 其他格式调用转换后端:先带 config 转换,失败后去掉 config 再试一次
		// (绝大多数故障是规则文件不可达,而不是节点无法解析)
		let content = '';
		let convertError = '';
		try {
			content = await requestConvert(cfg, 订阅格式, 订阅转换URL, userAgentHeader, true);
		} catch (primaryError) {
			convertError = errText(primaryError);
			try {
				content = await requestConvert(cfg, 订阅格式, 订阅转换URL, userAgentHeader, false);
			} catch (secondError) {
				convertError += ' / ' + errText(secondError);
				content = '';
			}
		}

		if (!content) {
			return buildFailureResponse(cfg, 订阅格式, 所有明文节点, convertError);
		}

		// 后端有时会返回 200 但内容里没有任何代理节点(看似正常,实际不可用)
		const emptyResult =
			订阅格式 === 'clash' ? !hasClashProxies(content) :
			(订阅格式 === 'singbox' ? !hasSingboxOutbounds(content) : false);
		if (emptyResult) {
			return buildFailureResponse(cfg, 订阅格式, 所有明文节点, '转换结果不包含任何代理节点');
		}

		let body = content;
		if (订阅格式 === 'clash') {
			body = fixXHTTPDowngrade(fixRealityMLKEM(fixAnyTLSFingerprint(content)), 所有明文节点);
		}
		const ext = 订阅格式 === 'clash' ? 'yaml' : (订阅格式 === 'singbox' ? 'json' : 'conf');
		return new Response(body, { headers: buildDownloadHeaders(cfg, ext) });
	}
};

// ================= 请求级配置 =================

// 解析 SUBAPI:支持 "sub.example.com"、"https://sub.example.com"、"https://sub.example.com/sub"
function normalizeSubApi(raw) {
	let value = String(raw == null ? '' : raw).trim();
	if (!value) return { protocol: DEFAULT_SUB_PROTOCOL, host: '' };
	let protocol = DEFAULT_SUB_PROTOCOL;
	if (/^http:\/\//i.test(value)) {
		protocol = 'http';
		value = value.slice(7);
	} else if (/^https:\/\//i.test(value)) {
		protocol = 'https';
		value = value.slice(8);
	}
	value = value.replace(/[?#].*$/, '');   // 去掉多余的查询参数/锚点
	value = value.replace(/\/+$/, '');      // 去掉末尾斜杠
	value = value.replace(/\/sub$/i, '');   // 允许配置成 .../sub 结尾
	return { protocol, host: value };
}

// 订阅文件名:去掉控制字符与引号,避免响应头注入
function sanitizeFileName(raw) {
	const text = String(raw == null ? '' : raw)
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/["\\]/g, '')
		.trim();
	return text || DEFAULT_FILE_NAME;
}

// 更新间隔:必须是正整数小时,上限 168(一周)
function sanitizeUpdateTime(raw) {
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_SUB_UPDATE_TIME;
	return Math.min(n, 168);
}

function buildRequestConfig(env) {
	const source = env || {};
	const api = normalizeSubApi(source.SUBAPI || '');
	return {
		token: String(source.TOKEN == null ? '' : source.TOKEN),
		subProtocol: api.protocol,
		subConverter: api.host,
		subConfig: String(source.SUBCONFIG || DEFAULT_SUB_CONFIG),
		fileName: sanitizeFileName(source.SUBNAME || DEFAULT_FILE_NAME),
		subUpdateTime: sanitizeUpdateTime(source.SUBUPTIME == null ? DEFAULT_SUB_UPDATE_TIME : source.SUBUPTIME),
		adminPassword: source.ADMIN_PASSWORD ? String(source.ADMIN_PASSWORD) : '',
		kv: source.KV || null,
		link: source.LINK || DEFAULT_MAIN_DATA
	};
}

// 读取主数据:KV 优先,读取失败时回退到 LINK,避免整站直接空掉
async function loadMainList(cfg) {
	if (!cfg.kv) return { text: cfg.link || '', error: '' };
	try {
		const value = await cfg.kv.get('LINK.txt');
		return { text: value || '', error: '' };
	} catch (e) {
		console.error('KV 读取失败:', errText(e));
		return { text: cfg.link || '', error: errText(e) };
	}
}

// 构造响应头
function buildDownloadHeaders(cfg, ext) {
	return {
		'content-type': 'text/plain; charset=utf-8',
		'Profile-Update-Interval': `${cfg.subUpdateTime}`,
		'Content-Disposition': `attachment; filename*=utf-8''${encodeURIComponent(cfg.fileName)}.${ext}`,
		'Cache-Control': 'no-store'
	};
}

function htmlResponse(html, extraHeaders) {
	const headers = Object.assign({ 'Content-Type': 'text/html; charset=UTF-8' }, extraHeaders || {});
	return new Response(html, { status: 200, headers });
}

function jsonResponse(data, status) {
	return new Response(JSON.stringify(data), {
		status: status || 200,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store'
		}
	});
}

function errText(e) {
	if (!e) return '未知错误';
	if (typeof e === 'string') return e;
	if (e.message) return String(e.message);
	return String(e);
}

// 字符串转数组(按换行分割,去空)
// 修复点:不再按空格/引号全量切割,避免把节点名里的空格切碎导致节点损坏;
// 只在一行里确实存在 "空格 + 新协议链接" 时才拆开。
async function ADD(envadd) {
	if (!envadd) return [];
	const text = String(envadd).replace(/\r\n?/g, '\n').replace(/\|/g, '\n');
	const result = [];
	for (const raw of text.split('\n')) {
		let line = raw.trim();
		if (!line) continue;
		// 去掉成对的包裹引号(仅当整行被引号包裹时)
		const quoted = line.match(/^(["'])([\s\S]*)\1$/);
		if (quoted) line = quoted[2].trim();
		if (!line) continue;
		// 一行里粘了多个链接时按 "空格 + 协议" 拆开
		const parts = line.split(/\s+(?=[a-z][a-z0-9+.-]*:\/\/)/i);
		for (const part of parts) {
			const item = part.trim();
			if (item) result.push(item);
		}
	}
	return result;
}

// 去重
function dedup(text) {
	const lines = new Set();
	for (const raw of String(text == null ? '' : text).split('\n')) {
		const line = raw.trim();
		if (line) lines.add(line);
	}
	return [...lines].join('\n');
}

// ================= fakeToken / MD5 =================

// 当天 0 点(UTC)的秒数,dayOffset 为偏移天数
function startOfDaySeconds(dayOffset) {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	if (dayOffset) d.setDate(d.getDate() + dayOffset);
	return Math.ceil(d.getTime() / 1000);
}

// fakeToken 生成:今天与昨天各一个,验证与生成使用同一套算法
async function buildFakeTokens(token) {
	const today = startOfDaySeconds(0);
	const yesterday = today - 86400;
	return {
		today: await MD5(`${token}${today}`),
		yesterday: await MD5(`${token}${yesterday}`),
		todaySeconds: today
	};
}

// MD5(纯 JS 实现)
// 修复点:Cloudflare Workers 的 crypto.subtle 只支持 SHA-1/256/384/512,
// 传入 'MD5' 会抛 NotSupportedError,导致 fakeToken 直接不可用。
async function MD5(text) {
	return md5Hex(String(text == null ? '' : text));
}

// 标准 MD5(小端 32 位运算),输入按 UTF-8 编码
function md5Hex(input) {
	const msg = new TextEncoder().encode(input);
	const bitLen = msg.length * 8;
	const padLen = (((msg.length + 8) >> 6) + 1) << 6;
	const buffer = new Uint8Array(padLen);
	buffer.set(msg);
	buffer[msg.length] = 0x80;
	const view = new DataView(buffer.buffer);
	view.setUint32(padLen - 8, bitLen >>> 0, true);
	view.setUint32(padLen - 4, Math.floor(bitLen / 4294967296), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
	const K = new Uint32Array(64);
	for (let i = 0; i < 64; i++) {
		K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
	}
	const M = new Uint32Array(16);

	for (let offset = 0; offset < buffer.length; offset += 64) {
		for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true);
		let A = a0;
		let B = b0;
		let C = c0;
		let D = d0;
		for (let i = 0; i < 64; i++) {
			let F;
			let g;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}
			F = (F + A + K[i] + M[g]) >>> 0;
			A = D;
			D = C;
			C = B;
			const shift = shifts[(i >> 4) * 4 + (i % 4)];
			B = (B + ((F << shift) | (F >>> (32 - shift)))) >>> 0;
		}
		a0 = (a0 + A) >>> 0;
		b0 = (b0 + B) >>> 0;
		c0 = (c0 + C) >>> 0;
		d0 = (d0 + D) >>> 0;
	}

	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setUint32(0, a0, true);
	outView.setUint32(4, b0, true);
	outView.setUint32(8, c0, true);
	outView.setUint32(12, d0, true);
	let hex = '';
	for (const b of out) hex += b.toString(16).padStart(2, '0');
	return hex;
}

// ================= 客户端格式识别 =================
// 优先级:URL query 参数 > User-Agent > 默认 clash
// 多个冲突参数时,按下面数组的顺序取第一个"明确开启"的
const FORMAT_PARAM_GROUPS = [
	{ format: 'base64', keys: ['b64', 'base64'] },
	{ format: 'singbox', keys: ['sb', 'singbox'] },
	{ format: 'clash', keys: ['clash'] },
	{ format: 'surge', keys: ['surge'] },
	{ format: 'quanx', keys: ['quanx'] },
	{ format: 'loon', keys: ['loon'] }
];

function isFlagOn(value) {
	const text = String(value == null ? '' : value).trim().toLowerCase();
	if (!text) return true; // 只写 key 不写值时视为开启
	return !(text === '0' || text === 'false' || text === 'no' || text === 'off');
}

function detectQueryFormat(url) {
	for (const group of FORMAT_PARAM_GROUPS) {
		for (const key of group.keys) {
			if (!url.searchParams.has(key)) continue;
			if (isFlagOn(url.searchParams.get(key))) return group.format;
		}
	}
	return null;
}

function detectUAFormat(userAgent) {
	const ual = String(userAgent == null ? '' : userAgent).toLowerCase();
	if (!ual || ual === 'null' || ual.includes('mozilla')) return null;
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
		ual.includes('sagernet')
	) {
		return 'base64';
	}
	// ---- SingBox ----
	if (ual.includes('sing-box') || ual.includes('singbox')) return 'singbox';
	// ---- Surge / Surfboard ----
	if (ual.includes('surge') || ual.includes('surfboard')) return 'surge';
	// ---- Quantumult X ----
	if (ual.includes('quantumult')) return 'quanx';
	// ---- Loon ----
	if (ual.includes('loon')) return 'loon';
	// ---- Clash / Mihomo 系 ----
	if (
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
		ual.includes('cfa')
	) {
		return 'clash';
	}
	// 其他未识别 UA → 交给默认格式
	return null;
}

// ================= 外部订阅抓取 =================

// 带超时的 fetch(每个请求独立 AbortController,互不影响)
async function fetchWithTimeout(target, options, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(target, Object.assign({}, options || {}, { signal: controller.signal }));
	} finally {
		clearTimeout(timer);
	}
}

// 生成异常订阅占位节点(让用户在客户端能直接看到哪条订阅失败,而不是被静默丢弃)
function placeholderNode(prefix, target) {
	const host = getHostLabel(target);
	return `trojan://subc@127.0.0.1:8888?security=tls&allowInsecure=1&type=tcp&headerType=none#${encodeURIComponent(prefix + '_' + host)}`;
}

function getHostLabel(target) {
	try {
		const u = new URL(String(target));
		return u.host || String(target).slice(0, 60);
	} catch (e) {
		return String(target == null ? '' : target).slice(0, 60) || 'unknown';
	}
}

// 并发拉取多个订阅
// 返回 {
//   nodes: 明文节点行数组,
//   structuredUrls: Clash YAML / Sing-box JSON 订阅 URL 数组,
//   reports: [{ url, status, kind, detail }] 每个订阅的结果(成功/失败/超时)
// }
// 分类处理:
//   - 含 proxies: → Clash 订阅 → 记录 URL(交给 subconverter 解析)
//   - 含 outbounds" + inbounds" → Singbox 订阅 → 记录 URL
//   - 含 :// → 明文(vmess/vless/trojan/ss 等) → 直接追加节点
//   - 合法 base64 → base64 解码后追加
//   - 其他无法识别 / 请求失败 / 超时 → 异常占位节点(便于用户发现)
async function fetchAllSub(cfg, apiList, userAgentHeader, appendUA) {
	const result = { nodes: [], structuredUrls: [], reports: [] };
	if (!apiList || apiList.length === 0) return result;
	const urls = [...new Set(apiList)];
	const ua = userAgentHeader || appendUA;

	const settled = await Promise.all(urls.map(async (apiUrl) => {
		try {
			const resp = await fetchWithTimeout(apiUrl, { headers: { 'User-Agent': ua } }, SUB_FETCH_TIMEOUT);
			if (!resp.ok) {
				return { url: apiUrl, status: 'http', detail: 'HTTP ' + resp.status };
			}
			return { url: apiUrl, status: 'ok', content: await resp.text() };
		} catch (e) {
			if (e && e.name === 'AbortError') {
				return { url: apiUrl, status: 'timeout', detail: '超过 ' + SUB_FETCH_TIMEOUT + 'ms' };
			}
			return { url: apiUrl, status: 'error', detail: errText(e) };
		}
	}));

	for (const item of settled) {
		if (item.status !== 'ok') {
			console.error(`订阅获取失败: ${item.url}, 状态: ${item.status}, 详情: ${item.detail}`);
			result.reports.push({ url: item.url, status: item.status, kind: 'unknown', detail: item.detail });
			result.nodes.push(placeholderNode(item.status === 'timeout' ? '订阅超时' : '请求失败', item.url));
			continue;
		}

		const content = item.content || '';
		const kind = classifySubContent(content);
		result.reports.push({ url: item.url, status: 'ok', kind, detail: '' });

		if (kind === 'clash' || kind === 'singbox') {
			// Clash YAML / Sing-box JSON → 交给 subconverter
			result.structuredUrls.push(item.url);
		} else if (kind === 'plain') {
			result.nodes.push(content);
		} else if (kind === 'base64') {
			const decoded = tryBase64Decode(content);
			if (decoded && decoded.includes('://')) {
				result.nodes.push(decoded);
			} else {
				result.nodes.push(placeholderNode('Base64解码失败', item.url));
			}
		} else {
			// 内容无法识别 → 占位节点,避免静默丢失
			result.nodes.push(placeholderNode('异常订阅', item.url));
		}
	}

	const 订阅内容 = await ADD(result.nodes.join('\n'));
	result.nodes = 订阅内容;
	return result;
}

// 订阅内容分类
function classifySubContent(content) {
	const text = String(content == null ? '' : content);
	if (!text.trim()) return 'unknown';
	// Clash / Mihomo YAML
	if (/^\s*proxies\s*:/m.test(text) || /^\s*proxy-groups\s*:/m.test(text)) return 'clash';
	// Sing-box JSON(部分客户端配置不带 inbounds,这里以可解析的 outbounds 为准)
	if (/"outbounds"\s*:/.test(text)) {
		try {
			const json = JSON.parse(text);
			if (json && Array.isArray(json.outbounds)) return 'singbox';
		} catch (e) { /* 不是合法 JSON,继续往下判断 */ }
	}
	// 明文节点
	if (/^[a-z][a-z0-9+.-]*:\/\//im.test(text)) return 'plain';
	// base64
	if (isValidBase64(text)) {
		const decoded = tryBase64Decode(text);
		if (decoded && /^[a-z][a-z0-9+.-]*:\/\//im.test(decoded)) return 'base64';
	}
	return 'unknown';
}

// 把结构化订阅(Clash YAML / Sing-box JSON)转成明文节点
// 用于 ?b64=1 场景,保证结构化订阅不会被遗漏
async function convertStructuredSubs(cfg, urls, userAgentHeader) {
	const links = [];
	if (!urls || urls.length === 0) return { links: '' };
	await Promise.all(urls.map(async (apiUrl) => {
		try {
			const query = [
				'target=v2ray',
				'url=' + encodeURIComponent(apiUrl),
				'insert=false',
				'emoji=false',
				'list=false',
				'tfo=false',
				'scv=true',
				'fdn=false',
				'sort=false',
				'new_name=false'
			].join('&');
			const endpoint = `${cfg.subProtocol}://${cfg.subConverter}/sub?${query}`;
			const resp = await fetchWithTimeout(endpoint, { headers: { 'User-Agent': userAgentHeader || 'v2rayN' } }, SUB_CONVERT_TIMEOUT);
			if (!resp.ok) throw new Error('subconverter http ' + resp.status);
			const text = (await resp.text()).trim();
			const plain = extractPlainLinks(text);
			if (!plain) throw new Error('转换结果无法解析为节点');
			links.push(plain);
		} catch (e) {
			console.error(`结构化订阅转换失败: ${apiUrl}, 错误: ${errText(e)}`);
			links.push(placeholderNode('转换失败', apiUrl));
		}
	}));
	return { links: links.join('\n') };
}

// 从任意文本中提取明文节点(支持明文与 base64 两种返回)
function extractPlainLinks(text) {
	const raw = String(text == null ? '' : text).trim();
	if (!raw) return '';
	if (/^[a-z][a-z0-9+.-]*:\/\//im.test(raw)) {
		return raw.split('\n').map(l => l.trim()).filter(l => l && l.includes('://')).join('\n');
	}
	const decoded = tryBase64Decode(raw);
	if (decoded && /^[a-z][a-z0-9+.-]*:\/\//im.test(decoded)) {
		return decoded.split('\n').map(l => l.trim()).filter(l => l && l.includes('://')).join('\n');
	}
	return '';
}

// ================= 订阅转换后端 =================

function buildSourceUrl(origin, fakeToken, structuredUrls) {
	let source = `${origin}/${encodeURIComponent(fakeToken)}?token=${encodeURIComponent(fakeToken)}`;
	if (structuredUrls && structuredUrls.length > 0) source += '|' + structuredUrls.join('|');
	return source;
}

function buildSubConverterQuery(cfg, target, sourceUrl, options) {
	const withConfig = !options || options.withConfig !== false;
	const params = [
		'target=' + encodeURIComponent(target),
		'url=' + encodeURIComponent(sourceUrl),
		'insert=false',
		'emoji=true',
		'list=false',
		'tfo=false',
		'scv=true',
		'fdn=false',
		'sort=false',
		'new_name=true'
	];
	if (withConfig) params.push('config=' + encodeURIComponent(cfg.subConfig));
	if (target === 'surge') params.push('ver=4');
	if (target === 'quanx') params.push('udp=true');
	return params.join('&');
}

async function requestConvert(cfg, target, sourceUrl, userAgentHeader, withConfig) {
	const query = buildSubConverterQuery(cfg, target, sourceUrl, { withConfig });
	const endpoint = `${cfg.subProtocol}://${cfg.subConverter}/sub?${query}`;
	const resp = await fetchWithTimeout(endpoint, { headers: { 'User-Agent': userAgentHeader || 'v2rayN' } }, SUB_CONVERT_TIMEOUT);
	if (!resp.ok) throw new Error('subconverter http ' + resp.status);
	const text = await resp.text();
	if (!text || !text.trim()) throw new Error('subconverter 返回空内容');
	return text;
}

// ================= 转换结果校验 =================

// 取出 proxies 段的行(不包含 proxies: 这一行)
function getProxiesSection(yaml) {
	const lines = String(yaml == null ? '' : yaml).split('\n');
	const start = lines.findIndex(line => /^proxies\s*:/.test(line));
	if (start < 0) return { start: -1, end: -1, lines: [] };
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].trim() === '') continue;
		if (/^\S/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return { start, end, lines: lines.slice(start + 1, end) };
}

function hasClashProxies(yaml) {
	const section = getProxiesSection(yaml);
	return section.lines.some(line => /^\s*-\s+\S/.test(line));
}

function hasSingboxOutbounds(text) {
	try {
		const json = JSON.parse(text);
		if (!json || !Array.isArray(json.outbounds)) return false;
		const ignored = new Set(['direct', 'block', 'selector', 'urltest', 'dns']);
		return json.outbounds.some(item => item && item.type && !ignored.has(item.type));
	} catch (e) {
		return false;
	}
}

// ================= 转换失败降级 =================
// 原则:不返回"看似正常但没有任何代理节点"的空配置。
// 1) 能用本地解析重建节点 → 返回带节点的最小配置
// 2) 无法重建(无可用节点 / 非结构化格式) → 返回 502 并明确说明原因
function buildFailureResponse(cfg, format, plainNodes, errMsg) {
	const parsed = parsePlainNodesToProxies(plainNodes);
	if (format === 'clash' && parsed.nodes.length > 0) {
		const yaml = buildClashFallbackYaml(parsed, errMsg);
		if (yaml) return new Response(yaml, { headers: buildDownloadHeaders(cfg, 'yaml') });
	}
	if (format === 'singbox' && parsed.nodes.length > 0) {
		const json = buildSingboxFallbackJson(parsed, errMsg);
		if (json) return new Response(json, { headers: buildDownloadHeaders(cfg, 'json') });
	}
	const detail = [
		'订阅转换失败: ' + (errMsg || '未知错误'),
		'本地可用明文节点数量: ' + parsed.nodes.length,
		'无法在转换后端不可用的情况下生成 ' + format + ' 配置。',
		'请检查 SUBAPI / SUBCONFIG 是否可访问,或改用 base64 订阅(?b64=1)。'
	].join('\n');
	return new Response(detail, {
		status: 502,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store'
		}
	});
}

function buildClashFallbackYaml(parsed, errMsg) {
	const proxies = [];
	const names = [];
	for (const node of parsed.nodes) {
		const proxy = toClashProxy(node);
		if (!proxy) continue;
		proxies.push(proxy);
		names.push(proxy.name);
	}
	if (proxies.length === 0) return '';
	const head = [
		'# 订阅转换后端不可用,已使用本地降级配置(仅保证节点可用,不含分流规则)',
		'# 失败原因: ' + errMsg,
		'# 本地重建节点数: ' + proxies.length + ',未能解析的行数: ' + parsed.skipped.length
	].join('\n');
	const body = yamlLines({
		'mixed-port': 7890,
		'external-controller': '127.0.0.1:9090',
		'allow-lan': false,
		mode: 'rule',
		'log-level': 'info',
		ipv6: true,
		proxies,
		'proxy-groups': [
			{ name: 'PROXY', type: 'select', proxies: [...names, 'DIRECT'] }
		],
		rules: ['MATCH,PROXY']
	}, 0).join('\n');
	return head + '\n' + body + '\n';
}

function buildSingboxFallbackJson(parsed, errMsg) {
	const outbounds = [];
	const tags = [];
	for (const node of parsed.nodes) {
		const outbound = toSingboxOutbound(node);
		if (!outbound) continue;
		outbounds.push(outbound);
		tags.push(outbound.tag);
	}
	if (outbounds.length === 0) return '';
	outbounds.push({ type: 'selector', tag: 'PROXY', outbounds: [...tags, 'direct'], default: tags[0] });
	outbounds.push({ type: 'direct', tag: 'direct' });
	const config = {
		_comment: '订阅转换后端不可用,已使用本地降级配置: ' + errMsg + ' / 本地重建节点数: ' + tags.length,
		log: { level: 'info' },
		dns: { servers: [{ tag: 'local', address: '223.5.5.5' }] },
		inbounds: [],
		outbounds,
		route: { rules: [], final: 'PROXY' }
	};
	return JSON.stringify(config, null, 2);
}

// ================= 节点解析(用于降级时本地重建) =================

function safeDecodeURIComponent(text) {
	try {
		return decodeURIComponent(String(text == null ? '' : text));
	} catch (e) {
		return String(text == null ? '' : text);
	}
}

// 拆分 host:port,兼容 IPv6 与无端口
function splitHostPort(value) {
	const text = String(value == null ? '' : value).trim();
	let host = text;
	let port = '';
	if (text.startsWith('[')) {
		const close = text.indexOf(']');
		if (close > 0) {
			host = text.slice(1, close);
			const rest = text.slice(close + 1).replace(/^:/, '');
			port = rest.split('/')[0];
		}
	} else {
		const idx = text.lastIndexOf(':');
		if (idx > 0) {
			host = text.slice(0, idx);
			port = text.slice(idx + 1).split('/')[0];
		}
	}
	host = host.replace(/^\[/, '').replace(/\]$/, '');
	const parsedPort = parseInt(port, 10);
	return { host, port: String(Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 443) };
}

function splitList(value) {
	if (!value) return [];
	return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function isTrueFlag(value) {
	const text = String(value == null ? '' : value).trim().toLowerCase();
	return text === '1' || text === 'true' || text === 'yes';
}

// 把一行节点链接解析成统一结构,不支持的类型返回 null
function parseNodeLink(raw) {
	const line = String(raw == null ? '' : raw).trim();
	if (!line) return null;
	const scheme = (line.split('://')[0] || '').toLowerCase();
	if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
	if (scheme === 'vmess') return parseVmessLink(line);
	if (scheme === 'ss') return parseSSLink(line);
	if (!['vless', 'trojan', 'hysteria2', 'hy2', 'anytls', 'tuic'].includes(scheme)) return null;

	let u;
	try {
		u = new URL(line);
	} catch (e) {
		return null;
	}
	const p = u.searchParams;
	const hostInfo = splitHostPort(u.host);
	if (!hostInfo.host) return null;
	const name = safeDecodeURIComponent(u.hash.replace(/^#/, '')) || hostInfo.host;
	const security = (p.get('security') || '').toLowerCase();
	const base = {
		name,
		server: hostInfo.host,
		port: hostInfo.port,
		uuid: safeDecodeURIComponent(u.username || ''),
		password: safeDecodeURIComponent(u.password || u.username || ''),
		tls: security === 'tls' || security === 'reality' || security === 'xtls' || isTrueFlag(p.get('tls')),
		sni: p.get('sni') || p.get('peer') || p.get('host') || '',
		alpn: splitList(p.get('alpn')),
		fp: p.get('fp') || '',
		insecure: isTrueFlag(p.get('allowInsecure')) || isTrueFlag(p.get('insecure')) || isTrueFlag(p.get('skip-cert-verify')),
		pbk: p.get('pbk') || '',
		sid: p.get('sid') || '',
		network: (p.get('type') || p.get('network') || 'tcp').toLowerCase(),
		path: p.get('path') || '/',
		host: p.get('host') || '',
		mode: p.get('mode') || 'auto',
		serviceName: p.get('serviceName') || p.get('service_name') || '',
		flow: p.get('flow') || '',
		packetEncoding: p.get('packet-encoding') || '',
		alterId: 0,
		cipher: '',
		method: '',
		obfs: '',
		obfsPassword: ''
	};

	if (scheme === 'vless') {
		base.type = 'vless';
		base.uuid = safeDecodeURIComponent(u.username || '');
		return base;
	}
	if (scheme === 'trojan') {
		base.type = 'trojan';
		base.password = safeDecodeURIComponent(u.username || '');
		base.tls = true;
		base.uuid = '';
		return base;
	}
	if (scheme === 'hysteria2' || scheme === 'hy2') {
		base.type = 'hysteria2';
		base.password = safeDecodeURIComponent(u.username || '') + (u.password ? ':' + safeDecodeURIComponent(u.password) : '');
		base.tls = true;
		base.obfs = p.get('obfs') || '';
		base.obfsPassword = p.get('obfs-password') || p.get('obfs_password') || '';
		base.uuid = '';
		return base;
	}
	if (scheme === 'anytls') {
		base.type = 'anytls';
		base.password = safeDecodeURIComponent(u.username || '');
		base.tls = true;
		base.uuid = '';
		return base;
	}
	if (scheme === 'tuic') {
		base.type = 'tuic';
		base.uuid = safeDecodeURIComponent(u.username || '');
		base.password = safeDecodeURIComponent(u.password || '');
		base.tls = true;
		return base;
	}
	return null;
}

function parseVmessLink(line) {
	let body = line.slice('vmess://'.length).trim();
	if (!body) return null;
	let jsonText = '';
	if (body.startsWith('{')) {
		jsonText = body;
	} else {
		const decoded = tryBase64Decode(body);
		if (decoded && decoded.trim().startsWith('{')) jsonText = decoded.trim();
	}
	if (!jsonText) return null;
	let obj;
	try {
		obj = JSON.parse(jsonText);
	} catch (e) {
		return null;
	}
	const server = String(obj.add || '').trim();
	if (!server) return null;
	const port = parseInt(obj.port, 10);
	const network = String(obj.net || 'tcp').toLowerCase();
	return {
		type: 'vmess',
		name: String(obj.ps || '') || server,
		server,
		port: String(Number.isFinite(port) && port > 0 ? port : 443),
		uuid: String(obj.id || ''),
		password: '',
		alterId: parseInt(obj.aid, 10) || 0,
		cipher: String(obj.scy || 'auto'),
		method: '',
		tls: String(obj.tls || '').toLowerCase() === 'tls',
		sni: String(obj.sni || obj.host || ''),
		alpn: splitList(obj.alpn),
		fp: String(obj.fp || ''),
		insecure: isTrueFlag(obj.allowInsecure) || obj.verify_cert === false || String(obj.verify_cert).toLowerCase() === 'false',
		pbk: '',
		sid: '',
		network,
		path: String(obj.path || '/'),
		host: String(obj.host || ''),
		mode: String(obj.type || 'auto'),
		serviceName: String(obj.path || ''),
		flow: '',
		packetEncoding: '',
		obfs: '',
		obfsPassword: ''
	};
}

function parseSSLink(line) {
	let body = line.slice('ss://'.length);
	let name = '';
	const hashIdx = body.indexOf('#');
	if (hashIdx >= 0) {
		name = safeDecodeURIComponent(body.slice(hashIdx + 1));
		body = body.slice(0, hashIdx);
	}
	let query = '';
	const qIdx = body.indexOf('?');
	if (qIdx >= 0) {
		query = body.slice(qIdx + 1);
		body = body.slice(0, qIdx);
	}
	let method = '';
	let password = '';
	let hostInfo = { host: '', port: '443' };

	if (body.includes('@')) {
		const at = body.lastIndexOf('@');
		let userinfo = body.slice(0, at);
		if (!userinfo.includes(':')) {
			const decoded = tryBase64Decode(userinfo);
			if (decoded) userinfo = decoded;
		}
		const colon = userinfo.indexOf(':');
		if (colon < 0) return null;
		method = safeDecodeURIComponent(userinfo.slice(0, colon));
		password = safeDecodeURIComponent(userinfo.slice(colon + 1));
		hostInfo = splitHostPort(body.slice(at + 1));
	} else {
		const decoded = tryBase64Decode(body);
		if (!decoded) return null;
		const at = decoded.lastIndexOf('@');
		if (at < 0) return null;
		const userinfo = decoded.slice(0, at);
		const colon = userinfo.indexOf(':');
		if (colon < 0) return null;
		method = userinfo.slice(0, colon);
		password = userinfo.slice(colon + 1);
		hostInfo = splitHostPort(decoded.slice(at + 1));
	}
	if (!hostInfo.host || !method) return null;

	const node = {
		type: 'ss',
		name: name || hostInfo.host,
		server: hostInfo.host,
		port: hostInfo.port,
		uuid: '',
		password,
		alterId: 0,
		cipher: '',
		method,
		tls: false,
		sni: '',
		alpn: [],
		fp: '',
		insecure: false,
		pbk: '',
		sid: '',
		network: 'tcp',
		path: '/',
		host: '',
		mode: '',
		serviceName: '',
		flow: '',
		packetEncoding: '',
		obfs: '',
		obfsPassword: '',
		plugin: '',
		pluginOptions: null
	};

	// 简单支持 obfs / v2ray-plugin
	const params = new URLSearchParams(query);
	const pluginRaw = params.get('plugin') || '';
	if (pluginRaw) {
		const parts = pluginRaw.split(';');
		const pluginName = (parts[0] || '').toLowerCase();
		const opts = {};
		for (let i = 1; i < parts.length; i++) {
			const item = parts[i] || '';
			const eq = item.indexOf('=');
			if (eq < 0) {
				if (item) opts[item] = true;
			} else {
				opts[item.slice(0, eq)] = item.slice(eq + 1);
			}
		}
		if (pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
			node.plugin = 'obfs';
			node.pluginOptions = { mode: opts.obfs || 'http' };
			if (opts['obfs-host']) node.pluginOptions.host = opts['obfs-host'];
		} else if (pluginName === 'v2ray-plugin') {
			node.plugin = 'v2ray-plugin';
			node.pluginOptions = {
				mode: 'websocket',
				host: opts.host || '',
				path: opts.path || '/',
				tls: opts.tls === true || opts.tls === 'true'
			};
		}
	}
	return node;
}

function parsePlainNodesToProxies(plainNodes) {
	const nodes = [];
	const skipped = [];
	const seen = new Set();
	for (const raw of String(plainNodes == null ? '' : plainNodes).split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
			skipped.push(line);
			continue;
		}
		const node = parseNodeLink(line);
		if (!node) {
			skipped.push(line);
			continue;
		}
		const key = [node.type, node.server, node.port, node.uuid || node.password, node.name].join('|');
		if (seen.has(key)) continue;
		seen.add(key);
		nodes.push(node);
	}
	return { nodes, skipped };
}

// ================= Clash 节点渲染(降级用) =================

function toClashProxy(node) {
	const p = {
		name: node.name || (node.server + ':' + node.port),
		type: node.type,
		server: node.server,
		port: Number(node.port) || 443
	};

	if (node.type === 'vless' || node.type === 'vmess') p.uuid = node.uuid;
	if (node.type === 'vless' && node.flow) p.flow = node.flow;
	if (node.type === 'vmess') {
		p.alterId = node.alterId || 0;
		p.cipher = node.cipher || 'auto';
	}
	if (node.type === 'trojan' || node.type === 'hysteria2' || node.type === 'anytls' || node.type === 'ss' || node.type === 'tuic') {
		p.password = node.password;
	}
	if (node.type === 'ss') {
		p.cipher = node.method;
		if (node.plugin) {
			p.plugin = node.plugin;
			if (node.pluginOptions) p['plugin-opts'] = node.pluginOptions;
		}
	}
	if (node.type === 'hysteria2') {
		if (node.obfs) {
			p.obfs = node.obfs;
			p['obfs-password'] = node.obfsPassword || '';
		}
	}
	if (node.type === 'tuic') p.uuid = node.uuid;

	if (node.tls) {
		p.tls = true;
		const isSniType = node.type === 'trojan' || node.type === 'hysteria2' || node.type === 'anytls' || node.type === 'tuic';
		if (node.sni) {
			if (isSniType) p.sni = node.sni;
			else p.servername = node.sni;
		}
		if (node.alpn && node.alpn.length) p.alpn = node.alpn.slice();
		if (node.fp && node.type !== 'hysteria2') p['client-fingerprint'] = node.fp;
		if (node.insecure) p['skip-cert-verify'] = true;
		if (node.pbk) {
			p['reality-opts'] = { 'public-key': node.pbk, 'support-x25519mlkem768': true };
			if (node.sid) p['reality-opts']['short-id'] = node.sid;
		}
	}

	if (node.type === 'vless' || node.type === 'vmess' || node.type === 'trojan') {
		p.udp = true;
		if (node.network === 'ws') {
			p.network = 'ws';
			p['ws-opts'] = { path: node.path || '/', headers: node.host ? { Host: node.host } : undefined };
		} else if (node.network === 'grpc') {
			p.network = 'grpc';
			p['grpc-opts'] = { 'grpc-service-name': node.serviceName || node.path || '' };
		} else if (node.network === 'h2' || node.network === 'http') {
			p.network = 'h2';
			p['h2-opts'] = { path: node.path || '/', host: node.host ? [node.host] : undefined };
		} else if (node.network === 'xhttp') {
			p.network = 'xhttp';
			p['xhttp-opts'] = { path: node.path || '/', host: node.host || node.server, mode: node.mode || 'auto' };
		}
	}
	return p;
}

// ================= Sing-box 节点渲染(降级用) =================

function toSingboxTLS(node) {
	if (!node.tls) return null;
	const tls = { enabled: true };
	if (node.sni) tls.server_name = node.sni;
	if (node.insecure) tls.insecure = true;
	if (node.alpn && node.alpn.length) tls.alpn = node.alpn.slice();
	if (node.fp) tls.utls = { enabled: true, fingerprint: node.fp };
	if (node.pbk) {
		tls.reality = { enabled: true, public_key: node.pbk };
		if (node.sid) tls.reality.short_id = node.sid;
	}
	return tls;
}

function toSingboxTransport(node) {
	if (!node.network || node.network === 'tcp') return null;
	if (node.network === 'ws') {
		const transport = { type: 'ws', path: node.path || '/' };
		if (node.host) transport.headers = { Host: node.host };
		return transport;
	}
	if (node.network === 'grpc') return { type: 'grpc', service_name: node.serviceName || node.path || '' };
	if (node.network === 'h2' || node.network === 'http' || node.network === 'xhttp') {
		// sing-box 没有 xhttp,降级时按 http 传输近似处理
		const transport = { type: 'http', path: node.path || '/' };
		if (node.host) transport.host = [node.host];
		return transport;
	}
	if (node.network === 'httpupgrade') return { type: 'httpupgrade', path: node.path || '/', host: node.host || '' };
	return null;
}

function toSingboxOutbound(node) {
	const tag = node.name || (node.server + ':' + node.port);
	const outbound = { type: '', tag, server: node.server, server_port: Number(node.port) || 443 };
	if (node.type === 'vless') {
		outbound.type = 'vless';
		outbound.uuid = node.uuid;
		if (node.flow) outbound.flow = node.flow;
	} else if (node.type === 'vmess') {
		outbound.type = 'vmess';
		outbound.uuid = node.uuid;
		outbound.security = node.cipher || 'auto';
		outbound.alter_id = node.alterId || 0;
	} else if (node.type === 'trojan') {
		outbound.type = 'trojan';
		outbound.password = node.password;
	} else if (node.type === 'hysteria2') {
		outbound.type = 'hysteria2';
		outbound.password = node.password;
		if (node.obfs) outbound.obfs = { type: node.obfs, password: node.obfsPassword || '' };
	} else if (node.type === 'anytls') {
		outbound.type = 'anytls';
		outbound.password = node.password;
	} else if (node.type === 'ss') {
		outbound.type = 'shadowsocks';
		outbound.method = node.method;
		outbound.password = node.password;
	} else if (node.type === 'tuic') {
		outbound.type = 'tuic';
		outbound.uuid = node.uuid;
		outbound.password = node.password;
	} else {
		return null;
	}
	const tls = toSingboxTLS(node);
	if (tls) outbound.tls = tls;
	const transport = toSingboxTransport(node);
	if (transport) outbound.transport = transport;
	return outbound;
}

// ================= YAML 序列化辅助 =================

// 输出 YAML 标量:普通值原样输出,含特殊字符时加双引号,不做 URL 编码
function yamlPlainScalar(value) {
	const text = String(value == null ? '' : value);
	if (text === '') return '""';
	if (/^[A-Za-z0-9_./:@+-]+$/.test(text) && !/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return text;
	return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 读取 YAML 标量并去掉数组/引号,只取第一个值
function yamlScalarString(value) {
	let text = String(value == null ? '' : value).trim();
	if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
	text = (text.split(',')[0] || '').trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1);
	}
	return text.trim();
}

// 序列化标量(降级配置用)
function yamlScalar(value) {
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return String(value);
	const text = String(value == null ? '' : value);
	if (text === '') return '""';
	if (/^[A-Za-z0-9_./:@+=-]+$/.test(text) && !/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return text;
	return JSON.stringify(text);
}

// 把对象/数组序列化成 YAML 行
function yamlLines(value, indent) {
	const pad = ' '.repeat(indent);
	const lines = [];

	if (Array.isArray(value)) {
		for (const item of value) {
			if (item && typeof item === 'object' && !Array.isArray(item)) {
				const sub = yamlLines(item, indent + 2);
				if (sub.length === 0) {
					lines.push(pad + '- {}');
				} else {
					sub[0] = pad + '- ' + sub[0].slice(indent + 2);
					lines.push(...sub);
				}
			} else if (Array.isArray(item)) {
				lines.push(pad + '- ' + JSON.stringify(item));
			} else {
				lines.push(pad + '- ' + yamlScalar(item));
			}
		}
		return lines;
	}

	for (const key of Object.keys(value || {})) {
		const val = value[key];
		if (val === undefined || val === null) continue;
		if (Array.isArray(val)) {
			if (val.length === 0) {
				lines.push(pad + key + ': []');
			} else {
				lines.push(pad + key + ':');
				lines.push(...yamlLines(val, indent + 2));
			}
		} else if (typeof val === 'object') {
			const sub = yamlLines(val, indent + 2);
			if (sub.length === 0) {
				lines.push(pad + key + ': {}');
			} else {
				lines.push(pad + key + ':');
				lines.push(...sub);
			}
		} else {
			lines.push(pad + key + ': ' + yamlScalar(val));
		}
	}
	return lines;
}

// ================= 现有修复逻辑(AnyTLS / REALITY) =================

// subconverter 生成 anytls 节点时把 uTLS 指纹写进了 fingerprint 字段,
// mihomo 会把 fingerprint 当作服务器证书 SHA256 指纹校验,导致握手失败。
// 此处仅对 anytls 节点将其改回 client-fingerprint,其他内容保持原样。
function fixAnyTLSFingerprint(yaml) {
	if (!yaml || !yaml.includes('anytls')) return yaml;
	const lines = yaml.split('\n');
	let isAnyTLS = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// 块状节点以 "- " 开头,遇到新节点时重置标记
		if (/^\s*-\s/.test(line) && !/^\s*-\s*\{/.test(line)) isAnyTLS = false;
		// 块状写法:type 单独一行
		if (/^\s*type:\s*["']?anytls["']?\s*$/.test(line)) isAnyTLS = true;
		if (isAnyTLS && /^\s+fingerprint\s*:\s*\S/.test(line)) {
			lines[i] = line.replace(/^(\s+)fingerprint\s*:/, '$1client-fingerprint:');
			continue;
		}
		// 流式写法:{name: xx, type: anytls, ... fingerprint: chrome ...}
		if (/type:\s*["']?anytls/i.test(line)
			&& !/(^|[\s,{])client-fingerprint\s*:/.test(line)
			&& /(^|[\s,{])fingerprint\s*:/.test(line)) {
			lines[i] = line.replace(/(^|[\s,{])fingerprint\s*:/, '$1client-fingerprint:');
		}
	}
	return lines.join('\n');
}

// Xray 26.9.9+ 的 REALITY 服务端要求客户端使用 X25519MLKEM768 密钥交换,
// mihomo 默认关闭该选项,导致握手认证失败。此处给 vless reality 节点补上开关。
function fixRealityMLKEM(yaml) {
	if (!yaml || !yaml.includes('reality-opts')) return yaml;
	const lines = yaml.split('\n');
	let isVless = false;
	// 给内联写法的 reality-opts 追加字段
	const addToInline = (line) => {
		if (/reality-opts:\s*\{\s*\}/.test(line)) {
			return line.replace(/reality-opts:\s*\{\s*\}/, 'reality-opts: {support-x25519mlkem768: true}');
		}
		return line.replace(/(reality-opts:\s*\{)\s*/, '$1 support-x25519mlkem768: true, ');
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// 流式写法:type 与 reality-opts 在同一个节点行
		if (/type:\s*["']?vless/i.test(line) && line.includes('reality-opts:') && !line.includes('support-x25519mlkem768')) {
			lines[i] = addToInline(line);
			continue;
		}
		// 块状节点以 "- " 开头,遇到新节点时重置标记
		if (/^\s*-\s/.test(line) && !/^\s*-\s*\{/.test(line)) isVless = false;
		if (/^\s*type:\s*["']?vless["']?\s*$/.test(line)) {
			isVless = true;
			continue;
		}
		if (!isVless) continue;
		// 块状写法:reality-opts 单独一行,把开关插到子字段末尾
		const blockMatch = line.match(/^(\s*)reality-opts:\s*$/);
		if (blockMatch) {
			const parentIndent = blockMatch[1].length;
			let childIndent = parentIndent + 2;
			let lastChild = i;
			let hasFlag = false;
			for (let j = i + 1; j < lines.length; j++) {
				const childMatch = lines[j].match(/^(\s+)(\S.*)$/);
				if (!childMatch || childMatch[1].length <= parentIndent) break;
				childIndent = childMatch[1].length;
				if (/^support-x25519mlkem768\s*:/.test(childMatch[2])) hasFlag = true;
				lastChild = j;
			}
			if (!hasFlag && lastChild > i) {
				lines.splice(lastChild + 1, 0, ' '.repeat(childIndent) + 'support-x25519mlkem768: true');
				i = lastChild + 1;
			}
			continue;
		}
		// 块状写法:reality-opts 内联在字段行
		if (line.includes('reality-opts:') && !line.includes('support-x25519mlkem768')) {
			lines[i] = addToInline(line);
		}
	}
	return lines.join('\n');
}

// ================= XHTTP 兜底修正 =================
// 根因:subconverter v0.9.9 的 subparser.cpp 能解析 vless + type=xhttp,
// 但 subexport.cpp 的 VLESS clash 导出 switch 没有 case "xhttp"_hash,
// 导致节点被 default: continue 跳过,或在某些链路里被降级成 h2/tcp。
// 本函数同时处理三种情况:
//   1. 后端正常输出 xhttp → 保持原样
//   2. 后端降级成 h2/tcp → 改回 network: xhttp + xhttp-opts
//   3. 后端完全丢失节点 → 从原始 vless 链接重建完整节点块注入 proxies 区
function collectXHTTPNodes(plainNodes) {
	const result = [];
	if (!plainNodes) return result;
	const seen = new Set();
	for (const raw of plainNodes.split('\n')) {
		const line = raw.trim();
		if (!/^vless:\/\//i.test(line)) continue;
		try {
			const u = new URL(line);
			const p = u.searchParams;
			if ((p.get('type') || '').toLowerCase() !== 'xhttp') continue;
			// alpn 可能是逗号分隔
			let alpnRaw = p.get('alpn') || '';
			let alpnList = [];
			if (alpnRaw) alpnList = alpnRaw.split(',').map(s => s.trim()).filter(Boolean);
			// reality 字段
			const security = (p.get('security') || '').toLowerCase();
			const isReality = security === 'reality';
			// skip-cert-verify:1 / 0
			let scv = p.get('allowInsecure') || p.get('scv') || '';
			if (!scv && security === 'tls') scv = '1';
			const node = {
				name: safeDecodeURIComponent(u.hash.replace(/^#/, '')) || u.hostname,
				server: u.hostname.replace(/^\[/, '').replace(/\]$/, ''),
				port: String(u.port || '443'),
				uuid: safeDecodeURIComponent(u.username || ''),
				tls: security === 'tls' || isReality,
				servername: p.get('sni') || p.get('host') || (isReality ? '' : ''),
				alpnList,
				fp: p.get('fp') || '',
				encryption: p.get('encryption') || 'none',
				packetEncoding: p.get('packet-encoding') || '',
				scv: scv === '1' || scv.toLowerCase() === 'true',
				// xhttp 核心字段
				path: p.get('path') || '/',
				host: p.get('host') || p.get('sni') || u.hostname,
				mode: p.get('mode') || 'auto',
				// reality
				isReality,
				pbk: p.get('pbk') || '',
				sid: p.get('sid') || '',
				flow: p.get('flow') || ''
			};
			// 节点去重:同名同端点同路径只保留一个
			const key = [node.server, node.port, node.uuid, node.path, node.name].join('|');
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(node);
		} catch (e) { /* 忽略解析失败 */ }
	}
	return result;
}

// 从原始 vless 链接提取的 info 构造完整 Clash YAML 块状节点
function buildXHTTPNodeBlock(info, dashIndent) {
	const f = ' '.repeat(dashIndent + 2); // 字段缩进
	const child = f + '  ';               // 子字段缩进(xhttp-opts/alpn)
	const lines = [];
	lines.push('- ' + 'name: ' + yamlPlainScalar(info.name));
	lines.push(f + 'type: vless');
	lines.push(f + 'server: ' + yamlPlainScalar(info.server));
	lines.push(f + 'port: ' + info.port);
	lines.push(f + 'uuid: ' + yamlPlainScalar(info.uuid));
	if (info.encryption && info.encryption !== 'none') {
		lines.push(f + 'encryption: ' + yamlPlainScalar(info.encryption));
	}
	if (info.tls) lines.push(f + 'tls: true');
	if (info.servername) lines.push(f + 'servername: ' + yamlPlainScalar(info.servername));
	if (info.alpnList.length > 0) {
		lines.push(f + 'alpn:');
		for (const a of info.alpnList) lines.push(child + '- ' + yamlPlainScalar(a));
	}
	if (info.fp) lines.push(f + 'client-fingerprint: ' + yamlPlainScalar(info.fp));
	if (info.flow) lines.push(f + 'flow: ' + yamlPlainScalar(info.flow));
	if (info.packetEncoding) lines.push(f + 'packet-encoding: ' + yamlPlainScalar(info.packetEncoding));
	if (info.scv) lines.push(f + 'skip-cert-verify: true');
	// reality
	if (info.isReality || info.pbk || info.sid) {
		lines.push(f + 'reality-opts:');
		if (info.pbk) lines.push(child + 'public-key: ' + yamlPlainScalar(info.pbk));
		if (info.sid) lines.push(child + 'short-id: ' + yamlPlainScalar(info.sid));
		// mihomo 新内核需要 X25519MLKEM 开关
		lines.push(child + 'support-x25519mlkem768: true');
	}
	// xhttp 核心
	lines.push(f + 'network: xhttp');
	lines.push(f + 'xhttp-opts:');
	lines.push(child + 'path: ' + yamlPlainScalar(info.path));
	lines.push(child + 'host: ' + yamlPlainScalar(info.host));
	lines.push(child + 'mode: ' + yamlPlainScalar(info.mode));
	// 仅首行需要补 "- " 所在的缩进,其余字段行已带绝对缩进
	// (旧实现给每一行都补了一次缩进,导致重建节点整体多缩进 2 格,YAML 结构错误)
	const pad = ' '.repeat(dashIndent);
	return lines.map((line, index) => (index === 0 ? pad + line : line));
}

// 匹配原始 info 和后端输出节点(返回匹配到的 info,用于标记已处理)
function matchXHTTPInfo(info, server, port, uuid, name) {
	const portA = String(port || '443');
	const portB = String(info.port || '443');
	const sameEndpoint = String(server) === String(info.server) && portA === portB;
	if (!sameEndpoint) return null;
	if (uuid && info.uuid && uuid === info.uuid) return info;
	if (name && info.name && name === info.name) return info;
	if (!uuid && !info.uuid && !name) return info;
	return null;
}

// 同一端点同一 UUID 的重复 info 一并标记,避免重建出重复节点
function markXHTTPMatched(info, infos, matchedSet) {
	matchedSet.add(info);
	for (const other of infos) {
		if (other === info) continue;
		if (other.server === info.server && other.port === info.port && other.uuid === info.uuid && other.path === info.path) {
			matchedSet.add(other);
		}
	}
}

// 块状写法:修复单个 "- name: xxx" 节点
function fixXHTTPBlock(block, infos, matchedSet) {
	const first = block[0];
	const head = first.replace(/^\s*-\s+/, '');
	const headMatch = head.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
	if (!headMatch || headMatch[1] !== 'name') return block;
	const fieldIndent = first.match(/^\s*/)[0].length + 2;
	const getField = (key) => {
		for (const l of block) {
			const m = l.match(new RegExp('^\\s*' + key + '\\s*:\\s*(.*)$'));
			if (m) return m[1];
		}
		return '';
	};
	if (yamlScalarString(getField('type')).toLowerCase() !== 'vless') return block;
	const server = yamlScalarString(getField('server'));
	const port = yamlScalarString(getField('port')) || '443';
	const uuid = yamlScalarString(getField('uuid'));
	const name = yamlScalarString(headMatch[2]);
	const info = infos.find(x => matchXHTTPInfo(x, server, port, uuid, name));
	if (!info) return block;
	markXHTTPMatched(info, infos, matchedSet);

	const result = block.slice();
	const netIdx = result.findIndex(l => /^\s*network\s*:/.test(l));
	if (netIdx >= 0) {
		result[netIdx] = result[netIdx].replace(/^(\s*)network\s*:.*$/, '$1network: xhttp');
	} else {
		const typeIdx = result.findIndex(l => /^\s*type\s*:\s*vless\s*$/.test(l));
		result.splice(typeIdx >= 0 ? typeIdx + 1 : 1, 0, ' '.repeat(fieldIndent) + 'network: xhttp');
	}
	const optsIdx = result.findIndex(l => /^\s*(h2-opts|http-opts|xhttp-opts)\s*:/.test(l));
	const opts = [
		'path: ' + yamlPlainScalar(info.path),
		'host: ' + yamlPlainScalar(info.host || info.server),
		'mode: ' + yamlPlainScalar(info.mode)
	];
	if (optsIdx >= 0) {
		const optsIndent = result[optsIdx].match(/^\s*/)[0].length;
		if (result[optsIdx].includes('{')) {
			result[optsIdx] = ' '.repeat(optsIndent) + 'xhttp-opts: {' + opts.join(', ') + '}';
		} else {
			let childIndent = optsIndent + 2;
			for (let k = optsIdx + 1; k < result.length; k++) {
				if (result[k].trim() === '') break;
				const indent = result[k].match(/^\s*/)[0].length;
				if (indent <= optsIndent) break;
				childIndent = indent;
				break;
			}
			let end = optsIdx + 1;
			while (end < result.length) {
				if (result[end].trim() === '') break;
				const indent = result[end].match(/^\s*/)[0].length;
				if (indent <= optsIndent) break;
				end++;
			}
			result.splice(optsIdx, end - optsIdx, ' '.repeat(optsIndent) + 'xhttp-opts:');
			for (let k = 0; k < opts.length; k++) {
				result.splice(optsIdx + 1 + k, 0, ' '.repeat(childIndent) + opts[k]);
			}
		}
	} else {
		const childIndent = fieldIndent + 2;
		const insertLines = [
			' '.repeat(fieldIndent) + 'xhttp-opts:',
			' '.repeat(childIndent) + opts[0],
			' '.repeat(childIndent) + opts[1],
			' '.repeat(childIndent) + opts[2]
		];
		const netAt = result.findIndex(l => /^\s*network\s*:\s*xhttp\s*$/.test(l));
		if (netAt >= 0) result.splice(netAt + 1, 0, ...insertLines);
	}
	return result;
}

// 解析 YAML 流式映射(支持引号与嵌套花括号,避免被值里的逗号截断)
function splitFlowFields(body) {
	const inner = String(body == null ? '' : body).trim().replace(/^\{/, '').replace(/\}$/, '');
	const parts = [];
	let depth = 0;
	let quote = '';
	let buf = '';
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (quote) {
			buf += ch;
			if (ch === quote && inner[i - 1] !== '\\') quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === '{' || ch === '[') depth++;
		if (ch === '}' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(buf);
			buf = '';
			continue;
		}
		buf += ch;
	}
	if (buf.trim()) parts.push(buf);
	const map = {};
	for (const part of parts) {
		const idx = part.indexOf(':');
		if (idx < 0) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key) map[key] = value;
	}
	return map;
}

// 在流式映射里定位某个字段值的起止位置(兼容引号与嵌套结构)
function findFlowValueSpan(body, keyPattern) {
	const re = new RegExp('(^|[,{]\\s*)(' + keyPattern + ')\\s*:\\s*', 'i');
	const m = body.match(re);
	if (!m) return null;
	const keyStart = m.index + m[1].length;
	const valueStart = m.index + m[0].length;
	let depth = 0;
	let quote = '';
	let i = valueStart;
	for (; i < body.length; i++) {
		const ch = body[i];
		if (quote) {
			if (ch === quote && body[i - 1] !== '\\') quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '{' || ch === '[') {
			depth++;
			continue;
		}
		if (ch === '}' || ch === ']') {
			if (depth === 0) break;
			depth--;
			continue;
		}
		if (ch === ',' && depth === 0) break;
	}
	return { start: keyStart, end: i, key: m[2] };
}

// 流式写法:修复单个 "- {name: xxx, ...}" 节点
function fixXHTTPInline(line, infos, matchedSet) {
	const indent = line.match(/^\s*/)[0];
	const body = line.trim().replace(/^-\s*/, '');
	if (!body.startsWith('{')) return line;
	const map = splitFlowFields(body);
	if (yamlScalarString(map.type).toLowerCase() !== 'vless') return line;
	const server = yamlScalarString(map.server);
	const port = yamlScalarString(map.port) || '443';
	const uuid = yamlScalarString(map.uuid);
	const name = yamlScalarString(map.name);
	const info = infos.find(x => matchXHTTPInfo(x, server, port, uuid, name));
	if (!info) return line;
	markXHTTPMatched(info, infos, matchedSet);

	let fixed = body;
	const netSpan = findFlowValueSpan(fixed, 'network');
	if (netSpan) {
		fixed = fixed.slice(0, netSpan.start) + 'network: xhttp' + fixed.slice(netSpan.end);
	} else {
		const typeSpan = findFlowValueSpan(fixed, 'type');
		if (!typeSpan) return line;
		fixed = fixed.slice(0, typeSpan.end) + ', network: xhttp' + fixed.slice(typeSpan.end);
	}
	const optsValue = 'xhttp-opts: {' + [
		'path: ' + yamlPlainScalar(info.path),
		'host: ' + yamlPlainScalar(info.host || info.server),
		'mode: ' + yamlPlainScalar(info.mode)
	].join(', ') + '}';
	const optsSpan = findFlowValueSpan(fixed, '(?:h2-opts|http-opts|xhttp-opts)');
	if (optsSpan) {
		fixed = fixed.slice(0, optsSpan.start) + optsValue + fixed.slice(optsSpan.end);
	} else {
		const netSpan2 = findFlowValueSpan(fixed, 'network');
		if (!netSpan2) return line;
		fixed = fixed.slice(0, netSpan2.end) + ', ' + optsValue + fixed.slice(netSpan2.end);
	}
	return indent + '- ' + fixed;
}

// 仅在 proxies 区扫描节点,块状与流式都支持,丢失节点在 proxies 区末尾注入
function fixXHTTPDowngrade(yaml, plainNodes) {
	if (!yaml) return yaml;
	const infos = collectXHTTPNodes(plainNodes);
	if (infos.length === 0) return yaml;
	const matched = new Set();
	const lines = yaml.split('\n');
	const out = [];
	let inProxies = false;
	let proxiesFound = false;
	let proxyIndent = 2;
	let i = 0;

	const flushMissing = () => {
		for (const info of infos) {
			if (matched.has(info)) continue;
			out.push('');
			out.push(...buildXHTTPNodeBlock(info, proxyIndent));
		}
	};

	while (i < lines.length) {
		const line = lines[i];

		// 顶层 proxies 键(兼容 "proxies: []" 写法)
		if (!inProxies) {
			const startMatch = line.match(/^proxies\s*:\s*(\[\s*\])?\s*(?:#.*)?$/);
			if (startMatch) {
				proxiesFound = true;
				inProxies = true;
				// proxies: [] 无法直接追加列表项,改写成块状写法
				out.push(startMatch[1] ? 'proxies:' : line);
				i++;
				continue;
			}
			out.push(line);
			i++;
			continue;
		}

		// proxies 段内
		if (line.trim() === '') {
			out.push(line);
			i++;
			continue;
		}

		const indentOfLine = line.match(/^\s*/)[0].length;
		const flowItem = /^\s*-\s*\{.*\}\s*$/.test(line);
		const itemMatch = line.match(/^(\s*)-\s+(\S.*)$/);

		if (flowItem) {
			out.push(fixXHTTPInline(line, infos, matched));
			i++;
			continue;
		}

		if (itemMatch) {
			const dashIndent = itemMatch[1].length;
			proxyIndent = dashIndent;
			const block = [line];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const next = lines[j];
				if (next.trim() === '') break;
				const nextDash = next.match(/^(\s*)-\s/);
				if (nextDash && nextDash[1].length <= dashIndent) break;
				const nextIndent = next.match(/^\s*/)[0].length;
				if (nextIndent <= dashIndent) break;
				block.push(next);
			}
			out.push(...fixXHTTPBlock(block, infos, matched));
			i = j;
			continue;
		}

		// proxies 段遇到顶层键(缩进 0)→ 段结束,补齐丢失节点
		if (indentOfLine === 0) {
			inProxies = false;
			flushMissing();
			out.push(line);
			i++;
			continue;
		}

		out.push(line);
		i++;
	}

	if (inProxies) flushMissing();

	// 完全没有 proxies 段时补一个,避免节点整体丢失
	if (!proxiesFound && infos.length > 0) {
		out.push('');
		out.push('proxies:');
		for (const info of infos) out.push(...buildXHTTPNodeBlock(info, 2));
	}
	return out.join('\n');
}

// ================= Base64(UTF-8 安全) =================

// 统一走 TextEncoder → 二进制串 → btoa
function base64Encode(str) {
	const bytes = new TextEncoder().encode(String(str == null ? '' : str));
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

// 统一走 atob → Uint8Array → TextDecoder
function base64Decode(str) {
	const cleaned = String(str == null ? '' : str)
		.replace(/\s+/g, '')
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	if (!cleaned) return '';
	let padded = cleaned;
	const rem = padded.length % 4;
	if (rem === 1) throw new Error('base64 长度非法');
	if (rem) padded += '='.repeat(4 - rem);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder('utf-8').decode(bytes);
}

// 解码失败返回 null,不抛异常
function tryBase64Decode(str) {
	try {
		return base64Decode(str);
	} catch (e) {
		return null;
	}
}

// 判断是否为合法 base64(忽略空白字符,兼容 URL-safe 与缺省填充)
function isValidBase64(str) {
	if (!str) return false;
	const clean = String(str).replace(/\s/g, '');
	if (clean.length < 4) return false;
	return /^[A-Za-z0-9+/=_-]+$/.test(clean);
}

// ================= 编辑页 =================

async function editPage(request, cfg, url) {
	if (request.method === 'POST') {
		return handleEditPost(request, cfg, url);
	}

	const loaded = await loadMainList(cfg);
	const currentData = loaded.text;
	const kvError = loaded.error;
	const hasPassword = cfg.adminPassword ? true : false;
	const notice = kvError
		? '<div class="error-box">KV 读取失败:' + escapeHTML(kvError) + '</div>'
		: '';

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
button:disabled { opacity: 0.6; cursor: not-allowed; }
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
.error-box {
	background: #2d1417;
	border: 1px solid #f85149;
	border-radius: 8px;
	padding: 10px 14px;
	font-size: 13px;
	color: #ffa198;
	margin-bottom: 16px;
	word-break: break-all;
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
/* 分客户端订阅地址 */
.client-row {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 0;
	border-bottom: 1px dashed #21262d;
}
.client-row:last-child { border-bottom: none; }
.client-name {
	flex: 0 0 200px;
	font-size: 13px;
	color: #e6edf3;
}
.client-name .hint {
	display: block;
	font-size: 11px;
	color: #8b949e;
	font-weight: 400;
}
.client-url {
	flex: 1 1 auto;
	min-width: 0;
	background: #0d1117;
	padding: 6px 10px;
	border-radius: 6px;
	font-family: monospace;
	font-size: 12px;
	color: #c9d1d9;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	border: 1px solid #30363d;
}
.client-copy {
	flex: 0 0 auto;
	padding: 6px 14px;
	font-size: 12px;
}
@media (max-width: 640px) {
	.client-row { flex-wrap: wrap; }
	.client-name { flex: 1 1 100%; }
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
		${notice}
		<div class="info">
			订阅地址(填入客户端):
			<div class="link-box" id="subUrl" onclick="copySub()" title="点击复制" style="cursor:pointer"></div>
		</div>
		<div class="section">
			<div class="section-title">
				<span>分客户端订阅地址</span>
				<span style="font-weight:400;color:#909399;font-size:12px">按你用的软件选对应一行,点击复制</span>
			</div>
			<div id="clientList"></div>
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
					<button class="btn-primary" id="unlockBtn" style="width:100%" onclick="unlock()">解锁</button>
					<div class="error" id="pwdError"></div>
				</div>
			</div>
		</div>
	</div>
</div>
<script>
const HAS_PASSWORD = ${hasPassword ? 'true' : 'false'};
const TOKEN = ${jsonForScript(cfg.token)};
const SUB_URL = location.origin + '/' + TOKEN;
const STORAGE_KEY = 'sub_auth_' + TOKEN;
let AUTH_TOKEN = '';

document.getElementById('subUrl').textContent = SUB_URL;
document.getElementById('links').value = ${jsonForScript(currentData)};
updateCount();

// ---- 分客户端订阅地址 ----
const CLIENTS = [
	{ name: '通用 / base64', hint: 'v2rayN · v2rayNG · NekoBox · Shadowrocket', url: SUB_URL + '?b64=1' },
	{ name: 'Clash 系', hint: 'Clash Verge · Mihomo · Stash · Karing · Hiddify', url: SUB_URL + '?clash=1' },
	{ name: 'Sing-box', hint: 'sing-box · fluxbox · Hiddify(内核)', url: SUB_URL + '?sb=1' },
	{ name: 'Surge', hint: 'Surge · Surfboard', url: SUB_URL + '?surge=1' },
	{ name: 'Quantumult X', hint: '圈', url: SUB_URL + '?quanx=1' },
	{ name: 'Loon', hint: 'Loon', url: SUB_URL + '?loon=1' }
];
const clientList = document.getElementById('clientList');
CLIENTS.forEach(function (c) {
	const row = document.createElement('div');
	row.className = 'client-row';

	const name = document.createElement('div');
	name.className = 'client-name';
	name.appendChild(document.createTextNode(c.name));
	const hint = document.createElement('span');
	hint.className = 'hint';
	hint.textContent = c.hint;
	name.appendChild(hint);

	const urlBox = document.createElement('div');
	urlBox.className = 'client-url';
	urlBox.textContent = c.url;
	urlBox.title = c.url;

	const btn = document.createElement('button');
	btn.className = 'btn-secondary client-copy';
	btn.textContent = '复制';
	btn.onclick = function () { copyText(c.url, btn); };

	row.appendChild(name);
	row.appendChild(urlBox);
	row.appendChild(btn);
	clientList.appendChild(row);
});

function copyText(text, btn) {
	const done = function () {
		if (!btn) { alert('已复制: ' + text); return; }
		const old = btn.textContent;
		btn.textContent = '已复制';
		setTimeout(function () { btn.textContent = old; }, 1500);
	};
	if (navigator.clipboard && window.isSecureContext) {
		navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
	} else {
		fallbackCopy(text, done);
	}
}

function fallbackCopy(text, done) {
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.appendChild(ta);
	ta.select();
	try { document.execCommand('copy'); } catch (e) {}
	document.body.removeChild(ta);
	done();
}

function updateCount() {
	const v = document.getElementById('links').value;
	const lines = v.split('\\n').filter(function (l) { return l.trim(); });
	document.getElementById('nodeCount').textContent = lines.length + ' 条';
}

document.getElementById('links').addEventListener('input', updateCount);

function unlock() {
	const input = document.getElementById('pwdInput');
	const errBox = document.getElementById('pwdError');
	const btn = document.getElementById('unlockBtn');
	const pwd = input.value;
	if (!pwd) { errBox.textContent = '请输入密码'; return; }
	btn.disabled = true;
	errBox.textContent = '';
	fetch('?action=verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password: pwd })
	}).then(function (r) {
		return r.json();
	}).then(function (data) {
		if (data && data.ok) {
			AUTH_TOKEN = data.token || '';
			try { localStorage.setItem(STORAGE_KEY, AUTH_TOKEN); } catch (e) {}
			document.getElementById('lockOverlay').classList.add('hidden');
			input.value = '';
		} else {
			errBox.textContent = (data && data.msg) || '密码错误';
		}
		btn.disabled = false;
	}).catch(function () {
		errBox.textContent = '验证失败,请检查网络后重试';
		btn.disabled = false;
	});
}

function checkAuth() {
	let saved = '';
	try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { saved = ''; }
	if (!saved) return;
	fetch('?action=check', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ auth: saved })
	}).then(function (r) {
		return r.json();
	}).then(function (data) {
		if (data && data.ok) {
			AUTH_TOKEN = saved;
			document.getElementById('lockOverlay').classList.add('hidden');
		} else {
			try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
		}
	}).catch(function () {});
}

if (HAS_PASSWORD) {
	document.getElementById('lockOverlay').classList.remove('hidden');
	checkAuth();
}

function saveLinks() {
	if (HAS_PASSWORD && !AUTH_TOKEN) {
		alert('请先解锁');
		document.getElementById('lockOverlay').classList.remove('hidden');
		return;
	}
	const data = document.getElementById('links').value;
	fetch('?action=save', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ links: data, auth: AUTH_TOKEN })
	}).then(function (r) {
		return r.json().then(function (d) { return { status: r.status, data: d }; });
	}).then(function (res) {
		const d = res.data || {};
		if (d.ok) {
			alert('保存成功');
			updateCount();
		} else {
			alert('保存失败: ' + (d.msg || ('HTTP ' + res.status)));
			if (res.status === 401) {
				AUTH_TOKEN = '';
				try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
				document.getElementById('lockOverlay').classList.remove('hidden');
			}
		}
	}).catch(function (e) {
		alert('保存失败: ' + e);
	});
}

function clearLinks() {
	if (!confirm('确认清空所有节点?')) return;
	document.getElementById('links').value = '';
	updateCount();
}

function copySub() {
	copyText(SUB_URL, null);
}
</script>
</body>
</html>`;

	return htmlResponse(html, {
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:"
	});
}

// 处理编辑页 POST(验证 / 登录态检查 / 保存)
async function handleEditPost(request, cfg, url) {
	const action = url.searchParams.get('action') || '';
	let body;
	try {
		body = await request.json();
	} catch (e) {
		return jsonResponse({ ok: false, msg: '请求体不是合法 JSON' }, 400);
	}
	if (!body || typeof body !== 'object') {
		return jsonResponse({ ok: false, msg: '请求体格式错误' }, 400);
	}

	if (action === 'verify') {
		// 未配置密码:直接放行(与旧行为一致)
		if (!cfg.adminPassword) return jsonResponse({ ok: true, token: '' });
		const pwd = typeof body.password === 'string' ? body.password : '';
		if (!pwd || !timingSafeEqual(pwd, cfg.adminPassword)) {
			return jsonResponse({ ok: false, msg: '密码错误' }, 401);
		}
		const authToken = await createAuthToken(cfg);
		return jsonResponse({ ok: true, token: authToken, expires: Date.now() + AUTH_TTL });
	}

	if (action === 'check') {
		if (!cfg.adminPassword) return jsonResponse({ ok: true, token: '' });
		const ok = await verifyAuthToken(cfg, body.auth);
		return jsonResponse({ ok, msg: ok ? '' : '登录状态已失效' }, ok ? 200 : 401);
	}

	if (action === 'save') {
		// 启用密码时,后端二次校验(不信任前端状态)
		if (cfg.adminPassword) {
			const ok = await verifyAuthToken(cfg, body.auth);
			if (!ok) {
				return jsonResponse({ ok: false, msg: '登录状态无效或已过期,请重新解锁' }, 401);
			}
		}
		if (!cfg.kv) {
			return jsonResponse({ ok: false, msg: '未绑定 KV 命名空间' }, 400);
		}
		const links = typeof body.links === 'string' ? body.links : '';
		if (links.length > MAX_EDIT_BYTES) {
			return jsonResponse({ ok: false, msg: '内容过大,请控制在 ' + Math.floor(MAX_EDIT_BYTES / 1024) + 'KB 以内' }, 413);
		}
		try {
			await cfg.kv.put('LINK.txt', links);
			return jsonResponse({ ok: true });
		} catch (e) {
			return jsonResponse({ ok: false, msg: 'KV 写入失败: ' + errText(e) }, 500);
		}
	}

	return jsonResponse({ ok: false, msg: '未知操作' }, 400);
}

// 登录态 = 过期时间 + HMAC-SHA256(不把明文密码存到浏览器)
async function hmacHex(key, message) {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
	return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createAuthToken(cfg) {
	const expires = Date.now() + AUTH_TTL;
	const signature = await hmacHex(cfg.adminPassword + '|' + cfg.token, String(expires));
	return expires + '.' + signature;
}

async function verifyAuthToken(cfg, auth) {
	if (!cfg.adminPassword || !auth || typeof auth !== 'string') return false;
	const parts = auth.split('.');
	if (parts.length !== 2) return false;
	const expires = parseInt(parts[0], 10);
	if (!Number.isFinite(expires) || expires < Date.now()) return false;
	const expect = await hmacHex(cfg.adminPassword + '|' + cfg.token, String(expires));
	return timingSafeEqual(expect, parts[1]);
}

function timingSafeEqual(a, b) {
	const left = String(a == null ? '' : a);
	const right = String(b == null ? '' : b);
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return diff === 0;
}

function escapeHTML(text) {
	return String(text == null ? '' : text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// 内嵌到 <script> 的 JSON:转义 < > & 与 U+2028/U+2029,防止提前闭合标签
function jsonForScript(value) {
	return JSON.stringify(value == null ? '' : value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
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
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}
