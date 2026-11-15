from typing import Literal, Annotated
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

class StrictMeta(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SearchInfo(StrictMeta):
    value: str = Field(min_length=1)
    origin: Literal["source", "model_normalized"]
    source_ids: list[str] = Field(min_length=1)


class Classification(StrictMeta):
    path: list[str] = Field(min_length=1)
    source_ids: list[str] = Field(min_length=1)


class Condition(StrictMeta):
    text: str = Field(min_length=1)
    source_ids: list[str] = Field(min_length=1)


class ContentState(StrictMeta):
    statement: str = Field(min_length=1)
    status: Literal[
        "explanation",
        "reported_statement",
        "user_preference",
        "proposed",
        "adopted",
        "retracted",
        "unresolved",
        "reported_result",
    ]
    source_ids: list[str] = Field(min_length=1)


class SearchMetadata(StrictMeta):
    main_topics: list[SearchInfo] = Field(min_length=1)
    mentioned_topics: list[SearchInfo]
    classification_candidates: list[Classification]
    entities_and_aliases: list[SearchInfo]
    scope: SearchInfo
    document_type: Literal[
        "explanation", "procedure", "comparison", "decision", "troubleshooting", "mixed"
    ]
    conditions: list[Condition]
    content_states: list[ContentState]


class GeneratedDocument(StrictMeta):
    title: str = Field(min_length=1)
    body_markdown: str = Field(min_length=1)
    source_ids: list[str] = Field(min_length=1)
    metadata: SearchMetadata


PositiveId = Annotated[int, Field(strict=True, gt=0)]


Keyword = Annotated[str, StringConstraints(min_length=1, max_length=50)]


Category = Literal["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"]


class MessageInput(StrictMeta):
    sourceId: str = Field(min_length=1)
    role: Literal["USER", "ASSISTANT"]
    text: str = Field(min_length=1)


class ExtendedMessage(MessageInput):
    # Proposed v2 field; the v1 API remains unchanged.
    codeBlocks: list[str] = Field(default_factory=list)


class ExtendedConversation(StrictMeta):
    conversationId: PositiveId
    title: str | None
    messages: list[ExtendedMessage] = Field(min_length=1)


class DraftView(StrictMeta):
    title: str = Field(min_length=1, max_length=255)
    category: Category
    summary: str = Field(max_length=512)
    keywords: list[Keyword] = Field(max_length=10)
    content: str = Field(min_length=1)


class CodeSelection(StrictMeta):
    code_ref: str
    label: str = Field(min_length=1)
    notes: str = Field(min_length=1)
    source_ids: list[str] = Field(min_length=1)


class ModelDraft(GeneratedDocument):
    category: Category
    summary: str = Field(max_length=512)
    keywords: list[Keyword] = Field(max_length=10)
    code_selections: list[CodeSelection]
    uncertainties: list[str]


class Finding(StrictMeta):
    category: Literal["source_fidelity", "essential_context", "metadata_contradiction"]
    certainty: Literal["supported", "uncertain"]
    field_path: str = Field(min_length=1)
    document_passage: str = Field(min_length=1)
    evidence_refs: list[str] = Field(min_length=1)
    reason: str = Field(min_length=1)
    impact: str = Field(min_length=1)
    suggestion: str = Field(min_length=1)


class CriticalReview(StrictMeta):
    findings: list[Finding]
    optional_notes: list[str]


