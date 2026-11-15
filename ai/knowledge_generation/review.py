import copy
from .models import CriticalReview


def fields(value, path=""):
    result = {}
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("source_ids", "code_ref", "uncertainties"):
                continue
            result.update(fields(item, f"{path}.{key}" if path else key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            result.update(fields(item, f"{path}[{index}]"))
    elif isinstance(value, str) and value.strip():
        result[path] = value
    return result


def review_input(draft, selected, bundle):
    evidence = {}
    units = []
    for block in selected["source_blocks"]:
        text = block["text"]
        start = 0
        while start < len(text):
            end = min(start + 1600, len(text))
            if end < len(text):
                newline = text.rfind("\n", start + 800, end)
                if newline >= 0:
                    end = newline + 1
            if text[start:end].strip():
                ref = f"{block['source_id']}:T{len(units)+1:04d}"
                unit = {
                    "ref": ref,
                    "source_ids": [block["source_id"]],
                    "role": block["role"],
                    **{key: block.get(key) for key in
                       ("conversation_id", "conversation_title", "sequence")},
                    "kind": "text",
                    "text": text[start:end],
                    "start": start,
                    "end": end,
                    "offset_basis": "compact_source_text",
                }
                units.append(unit)
                evidence[ref] = unit
            start = end
    for code in selected["code_catalog"]:
        evidence[code["code_ref"]] = {
            "ref": code["code_ref"],
            "kind": "code",
            "source_ids": code["source_ids"],
            "text": code["code"],
            "sha256": code["sha256"],
        }
    paths = fields(draft)
    payload = {
        "draft": draft,
        "field_paths": list(paths),
        "evidence_units": units,
        "code_catalog": selected["code_catalog"],
        "source_warnings": selected["source_warnings"],
        "review_limits": "이번 문서에 배정된 원문 범위의 검토이며 외부 사실·배정 밖 누락을 검증하지 않는다.",
    }
    return payload, evidence, paths


def assess(output, evidence, paths, bundle, content_hash):
    output = CriticalReview.model_validate(output).model_dump()
    if len(output["findings"]) > 5:
        raise ValueError("검토 의견은 최대 5개입니다.")
    findings = []
    for finding in output["findings"]:
        checks = []
        field = paths.get(finding["field_path"])
        if field is None or finding["document_passage"] not in field:
            checks.append("passage_not_in_field")
        if any(ref not in evidence for ref in finding["evidence_refs"]):
            checks.append("unknown_evidence_ref")
        if any(
            not finding[key].strip()
            for key in ["reason", "impact", "suggestion", "document_passage"]
        ):
            checks.append("empty_explanation")
        excerpts = []
        for ref in dict.fromkeys(finding["evidence_refs"]):
            if ref not in evidence:
                continue
            item = evidence[ref]
            excerpts.append(
                {
                    "evidenceRef": ref,
                    "kind": item["kind"],
                    "text": item["text"],
                    "sources": [bundle.link(sid) for sid in item["source_ids"]],
                    **(
                        {
                            "offsetBasis": item["offset_basis"],
                            "start": item["start"],
                            "end": item["end"],
                        }
                        if "start" in item
                        else {}
                    ),
                }
            )
        certainty = "uncertain" if checks else finding["certainty"]
        findings.append(
            {
                "category": finding["category"],
                "certainty": certainty,
                "fieldPath": finding["field_path"],
                "passage": finding["document_passage"],
                "reason": finding["reason"],
                "impact": finding["impact"],
                "suggestion": finding["suggestion"],
                "evidence": excerpts,
                "supportChecks": checks,
            }
        )
    status = "attention_needed" if findings else "no_issues_detected"
    return {
        "status": status,
        "label": "확인할 사항 있음" if findings else "자동 검토에서 지적된 사항 없음",
        "findings": findings,
        "optionalNotes": output["optional_notes"],
        "contentHash": content_hash,
        "externalTruth": "not_checked",
        "meaning": "model_review_only",
        "automaticRevisionPerformed": False,
    }


def incomplete(reason, content_hash):
    return {
        "status": "incomplete",
        "label": "자동 검토 미완료",
        "reason": reason,
        "findings": [],
        "optionalNotes": [],
        "contentHash": content_hash,
        "externalTruth": "not_checked",
        "meaning": "not_completed",
        "automaticRevisionPerformed": False,
    }
