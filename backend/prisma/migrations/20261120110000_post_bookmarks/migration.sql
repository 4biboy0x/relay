CREATE TABLE "PostBookmark" (
  "userId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostBookmark_userId_postId_key" UNIQUE ("userId", "postId"),
  CONSTRAINT "PostBookmark_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PostBookmark_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PostBookmark_userId_createdAt_postId_idx"
  ON "PostBookmark" ("userId", "createdAt" DESC, "postId" DESC);
