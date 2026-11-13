-- 팀(공유) 워크스페이스 추가 (2026-11-12, 2026-11-13 초대 만료 삭제·팀 UUID 삭제): workspaces, workspace_members, workspace_invitations 생성
-- conversations·documents에 workspace_id(NULL = 개인 워크스페이스), documents.last_edited_by(최근 수정자), drafts.requested_by(회차 요청자) 추가
-- conversations·documents.user_id를 NULL 허용 + ON DELETE SET NULL로 바꿈: 회원이 영구 삭제돼도 팀 자료는 팀에 남게 (개인 자료는 탈퇴 처리에서 직접 지운다)
-- 기존 데이터는 모두 개인 워크스페이스 자료(workspace_id NULL)로 그대로 남는다

-- DropForeignKey
ALTER TABLE `conversations` DROP FOREIGN KEY `fk_conversations_user`;

-- DropForeignKey
ALTER TABLE `documents` DROP FOREIGN KEY `fk_documents_user`;

-- AlterTable
ALTER TABLE `conversations` ADD COLUMN `workspace_id` BIGINT UNSIGNED NULL,
    MODIFY `user_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `documents` ADD COLUMN `last_edited_by` BIGINT UNSIGNED NULL,
    ADD COLUMN `workspace_id` BIGINT UNSIGNED NULL,
    MODIFY `user_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `drafts` ADD COLUMN `requested_by` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `workspaces` (
    `workspace_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(60) NOT NULL,
    `description` VARCHAR(500) NOT NULL DEFAULT '',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    PRIMARY KEY (`workspace_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_members` (
    `workspace_member_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_workspace_members_user`(`user_id`),
    UNIQUE INDEX `uk_workspace_members`(`workspace_id`, `user_id`),
    PRIMARY KEY (`workspace_member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_invitations` (
    `workspace_invitation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `inviter_id` BIGINT UNSIGNED NULL,
    `invitee_id` BIGINT UNSIGNED NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELED') NOT NULL DEFAULT 'PENDING',
    `responded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_workspace_invitations_workspace`(`workspace_id`, `status`),
    INDEX `idx_workspace_invitations_invitee`(`invitee_id`, `status`),
    PRIMARY KEY (`workspace_invitation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `idx_conversations_workspace` ON `conversations`(`workspace_id`, `deleted_at`, `created_at`);

-- CreateIndex
CREATE INDEX `idx_documents_workspace` ON `documents`(`workspace_id`, `deleted_at`, `updated_at`);

-- AddForeignKey
ALTER TABLE `conversations` ADD CONSTRAINT `fk_conversations_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `conversations` ADD CONSTRAINT `fk_conversations_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`workspace_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `fk_documents_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `fk_documents_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`workspace_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `fk_documents_last_editor` FOREIGN KEY (`last_edited_by`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `drafts` ADD CONSTRAINT `fk_drafts_requester` FOREIGN KEY (`requested_by`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `fk_workspace_members_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`workspace_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `fk_workspace_members_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_invitations` ADD CONSTRAINT `fk_workspace_invitations_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`workspace_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_invitations` ADD CONSTRAINT `fk_workspace_invitations_inviter` FOREIGN KEY (`inviter_id`) REFERENCES `users`(`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_invitations` ADD CONSTRAINT `fk_workspace_invitations_invitee` FOREIGN KEY (`invitee_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;