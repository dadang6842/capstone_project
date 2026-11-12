-- 대화 입력 방식 변경 (2026-11-11): JSON 파일 업로드(S3) → ChatGPT 공유 링크 수집(DB 저장), NOT_KNOWLEDGE(지식 유형 아님) 기능 삭제
-- AI 연동 변경 (2026-11-12): AI 서버가 GPT로 초안을 만들어 응답으로 돌려줌 → documents.prompt 삭제, drafts.fail_reason 값 정리
-- 기존 업로드 대화 행은 share_url이 빈 문자열·status COLLECTING으로 남고, 서버가 켜질 때 FAILED(TIMEOUT)로 바뀐다. 테스트 데이터라면 미리 지우는 것을 권장
-- status가 NOT_KNOWLEDGE인 documents·drafts 행이 있으면 ENUM 변경이 실패하므로 먼저 지울 것

-- (직접 추가) 기존 실패 원인 ANALYSIS_FAILED·GPT_FAILED를 GENERATION_FAILED로 옮긴다. 값을 잠깐 모두 허용한 뒤 바꾸고, 아래에서 최종 값으로 줄인다
ALTER TABLE `drafts` MODIFY `fail_reason` ENUM('ANALYSIS_FAILED', 'GPT_FAILED', 'GENERATION_FAILED', 'REVISION_FAILED', 'INVALID_RESPONSE', 'TIMEOUT') NULL;
UPDATE `drafts` SET `fail_reason` = 'GENERATION_FAILED' WHERE `fail_reason` IN ('ANALYSIS_FAILED', 'GPT_FAILED');

-- AlterTable
ALTER TABLE `conversations` DROP COLUMN `content_type`,
    DROP COLUMN `file_size`,
    DROP COLUMN `filename`,
    DROP COLUMN `refined_at`,
    DROP COLUMN `s3_key`,
    ADD COLUMN `capture_id` VARCHAR(80) NULL,
    ADD COLUMN `collect_fail_reason` ENUM('NOT_ACCESSIBLE', 'UNSUPPORTED_CONTENT', 'TIMEOUT', 'COLLECT_ERROR', 'DUPLICATED') NULL,
    ADD COLUMN `share_url` VARCHAR(255) NOT NULL,
    ADD COLUMN `status` ENUM('COLLECTING', 'COLLECTED', 'FAILED') NOT NULL DEFAULT 'COLLECTING',
    ADD COLUMN `title` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `documents` DROP COLUMN `prompt`,
    MODIFY `status` ENUM('GENERATING', 'DRAFT_GENERATED', 'FINALIZED', 'FAILED') NOT NULL DEFAULT 'GENERATING';

-- AlterTable
ALTER TABLE `drafts` MODIFY `status` ENUM('GENERATING', 'GENERATED', 'ACCEPTED', 'FAILED') NOT NULL DEFAULT 'GENERATING',
    MODIFY `fail_reason` ENUM('GENERATION_FAILED', 'REVISION_FAILED', 'INVALID_RESPONSE', 'TIMEOUT') NULL;

-- CreateTable
CREATE TABLE `conversation_messages` (
    `conversation_message_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `conversation_id` BIGINT UNSIGNED NOT NULL,
    `sequence` INTEGER UNSIGNED NOT NULL,
    `role` ENUM('USER', 'ASSISTANT') NOT NULL,
    `content` MEDIUMTEXT NOT NULL,
    `source_message_id` VARCHAR(100) NOT NULL,

    UNIQUE INDEX `uk_conversation_messages_sequence`(`conversation_id`, `sequence`),
    PRIMARY KEY (`conversation_message_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `idx_conversations_capture` ON `conversations`(`user_id`, `capture_id`);

-- AddForeignKey
ALTER TABLE `conversation_messages` ADD CONSTRAINT `fk_conversation_messages_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`conversation_id`) ON DELETE CASCADE ON UPDATE CASCADE;

