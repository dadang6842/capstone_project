-- 2026-11-19 20261119061811에서 실수로 지운 구글 계정 연동 컬럼 복구
ALTER TABLE `users` ADD COLUMN `google_email` VARCHAR(255) NULL,
    ADD COLUMN `google_link_version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN `google_linked_at` DATETIME(3) NULL,
    ADD COLUMN `google_name` VARCHAR(255) NULL;

-- 이미 구글로 가입·연결된 회원은 로그인 이메일과 마지막 수정 일시로 채운다
UPDATE `users` SET `google_email` = `email`, `google_linked_at` = `updated_at`, `google_link_version` = 1 WHERE `google_sub` IS NOT NULL;