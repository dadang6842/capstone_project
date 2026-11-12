"""문장·Markdown 링크에서 유효한 공유 링크를 찾는다. 네트워크·LLM 사용 없음."""
import re

_UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
_LINK = re.compile(
    r'https://chatgpt\.com/share/(' + _UUID + r')/?(?![a-z0-9_/?#%+-])', re.IGNORECASE)


class MultipleShareLinksError(ValueError):
    def __init__(self, candidates):
        self.candidates = list(candidates)
        super().__init__('서로 다른 공유 링크가 여러 개입니다. 가져올 링크 하나를 선택해 주세요.\n'
                         + '\n'.join(self.candidates))


def extract_share_urls(user_input: str) -> list[str]:
    if not isinstance(user_input, str):
        raise ValueError('공유 링크가 포함된 문장을 입력해 주세요.')
    # 대소문자·끝 슬래시를 통일해 같은 링크를 한 번만 반환한다.
    return list(dict.fromkeys(
        'https://chatgpt.com/share/' + match.group(1).lower()
        for match in _LINK.finditer(user_input)
    ))


def resolve_share_input(user_input: str) -> str:
    links = extract_share_urls(user_input)
    if not links:
        raise ValueError('유효한 ChatGPT 공유 링크를 찾지 못했습니다. https://chatgpt.com/share/... 링크를 넣어 주세요.')
    if len(links) > 1:
        raise MultipleShareLinksError(links)
    return links[0]
