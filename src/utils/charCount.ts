// 글자수(charCount) 계산 (2026-11-21). 초안 글자수(DRAFT-02·08)와 대화 글자수(CONV-02)가 같은 기준을 쓴다:
// 저장된 문자열 그대로(공백·줄바꿈·Markdown 기호 포함), 유니코드 문자(코드 포인트) 1개를 1자로 센다.
// String.length는 이모지 같은 문자를 2로 세서 쓰지 않는다 (DB의 CHAR_LENGTH와 같은 값)
export function countChars(text: string | null): number | null {
    if (text === null) return null;
    let count = 0;
    for (const _ of text) count++;
    return count;
}
