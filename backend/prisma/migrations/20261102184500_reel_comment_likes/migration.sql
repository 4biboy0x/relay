CREATE TABLE "ReelCommentLike" (
  "commentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReelCommentLike_pkey" PRIMARY KEY ("commentId", "userId")
);

CREATE INDEX "ReelCommentLike_userId_createdAt_idx"
  ON "ReelCommentLike" ("userId", "createdAt" DESC);

ALTER TABLE "ReelCommentLike"
  ADD CONSTRAINT "ReelCommentLike_commentId_fkey"
  FOREIGN KEY ("commentId") REFERENCES "ReelComment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReelCommentLike"
  ADD CONSTRAINT "ReelCommentLike_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
