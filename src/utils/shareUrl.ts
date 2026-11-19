// 입력한 문장에서 AI 대화 공유 링크를 찾는다 (2026-11-18 프론트 v1.1.9 SHARED-LINK-API 기준으로 확장)
//  - 링크만 넣어도, 문장·줄바꿈·Markdown 링크 속에 넣어도 된다
//  - 받는 주소 (https만, 아이디·비밀번호·포트가 붙은 주소는 받지 않음)
//      ChatGPT  https://chatgpt.com/share/{id}, https://chatgpt.com/s/{id}, https://chat.openai.com/share/{id}
//      Gemini   https://g.co/gemini/share/{id}, https://gemini.google.com/share/{id}, https://gemini.google.com/u/{계정번호}/share/{id}
//      Claude   https://claude.ai/share/{id}
//  - /s/ 주소의 아이디는 cx_로 시작하는 문자열이라 UUID로 제한하지 않는다. /s/를 /share/로 바꾸지 않고 쿼리도 그대로 둔다
//  - 여기서는 주소 형태만 본다. 실제로 열리는지, 리디렉션 뒤 최종 주소가 공유 페이지인지는 수집 단계(collector/collect.py)가 확인한다
//  - 같은 링크(끝 슬래시·#·대소문자 정도만 다름)는 하나로 합친다
// collector/providers.py의 SHARE_ROUTES와 같은 규칙. 한쪽을 고치면 같이 고친다
export type ShareProvider = "CHATGPT" | "GEMINI" | "CLAUDE";

export type ShareLink = {
    provider: ShareProvider;
    url: string; // 수집에 넘길 주소 (원래 경로·필요한 쿼리 보존, # 제거, 끝 슬래시 제거)
    shareId: string; // 입력한 주소의 공유 아이디 (단축 주소는 최종 주소의 아이디와 다를 수 있음)
};

const ID = "([A-Za-z0-9_-]{1,200})";

type Route = {
    provider: ShareProvider;
    hosts: string[];
    path: RegExp;
    keepQuery: boolean; // false면 쿼리를 버린다
    normalize?: (url: URL, id: string) => void;
};

const ROUTES: Route[] = [
    // 기존 /share/는 UUID라 소문자로 통일하고 쿼리를 버린다 (수집 모듈 shared_importer.py가 쿼리 붙은 주소를 거절함)
    // chat.openai.com은 chatgpt.com의 예전 도메인이다. 수집 단계에서 chatgpt.com으로 열고 최종 주소로 중복을 본다
    {
        provider: "CHATGPT",
        hosts: ["chatgpt.com", "chat.openai.com"],
        path: new RegExp(`^/share/${ID}$`),
        keepQuery: false,
        normalize: (url, id) => {
            if (/^[0-9a-f-]{36}$/i.test(id)) url.pathname = `/share/${id.toLowerCase()}`;
        },
    },
    { provider: "CHATGPT", hosts: ["chatgpt.com"], path: new RegExp(`^/s/${ID}$`), keepQuery: true },
    {
        provider: "GEMINI",
        hosts: ["gemini.google.com"],
        path: new RegExp(`^/(?:u/\\d{1,3}/)?share/${ID}$`),
        keepQuery: true,
    },
    { provider: "GEMINI", hosts: ["g.co"], path: new RegExp(`^/gemini/share/${ID}$`), keepQuery: true },
    { provider: "CLAUDE", hosts: ["claude.ai"], path: new RegExp(`^/share/${ID}$`), keepQuery: true },
];

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`()[\]{}]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:，。！？、]+$/;

// 주소 하나가 지원하는 공유 링크인지 본다. 아니면 null
export function parseShareLink(value: string): ShareLink | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, "");

    for (const route of ROUTES) {
        if (!route.hosts.includes(host)) continue;
        const match = route.path.exec(pathname);
        if (!match) continue;
        url.hash = "";
        url.pathname = pathname;
        if (!route.keepQuery) url.search = "";
        route.normalize?.(url, match[1]);
        return { provider: route.provider, url: url.href, shareId: match[1] };
    }
    return null;
}

// 문장 속 공유 링크 전부 (중복 제거, 나온 순서대로)
export function findShareLinks(input: string): ShareLink[] {
    const links = new Map<string, ShareLink>();
    for (const [raw] of input.matchAll(URL_IN_TEXT)) {
        const link = parseShareLink(raw.replace(TRAILING_PUNCTUATION, ""));
        if (link && !links.has(link.url)) links.set(link.url, link);
    }
    return [...links.values()];
}
