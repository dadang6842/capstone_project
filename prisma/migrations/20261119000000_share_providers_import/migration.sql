-- 2026-11-18 공유 링크 확장(ChatGPT /s/, Gemini, Claude)과 비공개 대화 가져오기(CONV-05)
-- 기존 대화는 모두 ChatGPT 공유 링크라 provider CHATGPT, source SHARE_LINK로 채워진다
ALTER TABLE `conversations`
    ADD COLUMN `provider` ENUM('CHATGPT', 'GEMINI', 'CLAUDE') NOT NULL DEFAULT 'CHATGPT' AFTER `workspace_id`,
    ADD COLUMN `source` ENUM('SHARE_LINK', 'PRIVATE_IMPORT') NOT NULL DEFAULT 'SHARE_LINK' AFTER `provider`,
    MODIFY `share_url` VARCHAR(2048) NULL,
    ADD COLUMN `resolved_url` VARCHAR(2048) NULL AFTER `share_url`,
    ADD COLUMN `external_conversation_id` VARCHAR(255) NULL AFTER `resolved_url`,
    ADD COLUMN `import_key` CHAR(64) NULL AFTER `capture_id`;

-- 기존 수집 완료 대화의 최종 주소는 입력 주소와 같다
UPDATE `conversations` SET `resolved_url` = `share_url` WHERE `status` = 'COLLECTED' AND `resolved_url` IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX `uk_conversations_import_key` ON `conversations`(`import_key`);