import asyncio, copy, json, re, time, uuid
from pathlib import Path
from .models import ModelDraft, SearchMetadata, DraftView
from .sources import SourceBundle
from .util import digest, write_json, now
from .store import DraftRepository, Conflict
from . import review as review_policy
from . import prompts

class CallFailure(RuntimeError):
    pass


class BudgetExceeded(CallFailure):
    pass


class Deadline:
    def __init__(self, seconds):
        if not 0 < float(seconds) <= 285:
            raise ValueError("전체 요청 예산은 0초 초과~285초입니다.")
        self.end = time.monotonic() + float(seconds)

    def remaining(self):
        return max(0, self.end - time.monotonic())

    def check(self):
        if self.remaining() < 0.05:
            raise BudgetExceeded("전체 요청 시간 예산이 소진됐습니다.")


def bound_schema(model, ids, refs=()):
    schema = copy.deepcopy(model.model_json_schema())

    def visit(node, name=None):
        if isinstance(node, dict):
            if name == "source_ids" and node.get("type") == "array":
                node["items"] = {"type": "string", "enum": list(ids)}
            if name == "code_ref" and refs:
                node["enum"] = list(refs)
            for key, value in list(node.items()):
                if key == "properties":
                    for field, definition in value.items():
                        visit(definition, field)
                else:
                    visit(value)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(schema)
    return schema


def check_refs(value, allowed):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "source_ids" and not set(item) <= set(allowed):
                raise ValueError("입력 범위 밖의 출처 ID입니다.")
            check_refs(item, allowed)
    elif isinstance(value, list):
        for item in value:
            check_refs(item, allowed)


def validate_model(draft, bundle, allowed):
    draft = ModelDraft.model_validate(draft).model_dump()
    check_refs(draft, allowed)
    if not draft["title"].strip() or not draft["body_markdown"].strip():
        raise ValueError("빈 제목 또는 본문입니다.")
    if re.search(r"(?m)^\s*(`{3,}|~{3,})", draft["body_markdown"]):
        raise ValueError("코드는 재작성하지 않고 code_selections로 선택해야 합니다.")
    selected = set()
    for item in draft["code_selections"]:
        ref = item["code_ref"]
        if ref in selected:
            raise ValueError("동일 코드 중복 선택입니다.")
        selected.add(ref)
        if ref not in bundle.catalog:
            raise ValueError("존재하지 않는 코드 참조입니다.")
        valid = set(bundle.catalog[ref]["source_ids"]) & set(allowed)
        if not set(item["source_ids"]) <= valid:
            raise ValueError("코드와 출처가 일치하지 않습니다.")
    # The response contract validates title/keywords lengths without truncating user-visible meaning.
    DraftView.model_validate(
        {
            "title": draft["title"].strip(),
            "category": draft["category"],
            "summary": draft["summary"],
            "keywords": draft["keywords"],
            "content": draft["body_markdown"],
        }
    )
    if any(not k.strip() for k in draft["keywords"]):
        raise ValueError("빈 키워드입니다.")
    return draft


def bind_metadata(metadata, bundle):
    result = copy.deepcopy(metadata)

    def visit(value):
        if isinstance(value, dict):
            if "source_ids" in value:
                value["sources"] = [
                    bundle.link(sid) for sid in dict.fromkeys(value["source_ids"])
                ]
            for key, item in list(value.items()):
                if key != "sources":
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(result)
    for item in result["classification_candidates"]:
        item.update(
            origin="model_normalized", dictionaryStatus="candidate_not_registered"
        )
    return result


def render(draft, bundle):
    body = draft["body_markdown"].strip()
    copied = []
    used = set(draft["source_ids"])

    def collect(value):
        if isinstance(value, dict):
            if "source_ids" in value:
                used.update(value["source_ids"])
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(draft["metadata"])
    for item in draft["code_selections"]:
        code = bundle.catalog[item["code_ref"]]
        fence = "`" * max(
            3, max([len(run) for run in re.findall(r"`+", code["code"])] + [0]) + 1
        )
        body += (
            "\n\n### "
            + item["label"]
            + "\n\n"
            + item["notes"]
            + "\n\n"
            + fence
            + "\n"
            + code["code"]
            + "\n"
            + fence
        )
        used.update(item["source_ids"])
        copied.append(
            {
                "codeRef": item["code_ref"],
                "code": code["code"],
                "sha256": code["sha256"],
                "label": item["label"],
                "notes": item["notes"],
                "sources": [bundle.link(sid) for sid in item["source_ids"]],
            }
        )
    keywords = list(dict.fromkeys(k.strip() for k in draft["keywords"]))
    # Case-insensitive duplicates are also coalesced for the standalone module.
    seen = set()
    keywords = [
        k for k in keywords if not (k.casefold() in seen or seen.add(k.casefold()))
    ]
    view = DraftView.model_validate(
        {
            "title": draft["title"].strip(),
            "category": draft["category"],
            "summary": draft["summary"],
            "keywords": keywords,
            "content": body,
        }
    ).model_dump()
    return view, copied, [bundle.link(sid) for sid in bundle.lookup if sid in used]


