"""Local trial repository. Production backend owns authentication and its own DB transaction."""

import copy, json, sqlite3, time, uuid
from pathlib import Path
from .util import now, digest


class Conflict(RuntimeError):
    pass


class NotFound(RuntimeError):
    pass


class Busy(RuntimeError):
    pass


class DraftRepository:
    def __init__(self, database):
        self.database = Path(database)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript("""
CREATE TABLE IF NOT EXISTS drafts(scope TEXT,id TEXT,version INTEGER,payload TEXT NOT NULL,PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS versions(scope TEXT,id TEXT,version INTEGER,payload TEXT NOT NULL,PRIMARY KEY(scope,id,version));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,draft_id TEXT,kind TEXT,actor TEXT,payload TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS leases(scope TEXT,key TEXT,token TEXT,expires REAL,PRIMARY KEY(scope,key));
""")

    def connect(self):
        return sqlite3.connect(self.database, timeout=5)

    def get(self, scope, draft_id):
        with self.connect() as conn:
            row = conn.execute(
                "SELECT payload FROM drafts WHERE scope=? AND id=?", (scope, draft_id)
            ).fetchone()
        if row is None:
            raise NotFound("초안을 찾지 못했습니다.")
        return json.loads(row[0])

    def maybe_get(self, scope, draft_id):
        try:
            return self.get(scope, draft_id)
        except NotFound:
            return None

    def _event(self, conn, scope, draft_id, kind, actor, payload):
        conn.execute(
            "INSERT INTO events(scope,draft_id,kind,actor,payload,created_at) VALUES(?,?,?,?,?,?)",
            (
                scope,
                draft_id,
                kind,
                actor,
                json.dumps(payload, ensure_ascii=False),
                now(),
            ),
        )

    def _write(self, conn, scope, item, *, snapshot=True):
        text = json.dumps(item, ensure_ascii=False)
        conn.execute(
            "INSERT OR REPLACE INTO drafts VALUES(?,?,?,?)",
            (scope, item["artifactId"], item["version"], text),
        )
        if snapshot:
            conn.execute(
                "INSERT INTO versions VALUES(?,?,?,?)",
                (scope, item["artifactId"], item["version"], text),
            )

    def create(self, scope, item):
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            old = conn.execute(
                "SELECT payload FROM drafts WHERE scope=? AND id=?",
                (scope, item["artifactId"]),
            ).fetchone()
            if old:
                return json.loads(old[0])
            if item["status"] != "draft":
                raise ValueError("생성 초안은 draft 상태여야 합니다.")
            self._write(conn, scope, item)
            self._event(conn, scope, item["artifactId"], "generated", "ai", {})
        return copy.deepcopy(item)

    def set_review(self, scope, draft_id, version, review):
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM drafts WHERE scope=? AND id=?", (scope, draft_id)
            ).fetchone()
            if row is None:
                raise NotFound("초안을 찾지 못했습니다.")
            item = json.loads(row[0])
            if (
                item["version"] != version
                or item["contentHash"] != review["contentHash"]
            ):
                raise Conflict("문서가 변경되어 이전 본문의 검토를 적용할 수 없습니다.")
            item["review"] = review
            item["updatedAt"] = now()
            self._write(conn, scope, item, snapshot=False)
            # Annotate this content version without changing its body or adoption state.
            snapshot_row = conn.execute(
                "SELECT payload FROM versions WHERE scope=? AND id=? AND version=?",
                (scope, draft_id, version),
            ).fetchone()
            snapshot = json.loads(snapshot_row[0])
            snapshot["review"] = review
            conn.execute(
                "UPDATE versions SET payload=? WHERE scope=? AND id=? AND version=?",
                (json.dumps(snapshot, ensure_ascii=False), scope, draft_id, version),
            )
            self._event(
                conn,
                scope,
                draft_id,
                "automatic_review",
                "ai",
                {"version": version, "status": review["status"],
                 "contentHash": review["contentHash"], "review": review},
            )
        return item

    def edit(self, scope, draft_id, expected_version, changes, actor):
        from .models import DraftView
        from .review import incomplete

        if not actor.strip():
            raise ValueError("인증된 수정자 식별자가 필요합니다.")
        if not changes or not set(changes) <= {
            "title",
            "category",
            "summary",
            "keywords",
            "content",
        }:
            raise ValueError("수정 가능한 초안 필드를 확인하세요.")
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM drafts WHERE scope=? AND id=?", (scope, draft_id)
            ).fetchone()
            if row is None:
                raise NotFound("초안을 찾지 못했습니다.")
            item = json.loads(row[0])
            if item["version"] != expected_version:
                raise Conflict("다른 수정이 먼저 저장됐습니다. 최신 버전을 확인하세요.")
            view = DraftView.model_validate(
                {**{k: item[k] for k in DraftView.model_fields}, **changes}
            ).model_dump()
            if not view["title"].strip() or not view["content"].strip():
                raise ValueError("제목·본문은 비울 수 없습니다.")
            item.update(view)
            item["version"] += 1
            item["status"] = "draft"
            item["updatedAt"] = now()
            item["contentHash"] = digest(view)
            item["metadataStatus"] = "needs_refresh"
            item["eligibleForIndexing"] = False
            item["contentOrigin"] = "user_edited"
            item["sourceLinksStatus"] = "needs_review"
            item["relationsStatus"] = "stale"
            item["review"] = incomplete("user_edited", item["contentHash"])
            item["lastUserAction"] = {"kind": "edited", "actor": actor, "at": now()}
            item["copiedCodeBlocks"] = [
                c for c in item["copiedCodeBlocks"] if c["code"] in item["content"]
            ]
            self._write(conn, scope, item)
            self._event(
                conn,
                scope,
                draft_id,
                "edited",
                actor,
                {"fields": list(changes), "version": item["version"]},
            )
        return item

    def adopt_many(self, scope, selections, actor):
        if not actor.strip() or not selections:
            raise ValueError("인증된 사용자와 선택 문서가 필요합니다.")
        if len({i for i, v in selections}) != len(selections):
            raise ValueError("중복 선택입니다.")
        result = []
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            # Entire selection is validated before any write.
            for draft_id, expected_version in selections:
                row = conn.execute(
                    "SELECT payload FROM drafts WHERE scope=? AND id=?",
                    (scope, draft_id),
                ).fetchone()
                if row is None:
                    raise NotFound("선택 문서를 찾지 못했습니다.")
                item = json.loads(row[0])
                if item["version"] != expected_version:
                    raise Conflict("선택 문서의 버전이 변경됐습니다.")
                result.append(item)
            for item in result:
                if item["status"] == "adopted":
                    continue
                item.update(
                    status="adopted",
                    updatedAt=now(),
                    eligibleForIndexing=item["metadataStatus"] == "current",
                )
                item["lastUserAction"] = {
                    "kind": "adopted",
                    "actor": actor,
                    "at": now(),
                    "meaning": "저장을 선택함. 전체 열람·사실 검증을 의미하지 않음.",
                }
                self._write(conn, scope, item, snapshot=False)
                self._event(
                    conn,
                    scope,
                    item["artifactId"],
                    "adopted",
                    actor,
                    {
                        "version": item["version"],
                        "reviewStatus": item["review"]["status"],
                    },
                )
        return result

    def refresh_metadata(self, scope, draft_id, expected_version, metadata, lookup):
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM drafts WHERE scope=? AND id=?", (scope, draft_id)
            ).fetchone()
            if row is None:
                raise NotFound("초안을 찾지 못했습니다.")
            item = json.loads(row[0])
            if item["version"] != expected_version:
                raise Conflict("본문이 바뀌어 이전 메타데이터를 적용할 수 없습니다.")
            item["version"] += 1
            item["metadata"] = metadata
            item["metadataStatus"] = "current"
            item["_metadataSourceLookup"] = lookup
            item["updatedAt"] = now()
            item["relationsStatus"] = "stale"
            item["eligibleForIndexing"] = item["status"] == "adopted"
            self._write(conn, scope, item)
            self._event(
                conn,
                scope,
                draft_id,
                "metadata_refreshed",
                "ai",
                {"version": item["version"]},
            )
        return item

    def history(self, scope, draft_id):
        self.get(scope, draft_id)
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT kind,actor,payload,created_at FROM events WHERE scope=? AND draft_id=? ORDER BY id",
                (scope, draft_id),
            ).fetchall()
        return [
            {"kind": k, "actor": a, "details": json.loads(p), "at": at}
            for k, a, p, at in rows
        ]

    def version(self, scope, draft_id, version):
        with self.connect() as conn:
            row = conn.execute(
                "SELECT payload FROM versions WHERE scope=? AND id=? AND version=?",
                (scope, draft_id, version),
            ).fetchone()
        if row is None:
            raise NotFound("이전 버전을 찾지 못했습니다.")
        return json.loads(row[0])

    def acquire(self, scope, key, seconds):
        token = uuid.uuid4().hex
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM leases WHERE expires<?", (time.time(),))
            try:
                conn.execute(
                    "INSERT INTO leases VALUES(?,?,?,?)",
                    (scope, key, token, time.time() + seconds),
                )
            except sqlite3.IntegrityError as exc:
                raise Busy("같은 요청이 처리 중입니다.") from exc
        return token

    def release(self, scope, key, token):
        with self.connect() as conn:
            conn.execute(
                "DELETE FROM leases WHERE scope=? AND key=? AND token=?",
                (scope, key, token),
            )
