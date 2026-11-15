import copy, re, hashlib
from .util import digest

FENCE = re.compile(r"(?ms)^(`{3,}|~{3,})[^\n]*\n(.*?)^\1[ \t]*(?:\n|$)")


def fenced_codes(text):
    return [match.group(2) for match in FENCE.finditer(text) if match.group(2).strip()]


class SourceBundle:
    def __init__(self, conversations, previous=None):
        self.lookup = {}
        self.catalog = {}
        self.blocks = []
        self.warnings = []
        seen_conversations = set()
        hash_refs = {}

        def add(ref, entry, codes):
            self.lookup[ref] = entry
            text = entry["text"]
            refs = []
            for code in codes:
                if not isinstance(code, str) or not code.strip():
                    continue
                sha = hashlib.sha256(code.encode()).hexdigest()
                code_ref = hash_refs.get(sha)
                if code_ref is None:
                    code_ref = f"C{len(self.catalog)+1:03d}"
                    hash_refs[sha] = code_ref
                    self.catalog[code_ref] = {
                        "code_ref": code_ref,
                        "code": code,
                        "sha256": sha,
                        "source_ids": [],
                    }
                origins = self.catalog[code_ref]["source_ids"]
                if ref not in origins:
                    origins.append(ref)
                if code_ref not in refs:
                    refs.append(code_ref)
                if code in text:
                    text = text.replace(code, f"\n[원문 코드 {code_ref}]\n")
            self.blocks.append(
                {
                    "source_id": ref,
                    "conversation_id": entry["conversationId"],
                    "conversation_title": entry["title"],
                    "sequence": entry["sequence"],
                    "role": entry["role"],
                    "kind": entry["kind"],
                    "text": text,
                    "code_refs": refs,
                }
            )

        for conversation in conversations:
            cid = conversation["conversationId"]
            if cid in seen_conversations:
                raise ValueError("중복 conversationId입니다.")
            seen_conversations.add(cid)
            seen = set()
            for sequence, message in enumerate(conversation["messages"], 1):
                if not message["sourceId"].strip() or message["sourceId"] in seen:
                    raise ValueError("대화 내 메시지 ID 누락 또는 중복입니다.")
                if not message["text"].strip():
                    raise ValueError("비어 있는 원문입니다.")
                seen.add(message["sourceId"])
                ref = f"S{len(self.lookup)+1:03d}"
                codes = message.get("codeBlocks") or fenced_codes(message["text"])
                add(
                    ref,
                    {
                        "kind": "conversation_message",
                        "conversationId": cid,
                        "sourceId": message["sourceId"],
                        "sequence": sequence,
                        "role": message["role"],
                        "title": conversation["title"],
                        "text": message["text"],
                    },
                    codes,
                )
        if previous is not None:
            # User-supplied baseline is a reference, not a fabricated original conversation message.
            previous_text = previous.get("content") or ""
            if previous_text.strip():
                add(
                    "P001",
                    {
                        "kind": "previous_draft",
                        "conversationId": None,
                        "sourceId": None,
                        "sequence": None,
                        "role": "REFERENCE",
                        "title": previous.get("title"),
                        "text": previous_text,
                    },
                    fenced_codes(previous_text),
                )
        if not self.lookup:
            raise ValueError("사용할 원문 또는 기준 초안이 없습니다.")
        self.hash = digest({"conversations": conversations, "previous": previous})
        self.warnings = [
            "원문 수집 완전성과 외부 사실은 이 모듈에서 검증하지 않습니다.",
            "첨부 메타데이터는 첨부 원본 본문이 아닙니다. 없는 내용을 추정하지 마세요.",
        ]
        if not self.catalog:
            self.warnings.append(
                "코드 경계가 제공되지 않았습니다. 일반 평문에서 코드 경계를 추측하지 않습니다."
            )

    def link(self, ref):
        item = self.lookup[ref]
        return {
            "sourceRef": ref,
            **{
                key: item[key]
                for key in ["kind", "conversationId", "sourceId", "sequence", "role"]
            },
            **{
                key: item[key]
                for key in ["draftArtifactId", "draftVersion"]
                if key in item
            },
        }

    def selected(self, ids):
        ids = set(ids)
        if not ids or not ids <= self.lookup.keys():
            raise ValueError("알 수 없는 원문 참조입니다.")
        blocks = [block for block in self.blocks if block["source_id"] in ids]
        refs = {ref for block in blocks for ref in block["code_refs"]}
        codes = [
            {
                **self.catalog[ref],
                "source_ids": [
                    sid for sid in self.catalog[ref]["source_ids"] if sid in ids
                ],
            }
            for ref in sorted(refs)
        ]
        return {
            "source_blocks": blocks,
            "code_catalog": codes,
            "source_warnings": self.warnings,
        }


def from_capture(capture, document_id=1, conversation_id=1):
    if (
        not isinstance(capture, dict)
        or capture.get("schema_version") != "shared_text_v1"
    ):
        raise ValueError("import 모듈의 shared_text_v1 JSON이 필요합니다.")
    messages = capture["conversation"]["messages"]
    ids = set()
    if not messages:
        raise ValueError("빈 대화입니다.")
    output = []
    for i, message in enumerate(messages, 1):
        if "sequence" in message and message["sequence"] != i:
            raise ValueError("수집 발화 순서를 확인하세요.")
        sid = message["source_message_id"]
        if sid in ids:
            raise ValueError("수집 발화 ID 중복입니다.")
        ids.add(sid)
        role = {"user": "USER", "assistant": "ASSISTANT"}.get(message["role"])
        if role is None:
            raise ValueError("지원하지 않는 발화자입니다.")
        output.append(
            {
                "sourceId": sid,
                "role": role,
                "text": message["content"],
                "codeBlocks": message.get("code_blocks", []),
            }
        )
    return {
        "documentId": document_id,
        "conversations": [
            {
                "conversationId": conversation_id,
                "title": capture["conversation"].get("title"),
                "messages": output,
            }
        ],
    }
