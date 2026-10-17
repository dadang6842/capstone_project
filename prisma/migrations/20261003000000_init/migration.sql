-- CreateTable
CREATE TABLE `users` (
    `user_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(100) NOT NULL,
    `password` VARCHAR(255) NOT NULL,
    `nickname` VARCHAR(8) NOT NULL,
    `role` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `uk_users_email`(`email`),
    INDEX `idx_users_created`(`created_at`),
    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `refresh_token_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token` VARCHAR(512) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uk_refresh_tokens_token`(`token`),
    INDEX `idx_refresh_tokens_user`(`user_id`),
    INDEX `idx_refresh_tokens_created`(`created_at`, `user_id`),
    PRIMARY KEY (`refresh_token_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `conversations` (
    `conversation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `filename` VARCHAR(255) NOT NULL,
    `content_type` VARCHAR(100) NULL,
    `file_size` BIGINT UNSIGNED NOT NULL,
    `s3_key` VARCHAR(512) NOT NULL,
    `refined_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_conversations_user`(`user_id`, `deleted_at`, `created_at`),
    PRIMARY KEY (`conversation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `documents` (
    `document_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(255) NULL,
    `content` LONGTEXT NULL,
    `summary` VARCHAR(512) NULL,
    `category` ENUM('IDEA_NOTE', 'CONCEPT_NOTE', 'LIST', 'MANUAL') NULL,
    `prompt` MEDIUMTEXT NULL,
    `status` ENUM('GENERATING', 'DRAFT_GENERATED', 'FINALIZED', 'FAILED', 'NOT_KNOWLEDGE') NOT NULL DEFAULT 'GENERATING',
    `finalized_at` DATETIME(3) NULL,
    `last_viewed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_documents_dashboard`(`user_id`, `deleted_at`, `updated_at`),
    INDEX `idx_documents_category`(`user_id`, `category`),
    INDEX `idx_documents_created`(`created_at`),
    INDEX `idx_documents_finalized`(`finalized_at`),
    FULLTEXT INDEX `ftx_documents_search`(`title`, `content`) WITH PARSER ngram,
    PRIMARY KEY (`document_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_conversations` (
    `document_conversation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `document_id` BIGINT UNSIGNED NOT NULL,
    `conversation_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_document_conversations_conversation`(`conversation_id`),
    UNIQUE INDEX `uk_document_conversations`(`document_id`, `conversation_id`),
    PRIMARY KEY (`document_conversation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_keywords` (
    `document_keyword_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `document_id` BIGINT UNSIGNED NOT NULL,
    `keyword` VARCHAR(50) NOT NULL,

    INDEX `idx_document_keywords_keyword`(`keyword`),
    UNIQUE INDEX `uk_document_keywords`(`document_id`, `keyword`),
    PRIMARY KEY (`document_keyword_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `drafts` (
    `draft_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `document_id` BIGINT UNSIGNED NOT NULL,
    `parent_draft_id` BIGINT UNSIGNED NULL,
    `version_no` INTEGER UNSIGNED NOT NULL,
    `title` VARCHAR(255) NULL,
    `content` LONGTEXT NULL,
    `summary` VARCHAR(512) NULL,
    `category` ENUM('IDEA_NOTE', 'CONCEPT_NOTE', 'LIST', 'MANUAL') NULL,
    `keywords` JSON NULL,
    `status` ENUM('GENERATING', 'GENERATED', 'ACCEPTED', 'FAILED', 'NOT_KNOWLEDGE') NOT NULL DEFAULT 'GENERATING',
    `fail_reason` ENUM('ANALYSIS_FAILED', 'GPT_FAILED', 'REVISION_FAILED', 'INVALID_RESPONSE', 'TIMEOUT') NULL,
    `error_message` VARCHAR(1000) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_drafts_version`(`document_id`, `version_no`),
    INDEX `idx_drafts_parent`(`parent_draft_id`),
    INDEX `idx_drafts_created`(`created_at`),
    PRIMARY KEY (`draft_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `draft_feedbacks` (
    `draft_feedback_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `draft_id` BIGINT UNSIGNED NOT NULL,
    `reason` ENUM('TOO_LONG', 'MISSING_CONTENT') NOT NULL,

    UNIQUE INDEX `uk_draft_feedbacks`(`draft_id`, `reason`),
    PRIMARY KEY (`draft_feedback_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `fk_refresh_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `conversations` ADD CONSTRAINT `fk_conversations_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `fk_documents_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_conversations` ADD CONSTRAINT `fk_document_conversations_document` FOREIGN KEY (`document_id`) REFERENCES `documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_conversations` ADD CONSTRAINT `fk_document_conversations_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`conversation_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_keywords` ADD CONSTRAINT `fk_document_keywords_document` FOREIGN KEY (`document_id`) REFERENCES `documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `drafts` ADD CONSTRAINT `fk_drafts_document` FOREIGN KEY (`document_id`) REFERENCES `documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `drafts` ADD CONSTRAINT `fk_drafts_parent` FOREIGN KEY (`parent_draft_id`) REFERENCES `drafts`(`draft_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `draft_feedbacks` ADD CONSTRAINT `fk_draft_feedbacks_draft` FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`draft_id`) ON DELETE CASCADE ON UPDATE CASCADE;
