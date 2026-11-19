/*
  Warnings:

  - You are about to drop the column `google_email` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `google_link_version` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `google_linked_at` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `google_name` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `users` DROP COLUMN `google_email`,
    DROP COLUMN `google_link_version`,
    DROP COLUMN `google_linked_at`,
    DROP COLUMN `google_name`;
