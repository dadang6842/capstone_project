// 입력한 문장에서 ChatGPT 공유 링크를 찾는다 (수집 모듈 share_input.py와 같은 규칙)
//  - 링크만 넣어도, 문장·줄바꿈·Markdown 링크 속에 넣어도 된다
//  - 대소문자·끝 슬래시만 다른 같은 링크는 하나로 합친다
//  - 쿼리(?)나 fragment(#)가 붙은 링크는 받지 않는다
// 수집 모듈도 같은 검사를 다시 하지만, 잘못된 입력은 Python을 띄우기 전에 여기서 바로 400으로 돌려준다
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SHARE_LINK = new RegExp(`https://chatgpt\\.com/share/(${UUID})/?(?![a-z0-9_/?#%+-])`, "gi");

export function extractShareUrls(input: string): string[] {
  const urls = [...input.matchAll(SHARE_LINK)].map((match) => `https://chatgpt.com/share/${match[1].toLowerCase()}`);
  return [...new Set(urls)];
}
