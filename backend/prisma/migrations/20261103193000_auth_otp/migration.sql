-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ;

-- CreateEnum
CREATE TYPE "AuthCodePurpose" AS ENUM ('signup', 'reset');

-- CreateTable
CREATE TABLE "AuthCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" VARCHAR(254) NOT NULL,
    "purpose" "AuthCodePurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthCode_email_purpose_createdAt_idx"
    ON "AuthCode"("email", "purpose", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuthCode_userId_purpose_createdAt_idx"
    ON "AuthCode"("userId", "purpose", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AuthCode"
    ADD CONSTRAINT "AuthCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
