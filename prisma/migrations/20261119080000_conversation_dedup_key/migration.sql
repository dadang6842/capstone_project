-- 2026-11-19 대화 중복 검사 규칙 통일 (공유 링크·비공개 가져오기 공통: 같은 공간 + 같은 AI 서비스 + 같은 발화)
-- import_key(비공개 가져오기 전용)를 dedup_key(공통)로 바꾸고, 공유 링크 DUPLICATED에 기존 대화 아이디를 남긴다
ALTER TABLE `conversations` RENAME COLUMN `import_key` TO `dedup_key`;
ALTER TABLE `conversations` RENAME INDEX `uk_conversations_import_key` TO `uk_conversations_dedup_key`;
ALTER TABLE `conversations` ADD COLUMN `duplicate_of_id` BIGINT UNSIGNED NULL AFTER `collect_fail_reason`;

-- 예전 import_key는 계산 방식이 달라서 비운다. 서버가 켜질 때 수집 완료 대화 전체의 dedup_key를 새 방식으로 채운다
UPDATE `conversations` SET `dedup_key` = NULL;