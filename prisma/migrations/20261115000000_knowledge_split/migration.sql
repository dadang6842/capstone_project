-- 지식 분할 저장 (2026-11-15, AI v2 /v2/analyses)
-- 생성 요청 1번에서 지식 문서가 여러 편 나온다. 생성 요청은 generations, 고른 대화는 generation_conversations
-- documents.generation_id(같은 입력에서 나온 문서 묶음), drafts.ai_artifact_id·ai_detail(AI 문서 원본 정보)
-- conversation_messages.code_blocks(수집 모듈이 뽑은 코드 블록, AI-01 codeBlocks로 전달)
-- 기존 문서·초안·발화는 새 컬럼이 NULL이다 (이 마이그레이션 이후 생성·수집부터 채워짐)

-- AlterTable
ALTER TABLE `conversation_messages` ADD COLUMN `code_blocks` JSON NULL;

-- AlterTable
ALTER TABLE `documents` ADD COLUMN `generation_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `drafts` ADD COLUMN `ai_artifact_id` VARCHAR(64) NULL,
    ADD COLUMN `ai_detail` JSON NULL;

-- CreateTable
CREATE TABLE `generations` (
    `generation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NULL,
    `workspace_id` BIGINT UNSIGNED NULL,
    `retried_from_id` BIGINT UNSIGNED NULL,
    `status` ENUM('GENERATING', 'COMPLETED', 'NO_CONTENT', 'FAILED') NOT NULL DEFAULT 'GENERATING',
    `fail_reason` ENUM('GENERATION_FAILED', 'REVISION_FAILED', 'INVALID_RESPONSE', 'TIMEOUT') NULL,
    `error_message` VARCHAR(1000) NULL,
    `no_content_reason` VARCHAR(1000) NULL,
    `ai_run_id` VARCHAR(100) NULL,
    `review_status` ENUM('COMPLETED', 'INCOMPLETE', 'PENDING', 'NOT_APPLICABLE') NULL,
    `review_error` VARCHAR(1000) NULL,
    `document_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,

    INDEX `idx_generations_user`(`user_id`, `created_at`),
    INDEX `idx_generations_workspace`(`workspace_id`, `created_at`),
    INDEX `idx_generations_retried_from`(`retried_from_id`),
    INDEX `idx_generations_status`(`status`),
    INDEX `idx_generations_created`(`created_at`),
    PRIMARY KEY (`generation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `generation_conversations` (
    `generation_conversation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `generation_id` BIGINT UNSIGNED NOT NULL,
    `conversation_id` BIGINT UNSIGNED NOT NULL,

    INDEX `idx_generation_conversations_conversation`(`conversation_id`),
    UNIQUE INDEX `uk_generation_conversations`(`generation_id`, `conversation_id`),
    PRIMARY KEY (`generation_conversation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `idx_conversation_messages_source` ON `conversation_messages`(`conversation_id`, `source_message_id`);

-- CreateIndex
CREATE INDEX `idx_documents_generation` ON `documents`(`generation_id`);

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `fk_documents_generation` FOREIGN KEY (`generation_id`) REFERENCES `generations`(`generation_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generations` ADD CONSTRAINT `fk_generations_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generations` ADD CONSTRAINT `fk_generations_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`workspace_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generations` ADD CONSTRAINT `fk_generations_retried_from` FOREIGN KEY (`retried_from_id`) REFERENCES `generations`(`generation_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generation_conversations` ADD CONSTRAINT `fk_generation_conversations_generation` FOREIGN KEY (`generation_id`) REFERENCES `generations`(`generation_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generation_conversations` ADD CONSTRAINT `fk_generation_conversations_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`conversation_id`) ON DELETE CASCADE ON UPDATE CASCADE;