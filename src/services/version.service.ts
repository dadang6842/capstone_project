import { versionRepository, type VersionWithSaver } from "../repositories/version.repository.js";
import { draftRepository } from "../repositories/draft.repository.js";
import { documentRepository } from "../repositories/document.repository.js";
import { findEditableDraft } from "./draft.service.js";
import { getAccess } from "./workspaceAccess.js";
import { toUserRef } from "../schemas/common.schema.js";
import { AppError } from "../utils/appError.js";
import type { ListVersionsResponse, VersionDetail, VersionListItem } from "../schemas/version.schema.js";

function toListItem(version: VersionWithSaver): VersionListItem {
    return {
        versionId: Number(version.documentVersionId),
        versionNo: version.versionNo,
        source: version.source,
        restoredFromVersionNo: version.restoredFrom?.versionNo ?? null,
        title: version.title,
        savedBy: toUserRef(version.saver),
        createdAt: version.createdAt,
    };
}

function toDetail(version: VersionWithSaver): VersionDetail {
    return {
        ...toListItem(version),
        documentId: Number(version.documentId),
        draftId: version.draftId === null ? null : Number(version.draftId),
        summary: version.summary,
        category: version.category,
        keywords: Array.isArray(version.keywords) ? (version.keywords as string[]) : [],
        content: version.content,
    };
}

// 저장 이력은 그 문서를 볼 수 있으면 누구나 본다 (개인: 본인, 팀: 팀원 전부)
export const versionService = {
    // 한 회차의 저장 이력 (A05 "N회차의 저장 이력"). 볼 수 없는·삭제한 문서의 초안은 404
    async listByDraft(userId: number, draftId: number): Promise<ListVersionsResponse> {
        const draft = await draftRepository.findWithDocumentState(BigInt(draftId));
        if (!draft || draft.document.deletedAt || !(await getAccess(userId, draft.document)))
            throw new AppError("DRAFT_NOT_FOUND");
        const versions = await versionRepository.findByDraft(draft.draftId);
        return { versions: versions.map(toListItem) };
    },

    // 채택 뒤 지식 문서의 저장 이력 (A07 내용 이력). 채택 전이면 빈 목록
    async listByDocument(userId: number, documentId: number): Promise<ListVersionsResponse> {
        const document = await documentRepository.findState(BigInt(documentId));
        if (!document || document.deletedAt || !(await getAccess(userId, document)))
            throw new AppError("DOCUMENT_NOT_FOUND");
        const versions = await versionRepository.findByDocument(BigInt(documentId));
        return { versions: versions.map(toListItem) };
    },

    // 버전 하나 열어 보기·비교. 볼 수 없는·삭제한 문서의 버전은 404
    async get(userId: number, versionId: number): Promise<VersionDetail> {
        const version = await versionRepository.findById(BigInt(versionId));
        if (!version || version.document.deletedAt || !(await getAccess(userId, version.document)))
            throw new AppError("VERSION_NOT_FOUND");
        return toDetail(version);
    },

    // 이 버전으로 복원: 현재 내용을 그 버전 내용으로 바꾸고 RESTORE 버전을 새로 쌓는다. 응답은 새로 쌓인 버전
    //  - 회차 버전: 초안 직접 수정(DRAFT-07)과 같은 조건 (권한: 소유자·관리자·최초 생성 요청자, 상태: 채택 전·AI 보완 중 아님)
    //  - 지식 문서 버전: 최종 문서 수정(DOC-03)과 같은 조건 (팀원 누구나, FINALIZED일 때만)
    async restore(userId: number, versionId: number): Promise<VersionDetail> {
        const version = await versionRepository.findById(BigInt(versionId));
        if (!version || version.document.deletedAt || !(await getAccess(userId, version.document)))
            throw new AppError("VERSION_NOT_FOUND");

        if (version.draftId !== null) {
            await findEditableDraft(userId, Number(version.draftId));
            const restored = await versionRepository.restoreDraft(
                { ...version, draftId: version.draftId },
                BigInt(userId),
            );
            if (!restored) throw new AppError("INVALID_DRAFT_STATUS");
            return toDetail(restored);
        }

        if (version.document.status !== "FINALIZED") throw new AppError("DOCUMENT_NOT_FINALIZED");
        const restored = await versionRepository.restoreDocument(version, BigInt(userId));
        // 확인한 뒤 저장하기 전에 삭제된 경우
        if (!restored) throw new AppError("DOCUMENT_NOT_FOUND");
        return toDetail(restored);
    },
};