def public_draft(item):
    def camel(key):
        parts = key.split("_")
        return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])

    def convert(value):
        if isinstance(value, dict):
            return {camel(k): convert(v) for k, v in value.items()}
        if isinstance(value, list):
            return [convert(v) for v in value]
        return copy.deepcopy(value)

    return {
        camel(key): convert(value)
        for key, value in item.items()
        if not key.startswith("_")
    }


class ModelIO:
    def __init__(self, client, directory, *, model="gpt-6-luna", budget_seconds=280):
        self.client = client
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        self.repo = DraftRepository(self.root / "drafts.sqlite3")
        self.model = model
        if not 0 < float(budget_seconds) <= 285:
            raise ValueError("요청 예산은 285초 이하로 설정하세요.")
        self.budget_seconds = float(budget_seconds)
        self.settings = {
            "model": model,
            "temperature": 0,
            "reasoning": {"effort": "none"},
            "store": False,
        }
        self.usage = []


    async def call_json(
        self,
        scope,
        phase,
        prompt,
        payload,
        model,
        deadline,
        *,
        ids,
        refs=(),
        limit=6000,
        validator=None,
        schema=None,
    ):
        request = {
            **self.settings,
            "instructions": prompt,
            "input": json.dumps(payload, ensure_ascii=False),
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": model.__name__.lower(),
                    "strict": True,
                    "schema": schema or bound_schema(model, ids, refs),
                }
            },
            "max_output_tokens": limit,
        }
        key = digest(request)
        folder = self.root / "calls" / digest(scope)
        cache = folder / "cache" / f"{key}.json"
        if cache.exists():
            stored = json.loads(cache.read_text(encoding="utf-8"))
            if stored["requestHash"] != key:
                raise CallFailure("응답 캐시 해시 불일치")
            parsed = model.model_validate(stored["parsed"]).model_dump()
            return validator(parsed) if validator else parsed
        deadline.check()
        audit = folder / "attempts" / f"{phase}_{key}_{uuid.uuid4().hex}.json"
        start = time.monotonic()
        try:
            response = await asyncio.wait_for(
                self.client.responses.create(**request), timeout=deadline.remaining()
            )
        except asyncio.TimeoutError as exc:
            write_json(
                audit,
                {"requestHash": key, "phase": phase, "status": "timeout", "at": now()},
            )
            raise BudgetExceeded("전체 요청 시간 예산을 초과했습니다.") from exc
        except Exception as exc:
            write_json(
                audit,
                {
                    "requestHash": key,
                    "phase": phase,
                    "status": "request_failed",
                    "errorType": type(exc).__name__,
                    "at": now(),
                },
            )
            raise CallFailure("모델 요청 실패. 자동 재시도하지 않습니다.") from exc
        record = {
            "requestHash": key,
            "phase": phase,
            "status": response.status,
            "model": response.model,
            "rawText": response.output_text,
            "usage": response.usage.model_dump() if response.usage else {},
            "elapsedSeconds": round(time.monotonic() - start, 3),
            "rawResponse": response.model_dump(mode="json"),
        }
        write_json(audit, record)
        self.usage.append(
            {"phase": phase, "usage": record["usage"], "auditPath": str(audit)}
        )
        if response.status != "completed":
            raise CallFailure(
                "모델 응답 미완료: "
                + str(record["rawResponse"].get("incomplete_details"))
            )
        try:
            parsed = model.model_validate_json(response.output_text).model_dump()
            checked = validator(parsed) if validator else parsed
        except ValueError as exc:
            raise CallFailure(
                "모델 출력 형식·출처 검사 실패. 원응답은 보관했습니다."
            ) from exc
        # Only structurally valid, source-bound output is reusable. Failed attempts remain in the audit log.
        write_json(
            cache, {"requestHash": key, "parsed": parsed, "auditPath": str(audit)}
        )
        return checked


    async def refresh_metadata(self, scope, artifact_id, expected_version):
        item = self.repo.get(scope, artifact_id)
        if item["version"] != expected_version:
            raise Conflict("최신 문서 버전을 확인하세요.")
        if item["metadataStatus"] == "current":
            return item

        # A user-edited document is its own explicit provenance; never pretend it is original dialogue.
        bundle = SourceBundle([], {"title": item["title"], "content": item["content"]})
        bundle.lookup = {
            "U001": {
                **bundle.lookup["P001"],
                "kind": "user_edited_document",
                "draftArtifactId": artifact_id,
                "draftVersion": expected_version,
            }
        }

        def validate(value):
            check_refs(value, ["U001"])
            return value

        value = await self.call_json(
            scope,
            "metadata_refresh",
            prompts.METADATA_PROMPT,
            {
                "title": item["title"],
                "category": item["category"],
                "source_id": "U001",
                "text": item["content"],
            },
            SearchMetadata,
            Deadline(self.budget_seconds),
            ids=["U001"],
            limit=5000,
            validator=validate,
        )
        metadata = bind_metadata(value, bundle)
        return self.repo.refresh_metadata(
            scope, artifact_id, expected_version, metadata, bundle.lookup
        )


