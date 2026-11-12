ALTER TABLE "Post"
ADD COLUMN "views" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PostView" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostView_userId_postId_sessionId_key"
ON "PostView"("userId", "postId", "sessionId");

CREATE INDEX "PostView_postId_createdAt_idx"
ON "PostView"("postId", "createdAt" DESC);

ALTER TABLE "PostView"
ADD CONSTRAINT "PostView_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostView"
ADD CONSTRAINT "PostView_postId_fkey"
FOREIGN KEY ("postId") REFERENCES "Post"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
