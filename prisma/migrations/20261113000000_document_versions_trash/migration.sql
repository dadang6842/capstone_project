-- 휴지통·저장 이력 다시 추가 (2026-11-13 다현 결정)
-- documents.deleted_by(휴지통으로 옮긴 회원), document_versions(초안 회차의 AI 원본·직접 저장·복원, 채택 뒤 지식 문서의 최초 채택·직접 저장·복원)
-- 기존 초안·문서에는 이력 행이 없다 (이 마이그레이션 이후 저장부터 쌓임)

-- AlterTable
ALTER TABLE `documents` ADD COLUMN `deleted_by` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `document_versions` (
    `document_version_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `document_id` BIGINT UNSIGNED NOT NULL,
    `draft_id` BIGINT UNSIGNED NULL,
    `version_no` INTEGER UNSIGNED NOT NULL,
    `source` ENUM('AI_GENERATED', 'MANUAL_SAVE', 'RESTORE', 'ACCEPTED') NOT NULL,
    `restored_from_id` BIGINT UNSIGNED NULL,
    `title` VARCHAR(255) NULL,
    `content` LONGTEXT NULL,
    `summary` VARCHAR(512) NULL,
    `category` ENUM('IDEA_NOTE', 'CONCEPT_NOTE', 'LIST', 'MANUAL') NULL,
    `keywords` JSON NULL,
    `saved_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_document_versions_history`(`document_id`, `draft_id`, `version_no`),
    INDEX `idx_document_versions_draft`(`draft_id`),
    PRIMARY KEY (`document_version_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `fk_documents_deleter` FOREIGN KEY (`deleted_by`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_versions` ADD CONSTRAINT `fk_document_versions_document` FOREIGN KEY (`document_id`) REFERENCES `documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_versions` ADD CONSTRAINT `fk_document_versions_draft` FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`draft_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_versions` ADD CONSTRAINT `fk_document_versions_restored_from` FOREIGN KEY (`restored_from_id`) REFERENCES `document_versions`(`document_version_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_versions` ADD CONSTRAINT `fk_document_versions_saver` FOREIGN KEY (`saved_by`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;