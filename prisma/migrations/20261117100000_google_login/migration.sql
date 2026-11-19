-- 2026-11-17 구글 로그인: 구글로만 가입한 회원은 비밀번호가 없어서 password NULL 허용, 구글 계정 고유 ID(sub) 저장
-- AlterTable
ALTER TABLE `users` ADD COLUMN `google_sub` VARCHAR(255) NULL,
    MODIFY `password` VARCHAR(255) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `uk_users_google_sub` ON `users`(`google_sub`);