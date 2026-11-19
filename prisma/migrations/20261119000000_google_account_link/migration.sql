-- 2026-11-19 구글 계정 연동·해제: 연결한 구글 계정 정보와 연결 버전
-- AlterTable
ALTER TABLE `users` ADD COLUMN `google_email` VARCHAR(255) NULL,
    ADD COLUMN `google_link_version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN `google_linked_at` DATETIME(3) NULL,
    ADD COLUMN `google_name` VARCHAR(255) NULL;


-- 이미 구글로 가입·연결된 회원은 로그인 이메일과 마지막 수정 일시로 채운다 (11-17 구글 로그인 반영분)
UPDATE `users` SET `google_email` = `email`, `google_linked_at` = `updated_at`, `google_link_version` = 1 WHERE `google_sub` IS NOT NULL;