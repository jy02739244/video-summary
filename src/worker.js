export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ===== 认证辅助函数 =====
    const AUTH_PAYLOAD = "authenticated";

    async function getHmacKey(secret) {
      const enc = new TextEncoder();
      return crypto.subtle.importKey(
        "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
      );
    }

    async function generateAuthSignature(secret) {
      const enc = new TextEncoder();
      const key = await getHmacKey(secret);
      const sig = await crypto.subtle.sign("HMAC", key, enc.encode(AUTH_PAYLOAD));
      return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    async function sha256Hex(text) {
      const enc = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", enc.encode(text));
      return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    function hexToBytes(hex) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      }
      return bytes;
    }

    function parseCookie(cookieHeader, name) {
      if (!cookieHeader) return null;
      const match = cookieHeader.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
      return match ? match[1] : null;
    }

    function buildImageProxyUrl(rawUrl) {
      return "/api/image-proxy?url=" + encodeURIComponent(rawUrl);
    }

    async function verifyAuthCookie(request, secret) {
      const cookieHeader = request.headers.get("Cookie") || "";
      const token = parseCookie(cookieHeader, "auth");
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
      const enc = new TextEncoder();
      const key = await getHmacKey(secret);
      // 使用 crypto.subtle.verify 进行常量时间比较，防止时序攻击
      return crypto.subtle.verify("HMAC", key, hexToBytes(token), enc.encode(AUTH_PAYLOAD));
    }

    // ===== 认证路由：POST /api/login =====
    if (request.method === "POST" && url.pathname === "/api/login") {
      try {
        const body = await request.json();
        const token = body.token;
        if (!token || typeof token !== "string") {
          return new Response(JSON.stringify({ error: "缺少密码" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: "密码错误" }), {
            status: 401, headers: { "Content-Type": "application/json" },
          });
        }
        const sig = await generateAuthSignature(env.AUTH_TOKEN);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "auth=" + sig + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "请求体解析失败" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ===== 认证路由：GET /api/auth-status =====
    if (request.method === "GET" && url.pathname === "/api/auth-status") {
      if (!env.AUTH_TOKEN) {
        return new Response(JSON.stringify({ authed: true, authEnabled: false }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const authed = await verifyAuthCookie(request, env.AUTH_TOKEN);
      return new Response(JSON.stringify({ authed, authEnabled: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ===== 认证路由：POST /api/logout =====
    if (request.method === "POST" && url.pathname === "/api/logout") {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
        },
      });
    }

    // ===== 图片代理：用于规避第三方图床防盗链 =====
    if (request.method === "GET" && url.pathname === "/api/image-proxy") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return new Response("缺少 url", { status: 400 });
      }

      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (e) {
        return new Response("url 格式错误", { status: 400 });
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return new Response("仅支持 http(s) 图片地址", { status: 400 });
      }

      try {
        const imageResp = await fetch(parsed.toString(), {
          headers: {
            "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "referer": "https://www.bilibili.com/",
            "user-agent": "Mozilla/5.0",
          },
        });

        if (!imageResp.ok) {
          return new Response("图片拉取失败: " + imageResp.status, { status: imageResp.status });
        }

        const contentType = imageResp.headers.get("content-type") || "image/jpeg";
        return new Response(imageResp.body, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (e) {
        return new Response("图片代理失败", { status: 500 });
      }
    }

    // ===== 认证中间件：保护除 GET / 以外的所有路由 =====
    if (env.AUTH_TOKEN && !(request.method === "GET" && url.pathname === "/")) {
      const authed = await verifyAuthCookie(request, env.AUTH_TOKEN);
      if (!authed) {
        return new Response(JSON.stringify({ error: "未认证，请先登录" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 小工具：解析视频链接，YouTube 返回标准 watch 链接，其它站点保留原始 URL
    function getVideoSourceInfo(rawUrl) {
      try {
        const u = new URL(rawUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return null;
        }
        if (u.hostname === "youtu.be") {
          const id = u.pathname.replace("/", "");
          if (!id) return null;
          return {
            platform: "youtube",
            canonicalUrl: "https://www.youtube.com/watch?v=" + id,
            videoId: id,
          };
        }
        if (u.hostname.endsWith("youtube.com")) {
          const id = u.searchParams.get("v");
          if (id) {
            return {
              platform: "youtube",
              canonicalUrl: "https://www.youtube.com/watch?v=" + id,
              videoId: id,
            };
          }
          if (u.pathname.startsWith("/shorts/")) {
            const shortId = u.pathname.split("/")[2];
            if (shortId) {
              return {
                platform: "youtube",
                canonicalUrl: "https://www.youtube.com/watch?v=" + shortId,
                videoId: shortId,
              };
            }
          }
          return null;
        }

        if (u.hostname === "b23.tv" || u.hostname.endsWith("bilibili.com")) {
          u.hash = "";
          return {
            platform: "bilibili",
            canonicalUrl: u.toString(),
            videoId: "",
          };
        }

        u.hash = "";
        return {
          platform: "generic",
          canonicalUrl: u.toString(),
          videoId: "",
        };
      } catch (e) {
        return null;
      }
    }

    // ===== 1. 页面：极简 + 模态框左右分栏 =====
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>视频总结</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: light;
      --bg-1: #f4f9ff;
      --bg-2: #f6fbff;
      --bg-3: #f9fbff;
      --text-main: #111827;
      --text-muted: #64748b;
      --primary: #4f8df8;
      --primary-2: #7db8ff;
      --accent: #87d3ff;
      --line: rgba(130, 158, 196, 0.14);
      --surface: rgba(255, 255, 255, 0.7);
      --surface-strong: rgba(255, 255, 255, 0.8);
      --border: rgba(176, 196, 222, 0.44);
      --border-soft: rgba(176, 196, 222, 0.3);
      --radius-xl: 24px;
      --radius-lg: 16px;
      --radius-md: 12px;
      --shadow-card: 0 24px 66px rgba(148, 163, 184, 0.3);
      --shadow-modal: 0 30px 82px rgba(148, 163, 184, 0.38);
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      min-height: 100%;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Manrope", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(950px 520px at -8% -10%, rgba(158, 210, 255, 0.44), transparent 63%),
        radial-gradient(860px 500px at 104% -8%, rgba(174, 235, 255, 0.36), transparent 62%),
        radial-gradient(760px 480px at 52% 120%, rgba(238, 225, 255, 0.38), transparent 64%),
        linear-gradient(165deg, var(--bg-1) 0%, var(--bg-2) 52%, var(--bg-3) 100%);
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px 14px;
      position: relative;
      overflow-x: hidden;
    }

    body.modal-open {
      overflow: hidden;
    }

    .bg-grid {
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background-image:
        linear-gradient(to right, var(--line) 1px, transparent 1px),
        linear-gradient(to bottom, var(--line) 1px, transparent 1px);
      background-size: 52px 52px;
      mask-image: radial-gradient(circle at 50% 40%, #000 24%, transparent 84%);
      opacity: 0.32;
    }

    .bg-shape {
      position: fixed;
      border-radius: 999px;
      pointer-events: none;
      filter: blur(2px);
      z-index: 0;
      animation-timing-function: ease-in-out;
      animation-iteration-count: infinite;
      animation-direction: alternate;
    }

    .bg-shape-a {
      width: 380px;
      height: 380px;
      left: -140px;
      top: -110px;
      background: radial-gradient(circle, rgba(146, 197, 255, 0.5) 0%, rgba(146, 197, 255, 0) 70%);
      animation-name: floatA;
      animation-duration: 12s;
    }

    .bg-shape-b {
      width: 460px;
      height: 460px;
      right: -220px;
      bottom: -220px;
      background: radial-gradient(circle, rgba(175, 227, 255, 0.42) 0%, rgba(175, 227, 255, 0) 70%);
      animation-name: floatB;
      animation-duration: 13s;
    }

    .bg-shape-c {
      width: 320px;
      height: 320px;
      left: 42%;
      bottom: -180px;
      background: radial-gradient(circle, rgba(225, 210, 255, 0.42) 0%, rgba(225, 210, 255, 0) 70%);
      animation-name: floatA;
      animation-duration: 14s;
    }

    @keyframes floatA {
      from {
        transform: translate(0, 0);
      }
      to {
        transform: translate(16px, 14px);
      }
    }

    @keyframes floatB {
      from {
        transform: translate(0, 0);
      }
      to {
        transform: translate(-20px, -12px);
      }
    }

    .center-card {
      position: relative;
      z-index: 2;
      width: 100%;
      max-width: 660px;
      background: linear-gradient(170deg, var(--surface-strong), var(--surface));
      border-radius: var(--radius-xl);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-card);
      padding: 24px 22px 18px;
      backdrop-filter: blur(26px) saturate(1.22);
      animation: cardEnter 0.65s cubic-bezier(0.22, 1, 0.36, 1);
      overflow: visible;
    }

    .center-card::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(420px 140px at -8% 0%, rgba(174, 225, 255, 0.44), transparent 72%),
        radial-gradient(440px 160px at 105% 100%, rgba(222, 210, 255, 0.34), transparent 72%);
    }

    .center-card::after {
      content: "";
      position: absolute;
      left: -8px;
      right: -8px;
      top: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(158, 210, 255, 0.95), transparent);
    }

    @keyframes cardEnter {
      from {
        opacity: 0;
        transform: translateY(14px) scale(0.985);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .title-wrap {
      text-align: center;
      margin-bottom: 16px;
      position: relative;
      z-index: 1;
    }

    .kicker {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 5px 12px;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-weight: 700;
      color: #41658d;
      background: rgba(255, 255, 255, 0.62);
      border: 1px solid rgba(176, 196, 222, 0.42);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.95),
        0 10px 22px rgba(191, 204, 222, 0.3);
    }

    .title {
      margin: 10px 0 6px;
      font-size: 34px;
      line-height: 1.1;
      letter-spacing: -0.01em;
      font-weight: 800;
      font-family: "Outfit", "Manrope", "Noto Sans SC", sans-serif;
      color: #0f1e34;
      text-shadow: 0 8px 22px rgba(184, 202, 227, 0.55);
    }

    .subtitle {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      color: #62728a;
    }

    .row {
      display: flex;
      gap: 10px;
      align-items: center;
      position: relative;
      z-index: 1;
    }

    .action-group {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .provider-select {
      height: 32px;
      padding: 0 10px;
      font-size: 12px;
      border-radius: 999px;
      border: 1px solid var(--border-soft);
      outline: none;
      background: rgba(255, 255, 255, 0.72);
      color: #64748b;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.86),
        0 4px 14px rgba(148, 163, 184, 0.18);
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
      min-width: 114px;
      cursor: pointer;
    }

    .provider-select:focus {
      border-color: rgba(79, 141, 248, 0.52);
      box-shadow:
        0 0 0 3px rgba(79, 141, 248, 0.14),
        inset 0 1px 0 rgba(255, 255, 255, 0.95),
        0 6px 16px rgba(148, 163, 184, 0.22);
    }

    .input {
      flex: 1;
      height: 44px;
      padding: 10px 14px;
      font-size: 14px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-soft);
      outline: none;
      transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
      background: rgba(255, 255, 255, 0.68);
      color: var(--text-main);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.86),
        0 8px 20px rgba(195, 206, 225, 0.24);
    }

    .input::placeholder {
      color: rgba(109, 128, 154, 0.9);
    }

    .input:focus {
      border-color: rgba(132, 173, 239, 0.82);
      box-shadow:
        0 0 0 3px rgba(174, 207, 255, 0.34),
        0 12px 28px rgba(178, 191, 222, 0.34);
      background: #ffffff;
    }

    .cta-btn {
      border-radius: 999px;
      border: 0;
      cursor: pointer;
      height: 44px;
      padding: 0 18px;
      font-size: 13px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      color: #ffffff;
      background: linear-gradient(135deg, #6f95ff, #79c2ff 58%, #9fd7ff);
      box-shadow: 0 16px 30px rgba(133, 168, 226, 0.45);
      transition: transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
      position: relative;
      overflow: hidden;
      text-shadow: 0 1px 2px rgba(41, 64, 112, 0.25);
    }

    .cta-btn::before {
      content: "";
      position: absolute;
      top: 0;
      left: -120%;
      width: 90%;
      height: 100%;
      background: linear-gradient(90deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0));
      transform: skewX(-18deg);
      transition: left 0.55s ease;
    }

    .cta-btn:hover::before {
      left: 130%;
    }

    .cta-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 20px 36px rgba(141, 175, 230, 0.5);
      filter: saturate(1.05);
    }

    .cta-btn:active {
      transform: translateY(0);
      box-shadow: 0 12px 24px rgba(141, 175, 230, 0.42);
    }

    .cta-btn[disabled] {
      opacity: 0.72;
      cursor: default;
      transform: none;
      box-shadow: 0 8px 18px rgba(100, 116, 139, 0.35);
      filter: none;
    }

    .icon-btn {
      width: 44px;
      height: 44px;
      border-radius: 999px;
      border: 1px solid rgba(176, 196, 222, 0.7);
      background: rgba(255, 255, 255, 0.7);
      color: #34517a;
      font-size: 17px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 22px rgba(182, 197, 221, 0.32);
      transition:
        transform 0.15s ease,
        background 0.15s ease,
        border-color 0.2s ease,
        box-shadow 0.2s ease;
    }

    .icon-btn:hover {
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 0.9);
    }

    .icon-btn:active {
      transform: translateY(0);
    }

    .icon-btn.is-active {
      background: rgba(255, 255, 255, 0.95);
      border-color: rgba(131, 172, 237, 0.8);
      box-shadow:
        0 12px 26px rgba(165, 185, 218, 0.4),
        0 0 0 3px rgba(175, 207, 255, 0.25);
    }

    .icon-btn[disabled] {
      opacity: 0.7;
      cursor: default;
      transform: none;
    }

    .spinner {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.26);
      border-top-color: #ffffff;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .status {
      margin: 12px auto 0;
      max-width: 560px;
      min-height: 1.2em;
      font-size: 12px;
      line-height: 1.55;
      color: #64748b;
      text-align: center;
      position: relative;
      z-index: 1;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.22s ease, transform 0.22s ease, background 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
    }

    .status.has-message {
      opacity: 1;
      transform: translateY(0);
      padding: 10px 14px;
      border-radius: 14px;
      border: 1px solid transparent;
      background: rgba(255, 255, 255, 0.64);
      box-shadow: 0 10px 24px rgba(191, 204, 222, 0.18);
    }

    .status.status-loading {
      color: #335c8f;
      background: linear-gradient(180deg, rgba(237, 245, 255, 0.92), rgba(248, 251, 255, 0.9));
      border-color: rgba(148, 191, 255, 0.45);
    }

    .status.status-success {
      color: #0f766e;
      background: linear-gradient(180deg, rgba(236, 253, 245, 0.94), rgba(245, 255, 251, 0.92));
      border-color: rgba(110, 231, 183, 0.52);
    }

    .status.status-error {
      color: #b91c1c;
      font-weight: 700;
      background: linear-gradient(180deg, rgba(254, 242, 242, 0.98), rgba(255, 247, 247, 0.95));
      border-color: rgba(248, 113, 113, 0.5);
      box-shadow:
        0 14px 32px rgba(248, 113, 113, 0.16),
        0 0 0 4px rgba(254, 226, 226, 0.65);
    }

    .tiny-tip {
      margin: 6px 0 0;
      text-align: center;
      font-size: 12px;
      color: rgba(100, 116, 139, 0.88);
      position: relative;
      z-index: 1;
    }

    

    
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.35s ease, backdrop-filter 0.35s ease;
      z-index: 50;
      backdrop-filter: blur(0px);
    }

    .modal-backdrop.show {
      opacity: 1;
      pointer-events: auto;
      backdrop-filter: blur(12px);
    }

    .modal {
      width: 92vw;
      height: 90vh;
      max-width: 1200px;
      max-height: 880px;
      background: linear-gradient(160deg, #ffffff, #f4f8ff);
      border-radius: var(--radius-xl);
      box-shadow: 0 25px 50px -12px rgba(15, 23, 42, 0.25), 0 0 0 1px rgba(255,255,255,0.7) inset;
      border: 1px solid rgba(195, 211, 233, 0.6);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transform: translateY(20px) scale(0.97);
      opacity: 0;
      transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.3s ease;
      position: relative;
    }

    .modal-backdrop.show .modal {
      transform: translateY(0) scale(1);
      opacity: 1;
    }

    .modal-header {
      padding: 20px 28px;
      border-bottom: 1px solid rgba(195, 211, 233, 0.4);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: rgba(255, 255, 255, 0.8);
      backdrop-filter: blur(10px);
      z-index: 10;
    }

    .modal-title {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.01em;
      color: #0f172a;
    }

    .modal-subtitle {
      font-size: 13px;
      color: #64748b;
      margin-top: 4px;
    }

    .modal-close {
      border-radius: 999px;
      border: 1px solid rgba(195, 211, 233, 0.6);
      background: #ffffff;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      color: #334155;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(148, 163, 184, 0.1);
    }

    .modal-close:hover {
      background: #f8fafc;
      border-color: #94a3b8;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(148, 163, 184, 0.15);
      color: #0f172a;
    }

    .modal-body {
      padding: 24px;
      flex: 1;
      overflow: hidden;
      background: rgba(244, 249, 255, 0.3);
    }

    .modal-main {
      display: flex;
      height: 100%;
      gap: 24px;
    }

    .video-side {
      width: 320px;
      flex-shrink: 0;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(255, 255, 255, 0.9);
      background: rgba(255, 255, 255, 0.7);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow: auto;
      backdrop-filter: blur(20px);
      box-shadow: 0 4px 20px rgba(148, 163, 184, 0.08);
    }

    .video-side.is-loading {
      pointer-events: none;
    }

    .video-thumb-wrap {
      border-radius: 12px;
      overflow: hidden;
      background: #e2e8f0;
      aspect-ratio: 16 / 9;
      position: relative;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.7);
    }

    .video-thumb-placeholder {
      position: absolute;
      inset: 0;
      background:
        linear-gradient(110deg, rgba(255, 255, 255, 0) 22%, rgba(255, 255, 255, 0.72) 50%, rgba(255, 255, 255, 0) 78%),
        linear-gradient(180deg, #e8eef8 0%, #dbe6f4 100%);
      background-size: 220% 100%, 100% 100%;
      animation: skeletonShift 1.35s ease-in-out infinite;
      transition: opacity 0.24s ease;
    }

    .video-thumb-wrap.has-image .video-thumb-placeholder {
      opacity: 0;
    }

    .video-thumb-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
      transform: scale(1.03);
      filter: saturate(0.94) blur(3px);
      transition: transform 0.42s ease, opacity 0.32s ease, filter 0.42s ease;
      position: relative;
      z-index: 1;
      will-change: opacity, transform, filter;
    }

    .video-thumb-wrap.has-image img {
      opacity: 1;
      transform: scale(1);
      filter: saturate(1) blur(0);
      animation: thumbReveal 0.52s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .video-thumb-wrap:hover img {
      transform: scale(1.05);
    }

    @keyframes thumbReveal {
      from {
        opacity: 0;
        transform: scale(1.035);
        filter: saturate(0.94) blur(3px);
      }
      to {
        opacity: 1;
        transform: scale(1);
        filter: saturate(1) blur(0);
      }
    }

    .video-side.is-loading .video-meta-title,
    .video-side.is-loading .video-meta-author,
    .video-side.is-loading .video-meta-extra {
      color: transparent;
      position: relative;
      min-height: 18px;
    }

    .video-side.is-loading .video-meta-title::before,
    .video-side.is-loading .video-meta-author::before,
    .video-side.is-loading .video-meta-extra::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      height: 16px;
      border-radius: 999px;
      background:
        linear-gradient(110deg, rgba(255, 255, 255, 0) 22%, rgba(255, 255, 255, 0.82) 50%, rgba(255, 255, 255, 0) 78%),
        linear-gradient(180deg, #eef4fb 0%, #dce7f5 100%);
      background-size: 220% 100%, 100% 100%;
      animation: skeletonShift 1.35s ease-in-out infinite;
    }

    .video-side.is-loading .video-meta-title::before {
      width: 88%;
      height: 18px;
    }

    .video-side.is-loading .video-meta-author::before {
      width: 54%;
    }

    .video-side.is-loading #videoSubs::before {
      width: 48%;
    }

    .video-side.is-loading #videoViews::before {
      width: 44%;
    }

    .video-side.is-loading #videoPublishedAt::before {
      width: 58%;
    }

    @keyframes skeletonShift {
      0% {
        background-position: 200% 0, 0 0;
      }
      100% {
        background-position: -20% 0, 0 0;
      }
    }

    .video-meta-title {
      font-size: 15px;
      font-weight: 700;
      line-height: 1.5;
      margin-top: 6px;
      color: #1e293b;
    }

    .video-meta-title a {
      color: inherit;
      text-decoration: none;
      transition: color 0.2s;
    }

    .video-meta-title a:hover {
      color: #2563eb;
    }

    .video-meta-author {
      font-size: 14px;
      color: #475569;
      margin-top: 4px;
      font-weight: 500;
    }

    .video-meta-author a {
      color: inherit;
      text-decoration: none;
      transition: color 0.2s;
    }

    .video-meta-author a:hover {
      color: #2563eb;
    }

    .video-meta-extra {
      font-size: 13px;
      color: #64748b;
      margin-top: 2px;
    }

    .summary-side {
      flex: 1;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(255, 255, 255, 0.9);
      background: #ffffff;
      padding: 32px 40px;
      overflow: auto;
      box-shadow: 0 8px 30px rgba(148, 163, 184, 0.08);
      backdrop-filter: blur(20px);
      position: relative;
    }

    .summary-loading {
      position: absolute;
      inset: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 14px;
      border-radius: 18px;
      background:
        radial-gradient(circle at top, rgba(125, 184, 255, 0.12), transparent 55%),
        linear-gradient(180deg, rgba(248, 251, 255, 0.96), rgba(255, 255, 255, 0.92));
      border: 1px solid rgba(219, 234, 254, 0.9);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.24s ease, visibility 0.24s ease;
      z-index: 2;
    }

    .summary-loading.show {
      opacity: 1;
      visibility: visible;
    }

    .summary-loading-spinner {
      width: 40px;
      height: 40px;
      border-radius: 999px;
      border: 3px solid rgba(79, 141, 248, 0.18);
      border-top-color: var(--primary);
      box-shadow: 0 10px 30px rgba(125, 184, 255, 0.22);
      animation: spin 0.82s linear infinite;
    }

    .summary-loading-text {
      font-size: 14px;
      font-weight: 600;
      color: #5b6b84;
      letter-spacing: 0.01em;
    }

    .summary-content {
      font-size: 15px;
      line-height: 1.8;
      color: #334155;
      animation: fadeIn 0.4s ease forwards;
      min-height: 100%;
    }

    .summary-empty-state {
      margin: 86px auto 0;
      max-width: 520px;
      border-radius: 20px;
      padding: 22px 20px;
      text-align: center;
      line-height: 1.8;
      border: 1px solid rgba(226, 232, 240, 0.88);
      background: linear-gradient(180deg, rgba(248, 250, 252, 0.92), rgba(255, 255, 255, 0.96));
      box-shadow: 0 18px 42px rgba(148, 163, 184, 0.12);
    }

    .summary-empty-state.is-error {
      border-color: rgba(248, 113, 113, 0.38);
      background: linear-gradient(180deg, rgba(254, 242, 242, 0.96), rgba(255, 250, 250, 0.98));
      box-shadow:
        0 22px 46px rgba(248, 113, 113, 0.12),
        0 0 0 5px rgba(254, 226, 226, 0.58);
    }

    .summary-empty-state-badge {
      width: 42px;
      height: 42px;
      margin: 0 auto 12px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 800;
      color: #ffffff;
      background: linear-gradient(135deg, #ef4444, #fb7185);
      box-shadow: 0 12px 24px rgba(248, 113, 113, 0.24);
    }

    .summary-empty-state-title {
      font-size: 18px;
      font-weight: 800;
      color: #7f1d1d;
      margin-bottom: 6px;
    }

    .summary-empty-state-text {
      font-size: 14px;
      color: #991b1b;
      white-space: pre-wrap;
      word-break: break-word;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .summary-content h1,
    .summary-content h2,
    .summary-content h3 {
      font-weight: 800;
      color: #0f172a;
      margin: 1.5em 0 0.8em;
      letter-spacing: -0.01em;
    }

    .summary-content h1 {
      font-size: 24px;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 8px;
    }

    .summary-content h2 {
      font-size: 18px;
      padding: 8px 16px;
      background: linear-gradient(90deg, #f1f5f9, transparent);
      border-left: 4px solid #3b82f6;
      border-radius: 0 8px 8px 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .summary-content h3 {
      font-size: 16px;
      color: #1e293b;
    }

    .summary-content p {
      margin: 1em 0;
    }

    .summary-content ul,
    .summary-content ol {
      margin: 1em 0;
      padding-left: 24px;
    }

    .summary-content li {
      margin: 0.5em 0;
    }

    .summary-content li::marker {
      color: #94a3b8;
    }

    .summary-content a {
      color: #2563eb;
      text-decoration: none;
      font-weight: 600;
      padding: 2px 6px;
      background: rgba(37, 99, 235, 0.08);
      border-radius: 6px;
      transition: all 0.2s ease;
    }

    .summary-content a:hover {
      background: #2563eb;
      color: #ffffff;
      box-shadow: 0 4px 10px rgba(37, 99, 235, 0.2);
    }

    .summary-content code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9em;
      background: #f1f5f9;
      color: #0f172a;
      padding: 0.2em 0.4em;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
    }

    .copy-btn {
      position: sticky;
      top: 0;
      float: right;
      z-index: 10;
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(195, 211, 233, 0.6);
      border-radius: 8px;
      padding: 6px 8px;
      cursor: pointer;
      color: #64748b;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s ease;
      backdrop-filter: blur(8px);
      box-shadow: 0 2px 8px rgba(148, 163, 184, 0.1);
    }

    .copy-btn:hover {
      background: #f8fafc;
      border-color: #94a3b8;
      color: #334155;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(148, 163, 184, 0.15);
    }

    .copy-btn.copied {
      background: #ecfdf5;
      border-color: #6ee7b7;
      color: #059669;
    }

    .history-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 20px;
      padding: 4px;
    }
    
    .history-card {
      border-radius: var(--radius-lg);
      border: 1px solid rgba(255, 255, 255, 0.8);
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.95), rgba(248, 250, 252, 0.85));
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 6px 16px rgba(148, 163, 184, 0.1);
      backdrop-filter: blur(10px);
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      cursor: pointer;
      text-align: left;
      position: relative;
      overflow: hidden;
    }
    
    .history-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      border-radius: inherit;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.6);
      pointer-events: none;
    }

    .history-card:hover {
      transform: translateY(-4px) scale(1.01);
      box-shadow: 0 16px 30px rgba(100, 116, 139, 0.15);
      background: #ffffff;
    }
    
    .history-card .video-thumb-wrap {
      border-radius: 10px;
      overflow: hidden;
      background: #e2e8f0;
      aspect-ratio: 16 / 9;
      position: relative;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.5);
      transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.34s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .history-card .video-thumb-wrap::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(148, 163, 184, 0.04));
      opacity: 1;
      transition: opacity 0.28s ease;
      pointer-events: none;
      z-index: 1;
    }

    .history-card .video-thumb-wrap.is-loaded::after {
      opacity: 0;
    }
    
    .history-card .video-thumb-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
      transform: scale(1.025);
      filter: saturate(0.96) blur(2px);
      will-change: auto;
      transition: opacity 0.28s ease, transform 0.34s cubic-bezier(0.22, 1, 0.36, 1), filter 0.34s cubic-bezier(0.22, 1, 0.36, 1);
      position: relative;
      z-index: 0;
    }

    .history-card .video-thumb-wrap.is-loaded img {
      opacity: 1;
      transform: scale(1);
      filter: saturate(1) blur(0);
    }

    .history-card:hover .video-thumb-wrap img {
      transform: scale(1.045);
      filter: saturate(1.04) blur(0);
    }

    .history-card:hover .video-thumb-wrap {
      transform: translateY(-2px);
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,0.5),
        0 12px 26px rgba(148, 163, 184, 0.16);
    }

    .history-card .video-meta-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.4;
      margin-top: 4px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #0f172a;
      transition: color 0.24s ease, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), text-shadow 0.3s ease;
      transform: translateX(0);
    }

    .history-card:hover .video-meta-title {
      color: #1d4ed8;
      transform: translateX(2px);
      text-shadow: 0 8px 18px rgba(96, 165, 250, 0.18);
    }
    
    .history-card .video-meta-author {
      font-size: 13px;
      color: #475569;
      margin-top: 4px;
    }
    
    .history-card .video-meta-extra {
      font-size: 12px;
      color: #64748b;
      margin-top: 2px;
    }
    
    .history-card .card-actions {
      margin-top: auto;
      display: flex;
      justify-content: flex-end;
      padding-top: 10px;
    }
    
    .history-card .delete-btn {
      background: #fff;
      border: 1px solid #e2e8f0;
      color: #ef4444;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
      z-index: 2;
      min-width: 68px;
      justify-content: center;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    
    .history-card .delete-btn:hover {
      background: #fee2e2;
      border-color: #fca5a5;
      color: #dc2626;
    }

    .history-card .delete-btn.is-loading {
      color: #b91c1c;
      background: #fff5f5;
      border-color: #fecaca;
      cursor: default;
      pointer-events: none;
    }

    .history-card .delete-btn-label {
      display: inline-flex;
      align-items: center;
    }

    .history-card .delete-btn-spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(239, 68, 68, 0.18);
      border-top-color: #ef4444;
      animation: spin 0.72s linear infinite;
      display: none;
      flex-shrink: 0;
    }

    .history-card .delete-btn.is-loading .delete-btn-spinner {
      display: inline-block;
    }

    @media (max-width: 640px) {
      body {
        padding: 18px 10px;
      }

      .center-card {
        border-radius: 18px;
        padding: 18px 14px 14px;
      }

      .bg-grid {
        background-size: 32px 32px;
      }

      .title {
        font-size: 26px;
      }

      .subtitle {
        font-size: 13px;
      }

      .row {
        flex-direction: column;
        align-items: stretch;
      }

      .action-group {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .cta-btn {
        flex: 1;
        width: auto;
        justify-content: center;
      }

      .top-controls {
        top: 10px;
        right: 10px;
      }

      .top-controls .provider-select {
        max-width: 116px;
      }

      .history-panel {
        right: 0;
        left: 0;
        width: 100%;
      }

      .modal {
        border-radius: 0;
        max-height: 100dvh;
      }

      .modal-main {
        flex-direction: column;
      }

      .video-side,
      .summary-side {
        width: 100%;
        border-radius: 12px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .center-card,
      .modal,
      .modal-backdrop,
      .history-panel,
      .history-item,
      .bg-grid,
      .bg-shape,
      .modal-header,
      .modal-close,
      .video-side,
      .summary-side,
      .summary-content,
      .video-thumb-placeholder,
      .video-side.is-loading .video-meta-title::before,
      .video-side.is-loading .video-meta-author::before,
      .video-side.is-loading .video-meta-extra::before {
        animation: none !important;
        transition: none !important;
      }
    }

    #authModalBackdrop {
      z-index: 100;
    }

    #authModalBackdrop .modal {
      width: auto;
      height: auto;
      max-width: 420px;
      max-height: none;
      min-width: 340px;
    }

    #authModalBackdrop .auth-body {
      padding: 24px 28px;
    }

    #authModalBackdrop .auth-body .input {
      width: 100%;
      margin-bottom: 12px;
    }

    .auth-error {
      color: #ef4444;
      font-size: 13px;
      min-height: 1.4em;
      margin-bottom: 10px;
    }

    .logout-btn {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--border-soft);
      border-radius: 999px;
      cursor: pointer;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 14px rgba(148, 163, 184, 0.18);
      transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
    }

    .logout-btn:hover {
      background: rgba(255, 255, 255, 0.92);
      color: #ef4444;
      box-shadow: 0 6px 18px rgba(148, 163, 184, 0.28);
    }

    .logout-btn.show {
      display: inline-flex;
    }

    .public-badge {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 700;
      color: #0f766e;
      background: rgba(236, 253, 245, 0.9);
      border: 1px solid rgba(110, 231, 183, 0.72);
      border-radius: 999px;
      box-shadow: 0 4px 14px rgba(110, 231, 183, 0.14);
      backdrop-filter: blur(12px);
      user-select: none;
    }

    .public-badge.show {
      display: inline-flex;
    }

    .top-controls {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .top-controls .provider-select {
      max-width: 132px;
    }
  </style>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="top-controls">
    <select id="providerSelect" class="provider-select" title="选择模型提供方">
      <option value="auto">自动</option>
      <option value="gemini">Gemini</option>
      <option value="openai_compatible">OpenAI 兼容</option>
    </select>
    <button id="logoutBtn" class="logout-btn" title="退出登录">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      退出
    </button>
    <div id="publicBadge" class="public-badge" aria-label="当前为公开访问模式">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.2 2.2 4.8-5.2"/></svg>
      公开
    </div>
  </div>

  <div class="bg-shape bg-shape-a"></div>
  <div class="bg-shape bg-shape-b"></div>
  <div class="bg-shape bg-shape-c"></div>

  <!-- 登录认证模态框 -->
  <div id="authModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <header class="modal-header">
        <div>
          <div class="modal-title">访问验证</div>
          <div class="modal-subtitle">请输入访问密码以继续使用。</div>
        </div>
      </header>
      <div class="auth-body">
        <input id="authTokenInput" class="input" type="password" placeholder="请输入访问密码" autocomplete="current-password" />
        <div id="authError" class="auth-error"></div>
        <button id="authLoginBtn" class="cta-btn" style="width:100%; justify-content:center;">
          <div class="spinner" id="authSpinner" style="display:none"></div>
          <span id="authBtnText">登录</span>
        </button>
      </div>
    </div>
  </div>

  <div class="center-card">
    <div class="title-wrap">
      <div class="kicker">Spatial Summary</div>
      <h1 class="title">视频总结</h1>
      <p class="subtitle">粘贴视频链接，快速获取带时间戳的结构化内容摘要。</p>
    </div>
    <div class="row">
      <input
        id="videoUrl"
        class="input"
        type="text"
        placeholder="粘贴视频链接，例如：https://www.youtube.com/watch?v=... 或 https://www.bilibili.com/video/BV..."
      />
      <div class="action-group">
        <button id="summarizeBtn" class="cta-btn">
          <div class="spinner" id="spinner" style="display:none"></div>
          <span id="btnText">生成总结</span>
        </button>
        <button id="historyBtn" class="icon-btn" title="查看历史记录">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
        </button>
      </div>
    </div>
    <div id="status" class="status"></div>
    <p class="tiny-tip">自动模式：YouTube 优先走 Gemini（默认使用官方地址；若未配置 API Key 或模型且 OpenAI 兼容配置完整，会自动降级到 OpenAI 兼容），其他链接（如 Bilibili）走 OpenAI 兼容。</p>
  </div>

  <!-- 全屏模态框 -->
  <div id="summaryModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <header class="modal-header">
        <div>
          <div class="modal-title">总结结果</div>
          <div class="modal-subtitle">左侧是视频信息，右侧是带时间戳的总结。</div>
        </div>
        <button id="closeModalBtn" class="modal-close">
          ✕ 关闭
        </button>
      </header>
      <div class="modal-body">
        <div class="modal-main">
          <aside class="video-side">
            <div class="video-thumb-wrap">
              <div class="video-thumb-placeholder" aria-hidden="true"></div>
              <img id="videoThumb" alt="视频封面" />
            </div>
            <div class="video-meta-title" id="videoTitle"></div>
            <div class="video-meta-author" id="videoAuthor"></div>
            <div class="video-meta-extra" id="videoSubs"></div>
            <div class="video-meta-extra" id="videoViews"></div>
            <div class="video-meta-extra" id="videoPublishedAt"></div>
          </aside>
          <section class="summary-side">
            <button id="copyBtn" class="copy-btn" title="复制 Markdown">
              <svg id="copyIcon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
              </svg>
              <svg id="checkIcon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="display:none">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span id="copyLabel">复制</span>
            </button>
            <div id="summaryLoading" class="summary-loading" aria-live="polite" aria-hidden="true">
              <div class="summary-loading-spinner"></div>
              <div id="summaryLoadingText" class="summary-loading-text">正在生成总结...</div>
            </div>
            <article id="summary" class="summary-content"></article>
          </section>
        </div>
      </div>
    </div>
  </div>

  <!-- 历史记录模态框 -->
  <div id="historyModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <header class="modal-header">
        <div>
          <div class="modal-title">历史记录</div>
          <div class="modal-subtitle">您之前总结过的视频。</div>
        </div>
        <button id="closeHistoryBtn" class="modal-close">
          ✕ 关闭
        </button>
      </header>
      <div class="modal-body" style="overflow-y: auto;">
        <div id="historyList" class="history-grid">
           <!-- History cards inserted here -->
        </div>
        <div id="emptyHistory" style="display:none; text-align:center; padding: 40px; color: var(--text-muted); font-size: 14px;">
          暂无历史记录
        </div>
      </div>
    </div>
  </div>

  <script>
    const defaultProvider = ${JSON.stringify(env.LLM_PROVIDER || "auto")};

    // --- 认证逻辑 ---
    const authModalBackdrop = document.getElementById("authModalBackdrop");
    const authTokenInput = document.getElementById("authTokenInput");
    const authLoginBtn = document.getElementById("authLoginBtn");
    const authSpinner = document.getElementById("authSpinner");
    const authBtnText = document.getElementById("authBtnText");
    const authError = document.getElementById("authError");
    const logoutBtn = document.getElementById("logoutBtn");
    const publicBadge = document.getElementById("publicBadge");

    function updateAccessMode(authEnabled) {
      if (authEnabled) {
        publicBadge.classList.remove("show");
      } else {
        logoutBtn.classList.remove("show");
        publicBadge.classList.add("show");
      }
    }

    async function checkAuth() {
      try {
        const resp = await fetch("/api/auth-status");
        const data = await resp.json();
        const authEnabled = data.authEnabled !== false;
        updateAccessMode(authEnabled);
        if (data.authed) {
          authModalBackdrop.classList.remove("show");
          document.body.classList.remove("modal-open");
          if (authEnabled) {
            logoutBtn.classList.add("show");
          }
        } else {
          document.body.classList.add("modal-open");
          authModalBackdrop.classList.add("show");
          logoutBtn.classList.remove("show");
          publicBadge.classList.remove("show");
          authTokenInput.focus();
        }
      } catch (e) {
        document.body.classList.add("modal-open");
        authModalBackdrop.classList.add("show");
        logoutBtn.classList.remove("show");
        publicBadge.classList.remove("show");
      }
    }

    async function doLogin() {
      const token = authTokenInput.value.trim();
      if (!token) {
        authError.textContent = "请输入密码";
        return;
      }
      authError.textContent = "";
      authLoginBtn.setAttribute("disabled", "true");
      authSpinner.style.display = "inline-block";
      authBtnText.textContent = "验证中…";
      try {
        const resp = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        if (resp.ok) {
          authModalBackdrop.classList.remove("show");
          document.body.classList.remove("modal-open");
          logoutBtn.classList.add("show");
          publicBadge.classList.remove("show");
        } else {
          const data = await resp.json().catch(() => ({}));
          authError.textContent = data.error || "密码错误，请重试";
          authTokenInput.value = "";
          authTokenInput.focus();
        }
      } catch (e) {
        authError.textContent = "网络错误，请稍后重试";
      } finally {
        authLoginBtn.removeAttribute("disabled");
        authSpinner.style.display = "none";
        authBtnText.textContent = "登录";
      }
    }

    authLoginBtn.addEventListener("click", doLogin);
    authTokenInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });

    async function doLogout() {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch (e) {}
      logoutBtn.classList.remove("show");
      publicBadge.classList.remove("show");
      authError.textContent = "";
      authTokenInput.value = "";
      document.body.classList.add("modal-open");
      authModalBackdrop.classList.add("show");
      authTokenInput.focus();
    }

    logoutBtn.addEventListener("click", doLogout);

    // 页面加载时立即检查认证状态
    checkAuth();

    // --- 原有逻辑 ---
    const btn = document.getElementById("summarizeBtn");
    const input = document.getElementById("videoUrl");
    const providerSelectEl = document.getElementById("providerSelect");
    const statusEl = document.getElementById("status");
    const spinner = document.getElementById("spinner");
    const btnText = document.getElementById("btnText");
    const summaryEl = document.getElementById("summary");
    const modalBackdrop = document.getElementById("summaryModalBackdrop");
    const copyBtnEl = document.getElementById("copyBtn");
    const copyIconEl = document.getElementById("copyIcon");
    const checkIconEl = document.getElementById("checkIcon");
    const copyLabelEl = document.getElementById("copyLabel");
    const summaryLoadingEl = document.getElementById("summaryLoading");
    const summaryLoadingTextEl = document.getElementById("summaryLoadingText");
    let currentSummaryMarkdown = "";
    const closeModalBtn = document.getElementById("closeModalBtn");

    const historyBtn = document.getElementById("historyBtn");
    const historyModalBackdrop = document.getElementById("historyModalBackdrop");
    const closeHistoryBtn = document.getElementById("closeHistoryBtn");
    const historyListEl = document.getElementById("historyList");
    const emptyHistoryEl = document.getElementById("emptyHistory");

    const videoSideEl = document.querySelector(".video-side");
    const videoThumbWrapEl = document.querySelector(".video-thumb-wrap");
    const videoTitleEl = document.getElementById("videoTitle");
    const videoAuthorEl = document.getElementById("videoAuthor");
    const videoSubsEl = document.getElementById("videoSubs");
    const videoViewsEl = document.getElementById("videoViews");
    const videoPublishedAtEl = document.getElementById("videoPublishedAt");
    const videoThumbEl = document.getElementById("videoThumb");

    modalBackdrop.classList.remove("show");
    historyModalBackdrop.classList.remove("show");

    if (providerSelectEl) {
      if (defaultProvider === "openai_compatible") {
        providerSelectEl.value = "openai_compatible";
      } else if (defaultProvider === "gemini") {
        providerSelectEl.value = "gemini";
      } else {
        providerSelectEl.value = "auto";
      }
    }

    function setStatus(message, type) {
      statusEl.textContent = message || "";
      statusEl.classList.remove("has-message", "status-loading", "status-success", "status-error");
      if (!message) {
        return;
      }
      statusEl.classList.add("has-message");
      if (type === "loading") {
        statusEl.classList.add("status-loading");
      } else if (type === "success") {
        statusEl.classList.add("status-success");
      } else if (type === "error") {
        statusEl.classList.add("status-error");
      }
    }

    function setLoading(loading) {
      if (loading) {
        btn.setAttribute("disabled", "true");
        spinner.style.display = "inline-block";
        btnText.textContent = "生成中…";
        setStatus("正在生成总结，请稍候…", "loading");
      } else {
        btn.removeAttribute("disabled");
        spinner.style.display = "none";
        btnText.textContent = "生成总结";
      }
    }

    function setSummaryLoading(loading, text) {
      if (!summaryLoadingEl) return;
      if (summaryLoadingTextEl && text) {
        summaryLoadingTextEl.textContent = text;
      }
      summaryLoadingEl.classList.toggle("show", !!loading);
      summaryLoadingEl.setAttribute("aria-hidden", loading ? "false" : "true");
    }

    function renderSummaryEmptyState(text, isError) {
      const classes = isError ? "summary-empty-state is-error" : "summary-empty-state";
      if (isError) {
        summaryEl.innerHTML =
          '<div class="' + classes + '">' +
          '<div class="summary-empty-state-badge">!</div>' +
          '<div class="summary-empty-state-title">生成失败</div>' +
          '<div class="summary-empty-state-text">' + escapeHtml(text) + '</div>' +
          '</div>';
        return;
      }
      summaryEl.innerHTML =
        '<div class="' + classes + '">' +
        '<div class="summary-empty-state-text">' + escapeHtml(text) + '</div>' +
        '</div>';
    }

    function setVideoInfoLoading(loading) {
      if (!videoSideEl) return;
      videoSideEl.classList.toggle("is-loading", !!loading);
    }

    function setVideoThumbSrc(src) {
      if (!videoThumbEl || !videoThumbWrapEl) return;
      videoThumbWrapEl.classList.remove("has-image");
      if (!src) {
        videoThumbEl.removeAttribute("src");
        return;
      }
      videoThumbEl.src = src;
    }

    videoThumbEl.addEventListener("load", function () {
      videoThumbWrapEl.classList.add("has-image");
    });

    videoThumbEl.addEventListener("error", function () {
      videoThumbWrapEl.classList.remove("has-image");
      videoThumbEl.removeAttribute("src");
    });

    function openModal() {
      document.body.classList.add("modal-open");
      modalBackdrop.classList.add("show");
    }

    function closeModal() {
      document.body.classList.remove("modal-open");
      modalBackdrop.classList.remove("show");
    }

    async function openHistoryModal() {
      document.body.classList.add("modal-open");
      historyModalBackdrop.classList.add("show");
      await renderHistory();
    }

    function closeHistoryModal() {
      document.body.classList.remove("modal-open");
      historyModalBackdrop.classList.remove("show");
    }

    closeModalBtn.addEventListener("click", () => closeModal());
    closeHistoryBtn.addEventListener("click", () => closeHistoryModal());

    historyBtn.addEventListener("click", () => openHistoryModal());

    modalBackdrop.addEventListener("click", (e) => {
      if (e.target === modalBackdrop) closeModal();
    });
    historyModalBackdrop.addEventListener("click", (e) => {
      if (e.target === historyModalBackdrop) closeHistoryModal();
    });

    // --- 复制 Markdown 按钮 ---
    copyBtnEl.addEventListener("click", async () => {
      if (!currentSummaryMarkdown) return;
      try {
        await navigator.clipboard.writeText(currentSummaryMarkdown);
        copyIconEl.style.display = "none";
        checkIconEl.style.display = "inline";
        copyLabelEl.textContent = "已复制";
        copyBtnEl.classList.add("copied");
        setTimeout(() => {
          copyIconEl.style.display = "inline";
          checkIconEl.style.display = "none";
          copyLabelEl.textContent = "复制";
          copyBtnEl.classList.remove("copied");
        }, 1500);
      } catch (err) {
        console.error("复制失败", err);
        alert("复制失败，请手动选择复制");
      }
    });

    // --- 历史记录功能 ---
    async function getHistory() {
      try {
        const resp = await fetch("/api/history");
        if (resp.ok) {
          return await resp.json();
        }
      } catch (e) {
        console.error("Failed to fetch history", e);
      }
      return [];
    }
    
    async function saveHistory(infoObj) {
      try {
        await fetch("/api/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "add", payload: infoObj })
        });
      } catch (e) {
        console.error("Failed to save history", e);
      }
    }

    async function removeHistory(videoUrl) {
      try {
        const resp = await fetch("/api/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove", videoUrl })
        });
        if (resp.ok) {
          await renderHistory();
          return true;
        }
      } catch (e) {
        console.error("Failed to remove history", e);
      }
      return false;
    }

    async function renderHistory() {
      historyListEl.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-muted);"><div class="spinner" style="margin: 0 auto 10px; border-top-color: var(--primary);"></div>正在加载...</div>';
      historyListEl.style.display = "block";
      emptyHistoryEl.style.display = "none";

      const histories = await getHistory();
      historyListEl.innerHTML = "";
      
      if (histories.length === 0) {
        historyListEl.style.display = "none";
        emptyHistoryEl.style.display = "block";
        return;
      }
      
      historyListEl.style.display = "grid";
      emptyHistoryEl.style.display = "none";

      histories.forEach(item => {
        const card = document.createElement("div");
        card.className = "history-card";
        
        let thumbHtml = item.thumbnailUrl 
          ? \`<img src="\${escapeHtml(item.thumbnailUrl)}" alt="封面" />\`
          : \`<img src="https://img.youtube.com/vi/\${escapeHtml(item.videoId || '')}/hqdefault.jpg" onerror="this.src=''" alt="封面" />\`;

        // 处理标题
        const displayTitle = item.title || "(无标题)";
        
        card.innerHTML = \`
          <div class="video-thumb-wrap">
            \${thumbHtml}
          </div>
          <div class="video-meta-title" title="\${escapeHtml(displayTitle)}">\${escapeHtml(displayTitle)}</div>
          \${item.author ? \`<div class="video-meta-author">作者：\${escapeHtml(item.author)}</div>\` : ''}
          \${item.publishedAt ? \`<div class="video-meta-extra">发布时间：\${escapeHtml(item.publishedAt)}</div>\` : ''}
          <div class="card-actions">
            <button class="delete-btn">
              <span class="delete-btn-spinner" aria-hidden="true"></span>
              <span class="delete-btn-label">删除</span>
            </button>
          </div>
        \`;

        const historyImgEl = card.querySelector(".video-thumb-wrap img");
        const historyThumbWrapEl = card.querySelector(".video-thumb-wrap");
        if (historyImgEl && historyThumbWrapEl) {
          if (historyImgEl.complete && historyImgEl.naturalWidth > 0) {
            historyThumbWrapEl.classList.add("is-loaded");
          } else {
            historyImgEl.addEventListener("load", () => {
              historyThumbWrapEl.classList.add("is-loaded");
            }, { once: true });
            historyImgEl.addEventListener("error", () => {
              historyThumbWrapEl.classList.remove("is-loaded");
            }, { once: true });
          }
        }

        // 点击卡片直接填入链接并总结，点击删除按钮则删除
        card.addEventListener("click", (e) => {
          const linkValue = item.videoUrl || item.youtubeUrl;
          const deleteBtn = e.target.closest(".delete-btn");
          if (deleteBtn) {
            e.stopPropagation();
            const deleteLabelEl = deleteBtn.querySelector(".delete-btn-label");
            deleteBtn.classList.add("is-loading");
            if (deleteLabelEl) {
              deleteLabelEl.textContent = "删除中";
            }
            removeHistory(linkValue).then((removed) => {
              if (removed) {
                return;
              }
              deleteBtn.classList.remove("is-loading");
              if (deleteLabelEl) {
                deleteLabelEl.textContent = "删除";
              }
              setStatus("删除历史记录失败，请稍后重试。", "error");
            });
          } else {
            input.value = linkValue;
            closeHistoryModal();
            summarize();
          }
        });

        historyListEl.appendChild(card);
      });
    }
    // ------

    // 前端也复用一个解析函数
    function getYoutubeWatchUrl(rawUrl) {
      try {
        const u = new URL(rawUrl);
        if (u.hostname === "youtu.be") {
          const id = u.pathname.replace("/", "");
          if (!id) return null;
          return "https://www.youtube.com/watch?v=" + id;
        }
        if (u.hostname.endsWith("youtube.com")) {
          const id = u.searchParams.get("v");
          if (id) {
            return "https://www.youtube.com/watch?v=" + id;
          }
          if (u.pathname.startsWith("/shorts/")) {
            const shortId = u.pathname.split("/")[2];
            if (shortId) {
              return "https://www.youtube.com/watch?v=" + shortId;
            }
          }
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    function getVideoSourceInfo(rawUrl) {
      try {
        const u = new URL(rawUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return null;
        }

        const youtubeWatchUrl = getYoutubeWatchUrl(rawUrl);
        if (youtubeWatchUrl) {
          return {
            platform: "youtube",
            canonicalUrl: youtubeWatchUrl,
            youtubeWatchUrl,
          };
        }

        u.hash = "";
        return {
          platform: "generic",
          canonicalUrl: u.toString(),
          youtubeWatchUrl: null,
        };
      } catch (e) {
        return null;
      }
    }

    function linkifyTimestamps(text, youtubeUrl) {
      if (!text) return "";
      const base = getYoutubeWatchUrl(youtubeUrl);
      if (!base) return escapeHtml(text);

      const re = /\\[(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\]/g;

      return text.replace(re, function (_, hOrM, mOrS, sOpt) {
        var hours = 0;
        var minutes = 0;
        var seconds = 0;

        if (sOpt !== undefined) {
          hours = parseInt(hOrM, 10);
          minutes = parseInt(mOrS, 10);
          seconds = parseInt(sOpt, 10);
        } else {
          minutes = parseInt(hOrM, 10);
          seconds = parseInt(mOrS, 10);
        }

        var totalSeconds = hours * 3600 + minutes * 60 + seconds;
        var label =
          (hours ? String(hours).padStart(2, "0") + ":" : "") +
          String(minutes).padStart(2, "0") +
          ":" +
          String(seconds).padStart(2, "0");

        var href = base + "&t=" + totalSeconds + "s";
        return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">[' + label + "]</a>";
      });
    }

    function escapeHtml(str) {
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function toHtmlFromPlainWithAnchors(text, youtubeUrl) {
      if (!text) return "";

      // 如果浏览器支持 marked，则先按 markdown 渲染，再把其中的 [MM:SS] / [HH:MM:SS] 时间戳替换成可点击链接
      if (window.marked && typeof window.marked.parse === "function") {
        var html = window.marked.parse(text || "");
        var base = getYoutubeWatchUrl(youtubeUrl);
        if (!base) {
          return html;
        }

        var re = /\\[(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\]/g;

        return html.replace(re, function (_, hOrM, mOrS, sOpt) {
          var hours = 0;
          var minutes = 0;
          var seconds = 0;

          if (sOpt !== undefined) {
            hours = parseInt(hOrM, 10);
            minutes = parseInt(mOrS, 10);
            seconds = parseInt(sOpt, 10);
          } else {
            minutes = parseInt(hOrM, 10);
            seconds = parseInt(mOrS, 10);
          }

          if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) {
            return _;
          }

          var totalSeconds = hours * 3600 + minutes * 60 + seconds;
          var label =
            (hours ? String(hours).padStart(2, "0") + ":" : "") +
            String(minutes).padStart(2, "0") +
            ":" +
            String(seconds).padStart(2, "0");

          var href = base + "&t=" + totalSeconds + "s";
          return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">[' + label + "]</a>";
        });
      }

      // 不支持 marked 的情况下，保留原来的逐行处理逻辑
      var withLinks = linkifyTimestamps(text, youtubeUrl);
      var lines = withLinks.split(/\\r?\\n/);
      var blocks = [];

      for (var i = 0; i < lines.length; i++) {
        var rawLine = lines[i];
        var line = rawLine.trim();
        if (!line) {
          blocks.push("<p>&nbsp;</p>");
          continue;
        }
        if (line.indexOf("<a ") !== -1) {
          blocks.push("<p>" + line + "</p>");
        } else {
          blocks.push("<p>" + escapeHtml(line) + "</p>");
        }
      }
      return blocks.join("\\n");
    }

    async function summarize() {
      var videoUrl = input.value.trim();
      if (!videoUrl) {
        alert("请先输入视频链接");
        input.focus();
        return;
      }

      const provider = providerSelectEl ? providerSelectEl.value : "auto";
      const sourceInfo = getVideoSourceInfo(videoUrl);
      if (!sourceInfo) {
        alert("链接格式无效，请输入完整的 http(s) 视频链接");
        return;
      }

      if (provider === "gemini" && sourceInfo.platform !== "youtube") {
        alert("Gemini 目前仅支持 YouTube 链接，请切换到「自动」或「OpenAI 兼容」");
        return;
      }

      setLoading(true);
      summaryEl.innerHTML = "";
      setSummaryLoading(true, "正在生成总结...");
      setVideoInfoLoading(true);
      videoTitleEl.textContent = "";
      videoAuthorEl.textContent = "";
      videoSubsEl.textContent = "";
      videoViewsEl.textContent = "";
      videoPublishedAtEl.textContent = "";
      setVideoThumbSrc("");

      try {
        const summaryPromise = fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoUrl: sourceInfo.canonicalUrl,
            youtubeUrl: sourceInfo.canonicalUrl,
            llmProvider: providerSelectEl ? providerSelectEl.value : undefined,
          })
        });

        const infoPromise = fetch("/api/videoInfo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoUrl: sourceInfo.canonicalUrl, youtubeUrl: sourceInfo.canonicalUrl })
        })
          .then(async (resp) => {
            if (!resp.ok) return null;
            return resp.json();
          })
          .catch(() => null);

        const summaryResp = await summaryPromise;
        if (!summaryResp.ok) {
          const t = await summaryResp.text();
          throw new Error("请求失败：" + summaryResp.status + " " + t);
        }

        const summaryMode = summaryResp.headers.get("X-Summary-Mode") || "";
        const summaryProvider = summaryResp.headers.get("X-Summary-Provider") || "";
        if (summaryMode === "cache") {
          const providerText = summaryProvider === "gemini"
            ? "（Gemini）"
            : summaryProvider === "openai_compatible"
              ? "（OpenAI 兼容）"
              : "";
          console.log("[summary] 使用缓存" + providerText);
        } else if (summaryMode === "gemini") {
          console.log("[summary] 使用 Gemini 模型");
        } else if (summaryMode === "openai_compatible") {
          console.log("[summary] 使用 OpenAI 兼容模型");
        }

        const fallbackWatch = sourceInfo.youtubeWatchUrl;

        const infoTask = infoPromise.then((info) => {
          if (info) {
            const title = info.title || "(无标题)";
            const author = info.author || "";
            const publishedAt = info.publishedAt || "";
            const thumb = info.thumbnailUrl || "";
            const watchUrl = info.watchUrl || fallbackWatch;
            const channelUrl = info.channelUrl || "";
            const subs = info.subscriberText || "";
            const views = info.viewCountText || "";

            if (watchUrl) {
              videoTitleEl.innerHTML =
                '<a href="' + watchUrl + '" target="_blank" rel="noopener noreferrer">' +
                escapeHtml(title) +
                "</a>";
            } else {
              videoTitleEl.textContent = title;
            }

            if (author) {
              if (channelUrl) {
                videoAuthorEl.innerHTML =
                  '作者：<a href="' + channelUrl + '" target="_blank" rel="noopener noreferrer">' +
                  escapeHtml(author) +
                  "</a>";
              } else {
                videoAuthorEl.textContent = "作者：" + author;
              }
            } else {
              videoAuthorEl.textContent = "";
            }

            videoSubsEl.textContent = subs ? "订阅数：" + subs : "";
            videoViewsEl.textContent = views ? "播放次数：" + views : "";
            videoPublishedAtEl.textContent = publishedAt ? "发布时间：" + publishedAt : "";

            if (thumb) {
              setVideoThumbSrc(thumb);
            } else if (fallbackWatch) {
              try {
                const u = new URL(fallbackWatch);
                const vid = u.searchParams.get("v");
                if (vid) {
                  setVideoThumbSrc("https://img.youtube.com/vi/" + vid + "/hqdefault.jpg");
                }
              } catch (e) {}
            }
            setVideoInfoLoading(false);
            return info;
          }

          if (fallbackWatch) {
            try {
              const u = new URL(fallbackWatch);
              const vid = u.searchParams.get("v");
              if (vid) {
                setVideoThumbSrc("https://img.youtube.com/vi/" + vid + "/hqdefault.jpg");
              }
            } catch (e) {}
          }
          setVideoInfoLoading(false);
          return null;
        });

        openModal();

        const reader = summaryResp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let raw = "";
        let hasRenderedChunk = false;
        currentSummaryMarkdown = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkText = decoder.decode(value, { stream: true });
          if (!chunkText) {
            continue;
          }
          raw += chunkText;
          if (!hasRenderedChunk && raw.trim()) {
            hasRenderedChunk = true;
            setSummaryLoading(false);
          }
          summaryEl.innerHTML = toHtmlFromPlainWithAnchors(raw, sourceInfo.canonicalUrl);
        }

        raw += decoder.decode();

        const info = await infoTask;

        if (!raw.trim()) {
          setStatus("AI 没有返回内容，请稍后重试。", "error");
          setSummaryLoading(false);
          renderSummaryEmptyState("总结内容暂时为空，请稍后重试。", false);
          setLoading(false);
          return;
        }

        setSummaryLoading(false);
        summaryEl.innerHTML = toHtmlFromPlainWithAnchors(raw, sourceInfo.canonicalUrl);
        currentSummaryMarkdown = raw;
        setStatus("生成完成。", "success");

        // 完成时记录到历史中
        if (info) {
          await saveHistory({
            videoUrl: sourceInfo.canonicalUrl,
            youtubeUrl: sourceInfo.canonicalUrl,
            videoId: new URL(fallbackWatch || sourceInfo.canonicalUrl).searchParams.get("v") || "",
            title: info.title || "",
            author: info.author || "",
            thumbnailUrl: info.thumbnailUrl || "",
            publishedAt: info.publishedAt || ""
          });
        } else {
          // 如果 info 请求失败，还是存个基本的
          let tempVid = "";
          try {
            const u = new URL(fallbackWatch || sourceInfo.canonicalUrl);
            tempVid = u.searchParams.get("v") || u.pathname.replace("/", "");
          } catch(e){}
          await saveHistory({
            videoUrl: sourceInfo.canonicalUrl,
            youtubeUrl: sourceInfo.canonicalUrl,
            videoId: tempVid,
            title: sourceInfo.canonicalUrl,
            author: "",
            thumbnailUrl: "",
            publishedAt: ""
          });
        }

      } catch (err) {
        console.error(err);
        setSummaryLoading(false);
        setVideoInfoLoading(false);
        const errorMessage = err.message || ("调用出错：" + err);
        renderSummaryEmptyState(errorMessage, true);
        setStatus(errorMessage, "error");
      } finally {
        setLoading(false);
      }
    }

    btn.addEventListener("click", function () {
      summarize();
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        summarize();
      }
    });
  </script>
</body>
</html>`,
        { headers: { "Content-Type": "text/html; charset=UTF-8" } },
      );
    }

    // ===== 2. 视频信息接口：标题 / 作者 / 发布时间 / 封面 / 频道信息 / 播放次数 =====
    if (request.method === "POST" && url.pathname === "/api/videoInfo") {
      try {
        const body = await request.json();
        const videoUrl = body.videoUrl || body.youtubeUrl;

        if (!videoUrl || typeof videoUrl !== "string") {
          return new Response("缺少 videoUrl", { status: 400 });
        }

        const info = getVideoSourceInfo(videoUrl);
        if (!info) {
          return new Response("无法解析视频链接", { status: 400 });
        }

        const { platform, canonicalUrl, videoId } = info;

        if (platform !== "youtube") {
          function safeDecode(v) {
            try {
              return decodeURIComponent(v);
            } catch (e) {
              return v;
            }
          }

          function formatUnixDate(sec) {
            if (!sec || !Number.isFinite(sec)) return "";
            const d = new Date(sec * 1000);
            if (Number.isNaN(d.getTime())) return "";
            return d.toISOString().slice(0, 10);
          }

          function normalizeImgUrl(urlLike) {
            if (!urlLike || typeof urlLike !== "string") return "";
            if (urlLike.startsWith("//")) return "https:" + urlLike;
            if (urlLike.startsWith("http://")) return "https://" + urlLike.slice("http://".length);
            return urlLike;
          }

          const fallbackTitle = (() => {
            try {
              const u = new URL(canonicalUrl);
              return safeDecode((u.hostname + u.pathname).replace(/\/$/, "")) || canonicalUrl;
            } catch (e) {
              return canonicalUrl;
            }
          })();

          let title = fallbackTitle;
          let author = "";
          let publishedAt = "";
          let thumbnailUrl = "";
          let channelUrl = "";
          let subscriberText = "";
          let viewCountText = "";

          if (platform === "bilibili") {
            try {
              const u = new URL(canonicalUrl);
              let bvid = "";
              let aid = "";

              const bvidFromPath = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
              const aidFromPath = u.pathname.match(/\/video\/av(\d+)/i);
              if (bvidFromPath && bvidFromPath[1]) bvid = bvidFromPath[1];
              if (aidFromPath && aidFromPath[1]) aid = aidFromPath[1];
              if (!bvid) bvid = u.searchParams.get("bvid") || "";
              if (!aid) aid = u.searchParams.get("aid") || "";

              if (bvid || aid) {
                const apiUrl = "https://api.bilibili.com/x/web-interface/view?" +
                  (bvid ? ("bvid=" + encodeURIComponent(bvid)) : ("aid=" + encodeURIComponent(aid)));
                const apiResp = await fetch(apiUrl, {
                  headers: {
                    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "user-agent": "Mozilla/5.0",
                  },
                });
                if (apiResp.ok) {
                  const apiData = await apiResp.json();
                  const data = apiData && apiData.data ? apiData.data : null;
                  if (data) {
                    title = data.title || title;
                    thumbnailUrl = normalizeImgUrl(data.pic || "");
                    publishedAt = formatUnixDate(typeof data.pubdate === "number" ? data.pubdate : 0) || publishedAt;
                    if (data.owner && data.owner.name) {
                      author = data.owner.name;
                    }
                    if (data.owner && data.owner.mid) {
                      channelUrl = "https://space.bilibili.com/" + data.owner.mid;
                    }
                    if (data.stat && typeof data.stat.view === "number") {
                      viewCountText = String(data.stat.view);
                    }
                  }
                }
              }

              if (!title || !thumbnailUrl || !author || !publishedAt) {
                const pageResp = await fetch(canonicalUrl, {
                  headers: {
                    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "user-agent": "Mozilla/5.0",
                  },
                });
                if (pageResp.ok) {
                  const html = await pageResp.text();
                  if (!title || title === fallbackTitle) {
                    const m = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
                    if (m && m[1]) title = m[1];
                  }
                  if (!thumbnailUrl) {
                    const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
                    if (m && m[1]) thumbnailUrl = normalizeImgUrl(m[1]);
                  }
                  if (!author) {
                    const m = html.match(/<meta\s+name="author"\s+content="([^"]+)"/i);
                    if (m && m[1]) author = m[1];
                  }
                  if (!publishedAt) {
                    const m = html.match(/"pubdate"\s*:\s*(\d{9,11})/);
                    if (m && m[1]) {
                      const sec = parseInt(m[1], 10);
                      publishedAt = formatUnixDate(sec);
                    }
                  }
                }
              }
            } catch (e) {
            }
          }

          return new Response(JSON.stringify({
            title,
            author,
            publishedAt,
            thumbnailUrl: thumbnailUrl ? buildImageProxyUrl(thumbnailUrl) : "",
            watchUrl: canonicalUrl,
            channelUrl,
            subscriberText,
            viewCountText,
          }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const watchUrl = canonicalUrl;

        let title = "";
        let author = "";
        let thumbnailUrl = videoId
          ? "https://img.youtube.com/vi/" + videoId + "/hqdefault.jpg"
          : "";
        let publishedAt = "";
        let channelId = "";
        let channelUrl = "";
        let subscriberText = "";
        let viewCountText = "";

        // 1) oEmbed 拿标题 / 作者 / 缩略图
        try {
          const oembedResp = await fetch(
            "https://www.youtube.com/oembed?url=" +
            encodeURIComponent(watchUrl) +
            "&format=json",
          );
          if (oembedResp.ok) {
            const oembed = await oembedResp.json();
            title = oembed.title || title;
            author = oembed.author_name || author;
            if (oembed.thumbnail_url) {
              thumbnailUrl = oembed.thumbnail_url;
            }
          }
        } catch (e) {
          // 忽略错误，使用兜底信息
        }

        // 2) 抓网页 html，解析 publishDate / channelId / 订阅数 / 播放次数
        try {
          const pageResp = await fetch(watchUrl, {
            headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
          });
          if (pageResp.ok) {
            const html = await pageResp.text();

            // 发布日期：优先匹配 publishDate.simpleText
            let pubMatch =
              html.match(
                /"publishDate"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/,
              );
            if (pubMatch && pubMatch[1]) {
              publishedAt = pubMatch[1];
            }
            if (!publishedAt) {
              // 兜底：原先的几种写法
              const m =
                html.match(/"publishDate":"(.*?)"/) ||
                html.match(/"uploadDate":"(.*?)"/) ||
                html.match(
                  /<meta\s+itemprop="datePublished"\s+content="([^"]*)"/i,
                );
              if (m && m[1]) {
                publishedAt = m[1];
              }
            }

            // channelId
            const cidMatch = html.match(/"channelId":"(UC[0-9A-Za-z_-]+)"/);
            if (cidMatch && cidMatch[1]) {
              channelId = cidMatch[1];
              channelUrl = "https://www.youtube.com/channel/" + channelId;
            }

            // 订阅数 subscriberCountText.simpleText
            const subMatch = html.match(
              /"subscriberCountText"\s*:\s*\{\s*"accessibility"[\s\S]*?"simpleText"\s*:\s*"([^"]+)"/,
            );
            if (subMatch && subMatch[1]) {
              subscriberText = subMatch[1];
            }

            // 播放次数 viewCount.videoViewCountRenderer.viewCount.simpleText
            const viewMatch = html.match(
              /"viewCount"\s*:\s*\{\s*"videoViewCountRenderer"\s*:\s*\{\s*"viewCount"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/,
            );
            if (viewMatch && viewMatch[1]) {
              viewCountText = viewMatch[1];
            }
          }
        } catch (e) {
          // 忽略错误
        }

        const result = {
          title,
          author,
          publishedAt,
          thumbnailUrl,
          watchUrl,
          channelUrl,
          subscriberText,
          viewCountText,
        };

        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response("解析请求体失败", { status: 400 });
      }
    }

    // ===== 3. 总结接口 =====
    if (request.method === "POST" && url.pathname === "/api/summarize") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("请求体解析失败", { status: 400 });
      }
      const videoUrl = body.videoUrl || body.youtubeUrl;
      const requestedProvider = body.llmProvider;

      if (!videoUrl || typeof videoUrl !== "string") {
        return new Response("缺少 videoUrl", { status: 400 });
      }

      if (requestedProvider !== undefined && typeof requestedProvider !== "string") {
        return new Response("llmProvider 类型错误", { status: 400 });
      }

      const providerMode = (requestedProvider || env.LLM_PROVIDER || "auto").toLowerCase();
      let provider = providerMode;
      if (provider !== "gemini" && provider !== "openai_compatible" && provider !== "auto") {
        return new Response("不支持的 llmProvider", { status: 400 });
      }

      const sourceInfo = getVideoSourceInfo(videoUrl);
      if (!sourceInfo) {
        return new Response("无法解析视频链接", { status: 400 });
      }

      function getMissingGeminiFields() {
        const missingFields = [];
        if (!env.GEMINI_API_KEY) missingFields.push("GEMINI_API_KEY");
        if (!env.GEMINI_MODEL) missingFields.push("GEMINI_MODEL");
        return missingFields;
      }

      function getMissingOpenAIFields() {
        const missingFields = [];
        if (!env.OPENAI_BASE_URL) missingFields.push("OPENAI_BASE_URL");
        if (!env.OPENAI_API_KEY) missingFields.push("OPENAI_API_KEY");
        if (!env.OPENAI_MODEL) missingFields.push("OPENAI_MODEL");
        return missingFields;
      }

      const missingGeminiFields = getMissingGeminiFields();
      const missingOpenAIFields = getMissingOpenAIFields();
      const geminiConfigured = missingGeminiFields.length === 0;
      const openaiConfigured = missingOpenAIFields.length === 0;

      // auto 模式：YouTube 优先走 Gemini；若 Gemini 配置不完整且 OpenAI 配置完整，则自动降级到 OpenAI 兼容
      if (provider === "auto") {
        if (sourceInfo.platform === "youtube") {
          provider = geminiConfigured ? "gemini" : (openaiConfigured ? "openai_compatible" : "gemini");
        } else {
          provider = "openai_compatible";
        }
      }

      if (provider === "gemini" && sourceInfo.platform !== "youtube") {
        return new Response("Gemini 仅支持 YouTube 链接，请切换到「自动」或「OpenAI 兼容」", { status: 400 });
      }

      if (provider === "gemini" && !geminiConfigured) {
        if (providerMode === "auto" && sourceInfo.platform === "youtube" && openaiConfigured) {
          provider = "openai_compatible";
        } else {
          return new Response("Gemini 模式配置缺失: " + missingGeminiFields.join(", "), { status: 500 });
        }
      }

      if (provider === "openai_compatible" && !openaiConfigured) {
        return new Response("OpenAI 兼容模式配置缺失: " + missingOpenAIFields.join(", "), { status: 500 });
      }

      const SUMMARY_CACHE_VERSION = "v4";
      let cacheKey = "";
      if (sourceInfo.platform === "youtube" && sourceInfo.videoId) {
        cacheKey = "summary:" + SUMMARY_CACHE_VERSION + ":" + provider + ":youtube:" + sourceInfo.videoId;
      } else {
        const urlHash = await sha256Hex(sourceInfo.canonicalUrl);
        cacheKey = "summary:" + SUMMARY_CACHE_VERSION + ":" + provider + ":generic:" + urlHash;
      }

      // 查询 KV 缓存，命中则直接返回
      const summaryCache = env.SUMMARY_CACHE;
      const cachedSummary = summaryCache ? await summaryCache.get(cacheKey) : null;
      if (cachedSummary) {
        console.log("[summarize] using cache", {
          provider,
          cacheKey,
          videoUrl: sourceInfo.canonicalUrl,
        });
        return new Response(cachedSummary, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Summary-Mode": "cache",
            "X-Summary-Provider": provider,
          },
        });
      }

      function collectStreamTextsFromEventData(eventData, provider) {
        if (!eventData || eventData.trim() === "[DONE]") {
          return [];
        }

        let parsed;
        try {
          parsed = JSON.parse(eventData);
        } catch (e) {
          return [];
        }

        const texts = [];
        if (provider === "gemini") {
          const dataArray = Array.isArray(parsed) ? parsed : [parsed];
          for (const data of dataArray) {
            const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
            if (!parts || !Array.isArray(parts)) continue;
            for (const part of parts) {
              if (part && typeof part.text === "string" && part.text) {
                texts.push(part.text);
              }
            }
          }
          return texts;
        }

        const choices = parsed && Array.isArray(parsed.choices) ? parsed.choices : [];
        for (const choice of choices) {
          if (choice && choice.delta && typeof choice.delta.content === "string" && choice.delta.content) {
            texts.push(choice.delta.content);
          } else if (choice && choice.message && typeof choice.message.content === "string" && choice.message.content) {
            texts.push(choice.message.content);
          } else if (choice && typeof choice.text === "string" && choice.text) {
            texts.push(choice.text);
          }
        }

        return texts;
      }

      function stripMetaLeakText(text) {
        if (!text || typeof text !== "string") return "";
        let cleaned = text;

        cleaned = cleaned.replace(
          /<system-reminder>\s*Your operational mode has changed from plan to build\.\s*You are no longer in read-only mode\.\s*You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed\.\s*<\/system-reminder>/gi,
          "",
        );

        cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
        return cleaned;
      }

      function trimChunkByTailOverlap(tailText, incomingText) {
        if (!incomingText) return "";
        if (!tailText) return incomingText;

        // 最小重叠长度阈值：短于此值的"重叠"视为巧合，不做裁剪。
        // 中文单字（2-3 bytes）和常见短词极易在历史尾部中偶然命中，
        // 设定阈值可避免误删正常内容。
        const MIN_OVERLAP = 12;

        if (incomingText.length >= MIN_OVERLAP && tailText.includes(incomingText)) {
          return "";
        }

        const maxLen = Math.min(tailText.length, incomingText.length);
        for (let i = maxLen; i >= MIN_OVERLAP; i--) {
          if (tailText.endsWith(incomingText.slice(0, i))) {
            return incomingText.slice(i);
          }
        }
        return incomingText;
      }

      function normalizeFinalSummaryText(text) {
        if (!text || typeof text !== "string") return "";

        const cleaned = stripMetaLeakText(text).replace(/\r\n/g, "\n").trim();
        if (!cleaned) return "";

        const sectionStartRe = /^##\s+\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)?$/;
        const lines = cleaned.split("\n");
        const sections = [];
        let current = null;

        function toSeconds(ts) {
          const parts = ts.split(":").map((v) => parseInt(v, 10));
          if (parts.length === 2) {
            return parts[0] * 60 + parts[1];
          }
          if (parts.length === 3) {
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
          }
          return Number.POSITIVE_INFINITY;
        }

        function normalizeText(s) {
          return (s || "")
            .replace(/\s+/g, " ")
            .replace(/[。！，、,.!?:：；;“”"'‘’（）()\[\]【】]/g, "")
            .trim()
            .toLowerCase();
        }

        function flushCurrent() {
          if (!current) return;
          current.body = current.bodyLines.join("\n").trim();
          current.bodyNorm = normalizeText(current.body);
          sections.push(current);
          current = null;
        }

        for (const line of lines) {
          const m = line.match(sectionStartRe);
          if (m) {
            flushCurrent();
            current = {
              heading: line.trim(),
              timestamp: m[1],
              title: (m[2] || "").trim(),
              bodyLines: [],
            };
          } else if (current) {
            current.bodyLines.push(line);
          }
        }
        flushCurrent();

        if (sections.length === 0) {
          return cleaned;
        }

        const seen = new Set();
        const deduped = [];
        for (const section of sections) {
          const key = section.timestamp + "|" + normalizeText(section.title || "") + "|" + (section.bodyNorm || "");
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(section);
        }

        deduped.sort((a, b) => toSeconds(a.timestamp) - toSeconds(b.timestamp));

        const rebuilt = deduped
          .map((section) => {
            if (section.body) {
              return section.heading + "\n" + section.body;
            }
            return section.heading;
          })
          .join("\n\n")
          .trim();

        return rebuilt || cleaned;
      }

      // --- 缓存未命中，调用上游 LLM 生成总结 (Streaming) ---
      

      // --- Gemini 专用 Prompt ---
      const geminiPrompt = `# Role: YouTube 视频结构化总结专家
      
      ## Profile
      - language: 简体中文
      - description: 能够高效准确地总结 YouTube 视频内容，并以结构化的方式呈现，方便用户快速了解视频要点。
      - background: 接受过专业的视频内容分析和总结训练，熟悉 YouTube 平台特点，了解用户对视频总结的需求。
      - personality: 注重细节、逻辑严谨、表达清晰。
      - expertise: 视频内容分析、结构化总结、时间戳标注、信息提取、语言表达。
      - target_audience: 需要快速了解 YouTube 视频内容的个人或群体，包括学生、研究者、媒体从业者等。
      
      ## Skills
      
      1. 视频内容分析
         - 主题识别: 能够迅速准确地识别视频的主要主题和核心内容。
         - 信息提取: 能够从视频中提取关键信息、数据和观点。
         - 逻辑关系分析: 能够分析视频内容的逻辑结构和各个部分之间的关系。
         - 时间戳对齐: 能够准确地将总结内容与视频中的时间戳对应。
      
      2. 结构化总结
         - 章节划分: 根据视频内容，合理划分章节，方便用户定位感兴趣的部分。
         - 概要撰写: 用简洁明了的语言概括每个章节的主要内容。
         - 重点提炼: 突出视频中的重点信息和关键论点。
         - 格式化输出: 按照预定的格式，将总结内容输出。
      
      3. 语言表达
         - 简体中文写作: 熟练使用简体中文，表达清晰流畅。
         - 术语理解: 能够理解和准确运用视频中出现的专业术语。
         - 摘要撰写: 能够撰写简洁准确的摘要，概括视频的核心内容。
      
      4. YouTube 平台知识
         - 内容特点: 了解 YouTube 视频的内容特点和创作风格。
         - 用户需求: 了解用户对 YouTube 视频总结的需求和期望。
         - 平台规则: 了解 YouTube 平台的内容规范和使用规则。
      
      ## Rules
      
      1. 基本原则：
         - 准确性: 总结内容必须准确反映视频的实际内容，避免出现错误或偏差。
         - 客观性: 总结内容应尽量保持客观中立，不加入个人主观评价。
         - 简洁性: 使用简洁明了的语言，避免冗长复杂的句子。
         - 结构性: 总结内容应具有清晰的结构，方便用户快速理解和查阅。
      
      2. 时间戳规则：
         - 时间戳格式: 使用 [MM:SS] 或 [HH:MM:SS] 的格式表示视频中的时间位置。
         - 时间戳位置: 将时间戳放在每个章节标题中。
         - 时间戳对应: 时间戳应与视频中的实际内容对应，避免偏差过大。
      
      3. 内容范围：
         - 覆盖范围: 总结应覆盖视频的主要内容，包括引言、主体和结尾部分。
         - 重点内容: 对视频中的重点内容、关键论点和重要结论进行重点总结。
         - 次要内容: 次要或重复内容可适当简化或省略。
         - 非关键信息: 对于与视频主题无关或不重要的信息，可不在总结中体现。
      
      4. 语言风格：
         - 明确性: 使用明确、具体的语言，避免模糊和抽象的表达。
         - 正式性: 语言风格应偏正式，适合用于学习和工作场景。
         - 友好性: 在保证专业性的前提下，保持一定的亲和力。
      
      5. 输出结构：
         - 总体结构: 按照章节划分，总结视频的主要内容。
         - 章节结构: 每个章节包含时间戳、章节标题和内容概要。
         - 内容层次: 根据内容的重要性和逻辑关系，合理安排章节顺序和层次。
      
      ## Workflows
      
      1. 接收输入：
         - 输入内容: YouTube 视频链接。
         - 输入格式: 标准的 YouTube 链接，例如 https://www.youtube.com/watch?v=xxxxxx。
      
      2. 视频分析：
         - 主题识别: 根据视频标题、简介和内容，识别视频的主要主题。
         - 结构分析: 分析视频的结构，包括引言、主体和结尾部分。
         - 关键信息提取: 提取视频中的关键信息、数据和观点。
         - 时间戳标注: 根据视频播放进度，标注关键内容对应的时间戳。
      
      3. 总结生成：
         - 章节划分: 根据视频内容，合理划分章节。
         - 内容撰写: 为每个章节撰写简洁明了的内容概要。
         - 重点突出: 使用适当的方式突出视频中的重点信息。
         - 结构组织: 按照预定的结构组织总结内容。
      
      4. 输出优化：
         - 语言润色: 对总结内容进行语言润色，确保表达清晰流畅。
         - 结构优化: 根据需要对章节顺序和内容进行调整，优化整体结构。
         - 格式检查: 检查总结内容的格式是否符合预定的规范。
      
      5. 最终输出：
         - 输出内容: 带有时间戳的结构化总结。
         - 输出语言: 简体中文。
         - 输出格式: markdown，总体结构仍然按章节编号展示。
      
      OutputFormat
      
      1. 输出格式类型：
         - format: markdown
         - structure: 章节式结构，每个章节包含时间戳和内容概要。
         - style: 简洁明了，重点突出。
         - special_requirements: 时间戳格式为 \`[MM:SS]\`，章节标题使用二级标题，内容概要使用无序列表。
      
      2. 格式规范：
         - indentation: 使用标准的 markdown 缩进。
         - sections: 使用二级标题 \`##\` 分割章节。
         - highlighting: 使用粗体 \`**\` 突出重点信息。
      
      3. 验证规则：
         - validation: 确保每个章节都有时间戳和内容概要。
         - constraints: 时间戳必须按照 \`[MM:SS]\` 格式，且时间顺序递增。
      
      4. 示例输出结构（仅用于理解格式，不要照搬内容）：
         1. [00:00] 视频介绍
            - 说明本期视频的主题和目标。
            - 简要介绍主讲人或频道定位。
      
         2. [01:30] 核心概念讲解
            - 解释本期的核心概念或方法论。
            - 给出 1–2 个简单例子帮助理解。
      
         3. [05:10] 实战示例与应用
            - 演示如何在实际场景中使用前面讲到的方法。
            - 提醒观众在实践中容易出现的误区。
      
         4. [08:45] 总结与展望
            - 总结视频的主要内容和结论。
            - 对未来的应用或发展方向进行简要展望。
      
         5. [参考链接]
            - [项目官网](https://example.com)
            - [推荐工具](https://tools.example.com)
      
      ## Initialization
      作为YouTube 视频结构化总结专家，你必须遵守上述Rules，按照Workflows执行任务，并按照markdown格式输出。特别是，如果视频中提到了任何相关的链接（如项目地址、工具网站、参考资料等），请务必在总结的最后单独新增一个"参考链接"章节，将其以Markdown链接列表的形式展示出来。如果视频中未提及任何明确的链接，则无需生成此章节。`;

      // --- OpenAI 兼容专用 Prompt（极简，避免模型产生过多推理/草稿） ---
      const openaiPrompt = "请用简体中文总结这个视频的内容。要求分章节，每个章节用 ## [MM:SS] 章节标题 的格式，内容用无序列表。如果视频中提到了参考链接，在最后单独列出。只输出最终的 markdown 正文，不要输出任何思考过程或元信息。";

      let upstreamResp;

      if (provider === "openai_compatible") {
        const endpoint = env.OPENAI_BASE_URL.replace(/\/$/, "") + "/chat/completions";
        const payload = {
          model: env.OPENAI_MODEL,
          stream: true,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: openaiPrompt,
            },
            {
              role: "user",
              content: "请总结这个视频，链接：" + sourceInfo.canonicalUrl,
            },
          ],
        };

        upstreamResp = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + env.OPENAI_API_KEY,
          },
          body: JSON.stringify(payload),
        });
      } else {
        if (!geminiConfigured) {
          return new Response(
            "Gemini 模式配置缺失: " + missingGeminiFields.join(", "),
            { status: 500 },
          );
        }

        const geminiBaseUrl = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/models";

        const endpoint =
          geminiBaseUrl.replace(/\\\/$/, "") +
          "/" +
          encodeURIComponent(env.GEMINI_MODEL) +
          ":streamGenerateContent?alt=sse&key=" +
          encodeURIComponent(env.GEMINI_API_KEY);

        const payload = {
          contents: [
            {
              role: "user",
              parts: [
                {
                  file_data: {
                    mime_type: "video/youtube",
                    file_uri: sourceInfo.canonicalUrl,
                  },
                },
                {
                  text: geminiPrompt,
                },
              ],
            },
          ],
        };

        upstreamResp = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      if (!upstreamResp.ok) {
        let errorText = await upstreamResp.text();

        // 捕获 Gemini 抛出的 1M Token 超出限制错误（通常发生在超长视频）
        if (provider === "gemini" && errorText.includes("1048576")) {
          return new Response(
            "该视频时长过长（通常超过1小时），超出了AI模型(Gemini)的处理上限，总结失败。",
            { status: 400 },
          );
        }

        return new Response(
          "上游模型调用失败(" + provider + "): " + upstreamResp.status + " " + errorText,
          { status: 500 },
        );
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      ctx.waitUntil((async () => {
        const reader = upstreamResp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let fullText = "";
        let eventData = "";
        let openaiHasStarted = provider !== "openai_compatible";
        let openaiPending = "";
        let openaiLineBuffer = "";
        let openaiChunkTail = "";
        let openaiInThink = false;
        let openaiSkipDuplicateSection = false;
        let openaiSummaryRestarted = false;
        const openaiSeenHeadings = new Set();
        const openaiSeenTimestamps = new Set();
        let openaiLastTimestampSec = -1;

        function shouldDropMetaLine(line) {
          const trimmed = line.trim();
          if (!trimmed) return false;
          // 剥离列表前缀（- 或 * ），使后续正则能匹配到列表项中的元文本
          const stripped = trimmed.replace(/^[-*]\s+/, "");
          return (
            /^\[Agent\s*\d+\]/i.test(trimmed) ||
            /^browse_page\s*\{/i.test(trimmed) ||
            /^\s*-\s*正在/.test(trimmed) ||
            /^This covers the clip accurately\./i.test(trimmed) ||
            /^Ready for output\./i.test(trimmed) ||
            /^Your operational mode has changed/i.test(trimmed) ||
            /^You are no longer in read-only mode\./i.test(trimmed) ||
            /^You are permitted to make file changes/i.test(trimmed) ||
            // Grok / 通用模型的规划、推理、元注释泄漏（同时检查原文和去除列表前缀后的文本）
            /^Planning\s/i.test(stripped) ||
            /^Crafting\s/i.test(stripped) ||
            /^Drafting\s/i.test(stripped) ||
            /^Refining\s/i.test(stripped) ||
            /^Synthesizing\s/i.test(stripped) ||
            /^Adopting\s/i.test(stripped) ||
            /^Polishing\s/i.test(stripped) ||
            /^Analyzing\s/i.test(stripped) ||
            /^Structuring\s/i.test(stripped) ||
            /^Summarizing\s/i.test(stripped) ||
            /^Generating\s/i.test(stripped) ||
            /^Ready for (output|final)/i.test(stripped) ||
            /^This (covers|aligns|is approximate)/i.test(stripped) ||
            /^No links mentioned/i.test(stripped) ||
            /Adjust timestamps/i.test(stripped) ||
            /如果需要(添加|修改)/.test(stripped) ||
            /我认为这符合/.test(stripped) ||
            /可以直接输出/.test(stripped) ||
            /请指示/.test(stripped) ||
            /如果你(同意|批准|确认)/.test(stripped) ||
            /^I think this/i.test(stripped) ||
            /^I'll\s/i.test(stripped) ||
            /^Let me\s/i.test(stripped)
          );
        }

        async function writeOpenAILine(rawLine) {
          let line = rawLine;

          if (line.includes("<think>")) {
            openaiInThink = true;
          }
          if (line.includes("</think>")) {
            openaiInThink = false;
            return;
          }
          if (openaiInThink) {
            return;
          }

          line = line.replace(/<[^>]+>/g, "");
          if (!line.trim()) {
            return;
          }
          if (shouldDropMetaLine(line)) {
            return;
          }

          // 如果已检测到总结重启（模型输出了第二版草稿），直接丢弃后续所有内容
          if (openaiSummaryRestarted) {
            return;
          }

          const headingMatch = line.match(/^##\s+(.+)$/);
          if (headingMatch && headingMatch[1]) {
            const headingKey = headingMatch[1].trim().replace(/\s+/g, " ");

            // 提取时间戳 [MM:SS] 或 [HH:MM:SS]
            const tsMatch = headingKey.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
            if (tsMatch && tsMatch[1]) {
              const tsParts = tsMatch[1].split(":").map((v) => parseInt(v, 10));
              let tsSec = 0;
              if (tsParts.length === 2) {
                tsSec = tsParts[0] * 60 + tsParts[1];
              } else if (tsParts.length === 3) {
                tsSec = tsParts[0] * 3600 + tsParts[1] * 60 + tsParts[2];
              }

              // 检测"总结重启"：新时间戳大幅回退（比上一个时间戳早 30 秒以上）
              // 且已经输出过至少 2 个 section，说明模型开始输出新一版草稿
              if (openaiSeenTimestamps.size >= 2 && openaiLastTimestampSec > 30 && tsSec < openaiLastTimestampSec - 30) {
                openaiSummaryRestarted = true;
                return;
              }

              // 同一时间戳已出现过，跳过该 section
              if (openaiSeenTimestamps.has(tsMatch[1])) {
                openaiSkipDuplicateSection = true;
                return;
              }

              openaiSeenTimestamps.add(tsMatch[1]);
              openaiLastTimestampSec = tsSec;
            }

            if (openaiSeenHeadings.has(headingKey)) {
              openaiSkipDuplicateSection = true;
              return;
            }
            openaiSeenHeadings.add(headingKey);
            openaiSkipDuplicateSection = false;
          }

          if (openaiSkipDuplicateSection) {
            return;
          }

          fullText += line + "\n";
          await writer.write(encoder.encode(line + "\n"));
        }

        async function writeOpenAIChunk(chunkText) {
          const dedupedChunk = trimChunkByTailOverlap(openaiChunkTail, chunkText);
          if (!dedupedChunk) {
            return;
          }
          openaiChunkTail = (openaiChunkTail + dedupedChunk).slice(-8000);

          openaiLineBuffer += dedupedChunk;
          const lines = openaiLineBuffer.split("\n");
          openaiLineBuffer = lines.pop();
          for (const line of lines) {
            await writeOpenAILine(line);
          }
        }

        async function flushEventData() {
          const chunks = collectStreamTextsFromEventData(eventData, provider);
          for (const chunk of chunks) {
            const cleanedChunk = stripMetaLeakText(chunk);
            if (!cleanedChunk) continue;

            if (provider !== "openai_compatible") {
              fullText += cleanedChunk;
              await writer.write(encoder.encode(cleanedChunk));
              continue;
            }

            if (!openaiHasStarted) {
              const pendingTail = openaiPending.slice(-8000);
              const dedupedPendingChunk = trimChunkByTailOverlap(pendingTail, cleanedChunk);
              if (!dedupedPendingChunk) {
                continue;
              }
              openaiPending += dedupedPendingChunk;
              const summaryStart = openaiPending.search(/(^|\n)(##\s+|\d+\.\s*\[\d{2}:\d{2}(?::\d{2})?\]|\[\d{2}:\d{2}(?::\d{2})?\])/m);
              if (summaryStart !== -1) {
                let out = openaiPending.slice(summaryStart);
                if (out.startsWith("\n")) out = out.slice(1);
                // 清洗截取区域中夹杂的元注释行
                if (out) {
                  out = out.split("\n").filter((l) => !shouldDropMetaLine(l)).join("\n");
                }
                if (out) {
                  await writeOpenAIChunk(out);
                }
                openaiHasStarted = true;
                openaiPending = "";
              } else if (openaiPending.length > 4000) {
                openaiPending = openaiPending.slice(-1000);
              }
            } else {
              await writeOpenAIChunk(cleanedChunk);
            }
          }
          eventData = "";
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let lines = buffer.split("\n");
            buffer = lines.pop(); // 保留最后一行未完成的

            for (let i = 0; i < lines.length; i++) {
              let line = lines[i];
              if (line.startsWith("data:")) {
                const dataLine = line.slice(5).trimStart();
                if (eventData) {
                  eventData += "\n" + dataLine;
                } else {
                  eventData = dataLine;
                }
              } else if (line.trim() === "" && eventData !== "") {
                await flushEventData();
              } else if (eventData !== "") {
                eventData += "\n" + line;
              }
            }
          }

          if (buffer.trim().startsWith("data:")) {
            const dataLine = buffer.trim().slice(5).trimStart();
            if (eventData) {
              eventData += "\n" + dataLine;
            } else {
              eventData = dataLine;
            }
          }

          if (eventData !== "") {
            await flushEventData();
          }

          if (provider === "openai_compatible" && openaiLineBuffer) {
            await writeOpenAILine(openaiLineBuffer);
            openaiLineBuffer = "";
          }

          if (!openaiHasStarted && openaiPending.trim()) {
            const fallbackText = stripMetaLeakText(openaiPending).trim();
            if (fallbackText) {
              if (provider === "openai_compatible") {
                await writeOpenAIChunk(fallbackText + "\n");
                if (openaiLineBuffer) {
                  await writeOpenAILine(openaiLineBuffer);
                  openaiLineBuffer = "";
                }
              } else {
                fullText += fallbackText;
                await writer.write(encoder.encode(fallbackText));
              }
            }
          }

          if (fullText) {
            const finalText = provider === "openai_compatible" ? normalizeFinalSummaryText(fullText) : fullText;
            let expirationTtl = undefined;
            // 默认30天，可以通过 SUMMARY_EXPIRATION_DAYS 环境变量自定义，0表示不过期
            const expDaysStr = env.SUMMARY_EXPIRATION_DAYS !== undefined ? env.SUMMARY_EXPIRATION_DAYS : "30";
            const expDays = parseInt(expDaysStr, 10);

            if (!isNaN(expDays) && expDays > 0) {
              expirationTtl = expDays * 24 * 60 * 60;
            }

            if (summaryCache) {
              if (expirationTtl !== undefined) {
                await summaryCache.put(cacheKey, finalText, { expirationTtl });
              } else {
                await summaryCache.put(cacheKey, finalText);
              }
            }
          }
        } catch (err) {
          console.error("Stream error:", err);
        } finally {
          await writer.close();
        }
      })());

      console.log("[summarize] using provider", {
        provider,
        cacheKey,
        videoUrl: sourceInfo.canonicalUrl,
      });

      return new Response(readable, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Summary-Mode": provider,
          "X-Summary-Provider": provider,
        },
      });
    }

    // ===== 4. 历史记录接口：存取全局历史记录 =====
    if (url.pathname === "/api/history") {
      const historyCache = env.SUMMARY_CACHE;
      const historyHeaders = { "Content-Type": "application/json" };

      if (request.method === "GET") {
        if (!historyCache) {
          return new Response("[]", {
            headers: historyHeaders,
          });
        }

        const histRaw = await historyCache.get("global_history");
        return new Response(histRaw || "[]", {
          headers: historyHeaders,
        });
      } else if (request.method === "POST") {
        if (!historyCache) {
          return new Response(JSON.stringify({
            success: false,
            skipped: true,
            message: "SUMMARY_CACHE 未配置，历史记录功能已降级",
          }), {
            headers: historyHeaders,
          });
        }

        try {
          const body = await request.json();
          let histRaw = await historyCache.get("global_history");
          let histories = histRaw ? JSON.parse(histRaw) : [];

          if (body.action === "add" && body.payload) {
            const payloadUrl = body.payload.videoUrl || body.payload.youtubeUrl;
            if (!payloadUrl) {
              return new Response("缺少 videoUrl", { status: 400 });
            }
            histories = histories.filter((h) => (h.videoUrl || h.youtubeUrl) !== payloadUrl);
            body.payload.videoUrl = payloadUrl;
            if (!body.payload.youtubeUrl) {
              body.payload.youtubeUrl = payloadUrl;
            }
            body.payload.timestamp = Date.now();
            histories.unshift(body.payload);
            if (histories.length > 50) histories.length = 50;
            await historyCache.put("global_history", JSON.stringify(histories));
            return new Response(JSON.stringify({ success: true }), { headers: historyHeaders });
          } else if (body.action === "remove") {
            const removeUrl = body.videoUrl || body.youtubeUrl;
            if (!removeUrl) {
              return new Response("缺少 videoUrl", { status: 400 });
            }
            histories = histories.filter((h) => (h.videoUrl || h.youtubeUrl) !== removeUrl);
            await historyCache.put("global_history", JSON.stringify(histories));

            // 同时删除该视频的摘要缓存
            const SUMMARY_CACHE_VERSION = "v4";
            const providers = ["gemini", "openai_compatible"];
            const sourceInfo = getVideoSourceInfo(removeUrl);
            if (sourceInfo) {
              const deletePromises = [];
              for (const p of providers) {
                let ck = "";
                if (sourceInfo.platform === "youtube" && sourceInfo.videoId) {
                  ck = "summary:" + SUMMARY_CACHE_VERSION + ":" + p + ":youtube:" + sourceInfo.videoId;
                } else {
                  const urlHash = await sha256Hex(sourceInfo.canonicalUrl);
                  ck = "summary:" + SUMMARY_CACHE_VERSION + ":" + p + ":generic:" + urlHash;
                }
                deletePromises.push(historyCache.delete(ck));
              }
              await Promise.all(deletePromises);
            }

            return new Response(JSON.stringify({ success: true }), { headers: historyHeaders });
          }
          return new Response("Invalid action", { status: 400 });
        } catch (e) {
          return new Response("Error updating history", { status: 500 });
        }
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
