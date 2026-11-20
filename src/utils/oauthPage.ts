import { env } from "../config/env.js";
import type { AuthorizeRequest } from "../services/oauth.service.js";

// ChatGPT 커넥터 연결 때 뜨는 로그인 화면. 프론트를 고치지 않으려고 서버가 간단한 HTML을 직접 그린다

const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const layout = (body: string) => `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Archive 로그인</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f5f6f8; font-family: system-ui, -apple-system, "Malgun Gothic", sans-serif; color: #1f2328; }
  main { width: 100%; max-width: 360px; margin: 16px; padding: 28px; background: #fff; border-radius: 12px;
         box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { font-size: 14px; color: #57606a; margin: 0 0 20px; line-height: 1.5; }
  label { display: block; font-size: 13px; margin: 12px 0 6px; }
  input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px;
         border: 1px solid #d0d7de; border-radius: 8px; font-size: 15px; }
  button { width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 8px; background: #2563eb;
         color: #fff; font-size: 15px; cursor: pointer; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 20px 0 14px; color: #8c959f; font-size: 12px; }
  .divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid #d0d7de; }
  .google { display: flex; justify-content: center; }
  .error { background: #fdecec; color: #b42318; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 8px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export function renderLoginPage(request: AuthorizeRequest, error?: string, email = "") {
    const hidden = {
        client_id: request.clientId,
        redirect_uri: request.redirectUri,
        state: request.state,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        response_type: "code",
    };
    const hiddenInputs = Object.entries(hidden)
        .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
        .join("\n");

    // 구글 로그인 버튼 (GOOGLE_CLIENT_ID가 있을 때만). 웹 로그인과 같은 클라이언트 ID라
    // Google Cloud 콘솔의 "승인된 JavaScript 원본"에 https://ai-archive.shop이 이미 있으면 따로 설정할 것이 없다.
    // 버튼이 준 ID 토큰을 숨은 폼에 담아 POST /oauth/authorize/google로 보낸다
    const google = env.GOOGLE_CLIENT_ID
        ? `
  <div class="divider">또는</div>
  <form id="google-form" method="post" action="/oauth/authorize/google">
    ${hiddenInputs}
    <input type="hidden" name="credential" id="google-credential">
  </form>
  <div class="google"><div id="google-button"></div></div>
  <script src="https://accounts.google.com/gsi/client" async onload="initGoogle()"></script>
  <script>
    function initGoogle() {
      google.accounts.id.initialize({
        client_id: ${JSON.stringify(env.GOOGLE_CLIENT_ID).replace(/</g, "\\u003c")},
        callback: function (res) {
          document.getElementById("google-credential").value = res.credential;
          document.getElementById("google-form").submit();
        },
      });
      google.accounts.id.renderButton(document.getElementById("google-button"), { theme: "outline", size: "large", width: 300, text: "signin_with" });
    }
  </script>`
        : "";

    return layout(`
  <h1>AI Archive 로그인</h1>
  <p>ChatGPT에서 공유 링크로 보낸 대화를 내 AI Archive 계정에 저장하도록 연결합니다.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/oauth/authorize">
    ${hiddenInputs}
    <label for="email">이메일</label>
    <input id="email" name="email" type="email" required autocomplete="username" value="${escapeHtml(email)}">
    <label for="password">비밀번호</label>
    <input id="password" name="password" type="password" required autocomplete="current-password">
    <button type="submit">로그인하고 연결하기</button>
  </form>${google}`);
}

export function renderErrorPage(message: string) {
    return layout(
        `<h1>연결할 수 없습니다</h1><p>${escapeHtml(message)}</p><p>ChatGPT로 돌아가 다시 시도해 주세요.</p>`,
    );
}
