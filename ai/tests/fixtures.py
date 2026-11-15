import asyncio, json
from types import SimpleNamespace

CODE = "def answer():\n    return 42\n"
INPUT = {
    "documentId": 15,
    "conversations": [
        {
            "conversationId": 7,
            "title": "함수 사용",
            "messages": [
                {"sourceId": "original-u", "role": "USER", "text": "함수 사용 방법은?"},
                {
                    "sourceId": "original-a",
                    "role": "ASSISTANT",
                    "text": "제안 코드\n```python\n" + CODE + "```\n",
                },
                {
                    "sourceId": "original-result",
                    "role": "USER",
                    "text": "실행해서 42가 나왔어",
                },
            ],
        }
    ],
}


def metadata(ref="S002"):
    info = {"value": "함수 사용", "origin": "model_normalized", "source_ids": [ref]}
    return {
        "main_topics": [info],
        "mentioned_topics": [],
        "classification_candidates": [],
        "entities_and_aliases": [],
        "scope": info,
        "document_type": "procedure",
        "conditions": [],
        "content_states": [],
    }


def draft(code=True, ref="S002"):
    return {
        "title": "함수 사용 방법",
        "category": "MANUAL",
        "summary": "대화에서 제안한 방법이다.",
        "keywords": ["Python", "python"],
        "body_markdown": "함수를 호출한다. 실행 결과는 사용자 보고다.",
        "source_ids": [ref],
        "metadata": metadata(ref),
        "code_selections": (
            [
                {
                    "code_ref": "C001",
                    "label": "원문 함수",
                    "notes": "제안된 코드다.",
                    "source_ids": [ref],
                }
            ]
            if code
            else []
        ),
        "uncertainties": [],
    }


def single(d=None):
    return {"document": draft() if d is None else d, "no_document_reason": None}


REVIEW = {"findings": [], "optional_notes": []}


def plan(n=2):
    return {
        "documents": [
            {
                "title": f"작업 {i}",
                "question": f"작업 {i}을 어떻게 하는가?",
                "scope": "관련 방법과 조건",
                "source_ids": ["S001", "S002", "S003"],
                "code_needed": True,
                "candidate_code_refs": ["C001"],
            }
            for i in range(n)
        ],
        "no_document_reason": None,
        "uncertainties": [],
    }


class Fake:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []
        self.responses = self

    async def create(self, **request):
        self.calls.append(request)
        if not self.outputs:
            raise AssertionError("초과 호출")
        value = self.outputs.pop(0)
        if isinstance(value, Exception):
            raise value
        if callable(value):
            value = await value(request)
        status, text = (
            value
            if isinstance(value, tuple)
            else ("completed", json.dumps(value, ensure_ascii=False))
        )
        return SimpleNamespace(
            status=status,
            model="fake",
            output_text=text,
            usage=None,
            model_dump=lambda **kw: {
                "status": status,
                "incomplete_details": (
                    {"reason": "max_output_tokens"} if status != "completed" else None
                ),
            },
        )
