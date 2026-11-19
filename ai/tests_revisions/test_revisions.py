"""AI 보완 라우터(POST /revisions) 단위 테스트. 모델 클라이언트를 가짜로 넣어 외부 API를 부르지 않는다."""
import json
import unittest
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from knowledge_generation.revisions import register_revisions
from knowledge_generation.util import digest


class FakeResponses:
    def __init__(self):
        self.output = None
        self.status = "completed"
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(status=self.status, output_text=json.dumps(self.output, ensure_ascii=False))


def body(reasons=("TOO_LONG",), conversations=True):
    return {
        "draftId": 33,
        "previousDraft": {
            "title": "LDA 정리", "category": "CONCEPT_NOTE", "summary": "",
            "keywords": ["LDA"], "content": "수업에서 LDA 실습은 하지 않았다. 수업에서 LDA 실습은 하지 않았다.",
        },
        "reasons": list(reasons),
        "conversations": [{
            "conversationId": 7, "title": "수업 정리",
            "messages": [
                {"sourceId": "message-12", "role": "USER", "text": "LDA는 실습 없이 개념만 다뤘어."},
                {"sourceId": "message-13", "role": "ASSISTANT", "text": "네, 개념 위주로 정리할게요."},
            ],
        }] if conversations else [],
    }


class RevisionTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeResponses()
        app = FastAPI()
        register_revisions(app, client=SimpleNamespace(responses=self.fake), internal_key="test-key", model="fake-model")
        self.client = TestClient(app)
        self.headers = {"X-Internal-Api-Key": "test-key"}

    def tearDown(self):
        self.client.close()

    def candidate(self, refs):
        return {
            "title": " LDA 정리 ", "category": "CONCEPT_NOTE", "summary": "LDA는 개념만 다뤘다.",
            "keywords": [" LDA "], "content": "LDA는 실습 없이 개념만 다뤘다.", "sourceRefs": refs,
        }

    def test_revision_returns_one_document_with_links(self):
        self.fake.output = self.candidate(["S001"])
        res = self.client.post("/revisions", json=body(("TOO_LONG", "MISSING_CONTENT")), headers=self.headers)
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        view = {k: data[k] for k in ("title", "category", "summary", "keywords", "content")}
        self.assertEqual(view["title"], "LDA 정리")
        self.assertEqual(view["keywords"], ["LDA"])
        self.assertEqual(data["contentHash"], digest(view))
        self.assertEqual(data["sourceLinksStatus"], "needs_review")
        self.assertEqual(data["reviewStatus"], "pending")
        self.assertEqual(len(data["sourceLinks"]), 1)
        self.assertEqual(data["sourceLinks"][0]["conversationId"], 7)
        self.assertEqual(data["sourceLinks"][0]["sourceId"], "message-12")
        self.assertEqual(len(self.fake.calls), 1)  # 두 항목도 모델 호출 한 번

    def test_too_long_without_conversations(self):
        self.fake.output = self.candidate([])
        res = self.client.post("/revisions", json=body(conversations=False), headers=self.headers)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["sourceLinks"], [])

    def test_missing_content_needs_conversations(self):
        res = self.client.post("/revisions", json=body(("MISSING_CONTENT",), conversations=False), headers=self.headers)
        self.assertEqual(res.status_code, 422)
        self.assertEqual(self.fake.calls, [])

    def test_wrong_key(self):
        res = self.client.post("/revisions", json=body(), headers={"X-Internal-Api-Key": "nope"})
        self.assertEqual(res.status_code, 401)

    def test_code_blocks_accepted(self):
        payload = body()
        payload["conversations"][0]["messages"][1]["codeBlocks"] = ["print('hi')"]
        self.fake.output = self.candidate([])
        res = self.client.post("/revisions", json=payload, headers=self.headers)
        self.assertEqual(res.status_code, 200, res.text)

    def test_unknown_source_ref_is_502(self):
        self.fake.output = self.candidate(["S999"])
        res = self.client.post("/revisions", json=body(), headers=self.headers)
        self.assertEqual(res.status_code, 502)
        self.assertIn("errorMessage", res.json())

    def test_incomplete_model_response_is_502(self):
        self.fake.output = self.candidate([])
        self.fake.status = "incomplete"
        res = self.client.post("/revisions", json=body(), headers=self.headers)
        self.assertEqual(res.status_code, 502)


if __name__ == "__main__":
    unittest.main()